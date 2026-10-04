import type { Types } from "mongoose";
import Product, { type ProductDocument } from "../models/Product";
import Combo, { type ComboDocument } from "../models/Combo";
import Cart, { type CartDocument } from "../models/Cart";
import CartItem, { type CartItemDocument, type ProductSnapshot, type ComboSnapshot } from "../models/CartItem";
import AppError from "./AppError";
import { getVisibleCategoryIds } from "./categoryTree";
import { getAvailability, getFinalPrice } from "./productView";
import { PRE_ORDER } from "../config/orderOptions";
import { isNonEmptyString, normalizeBdPhone } from "./validators";
import {
  PAYMENT_METHODS,
  FULFILLMENT_METHODS,
  ADMIN_DISCOUNT_TYPES,
  isPaymentMethod,
  isFulfillmentMethod,
  isAdminDiscountType,
  type PaymentMethod,
  type FulfillmentMethod,
  type AdminDiscountType,
} from "../config/orderOptions";
import { getShippingConfig, calculateShippingCharge } from "./shipping";
import type { Size } from "../config/productOptions";
import { evaluateCoupon, type AppliedCoupon } from "./coupons";

export const roundMoney = (n: number): number => Math.round(n * 100) / 100;

export const getOrCreateCart = async (customerId: Types.ObjectId): Promise<CartDocument> => {
  const cart = await Cart.findOneAndUpdate(
    { customerId },
    { $setOnInsert: { customerId } },
    { upsert: true, returnDocument: "after" }
  );
  if (!cart) throw new AppError("Cart could not be loaded", 500);
  return cart;
};

// Size/unit the customer picked must match what the product offers
export const resolveSelection = (
  product: ProductDocument,
  size: unknown,
  unit: unknown
): { selectedSize: string | null; selectedUnit: string | null } => {
  let selectedSize: string | null = null;
  if (product.sizes && product.sizes.length > 0) {
    if (!isNonEmptyString(size)) throw new AppError("Please select a size", 400);
    selectedSize = size.trim().toUpperCase();
    if (!product.sizes.includes(selectedSize as Size)) {
      throw new AppError(`Invalid size. Available: ${product.sizes.join(", ")}`, 400);
    }
  } else if (size !== undefined && size !== null && size !== "") {
    throw new AppError("This product has no size options", 400);
  }

  let selectedUnit: string | null = null;
  if (product.unit) {
    if (unit !== undefined && unit !== null && unit !== "") {
      if (typeof unit !== "string" || unit.trim().toLowerCase() !== product.unit.toLowerCase()) {
        throw new AppError(`Invalid unit. This product is sold in ${product.unit}`, 400);
      }
    }
    selectedUnit = product.unit;
  } else if (unit !== undefined && unit !== null && unit !== "") {
    throw new AppError("This product has no unit options", 400);
  }

  return { selectedSize, selectedUnit };
};

// Product can be bought: exists, ACTIVE, category (and parents) ACTIVE
export function assertPurchasable(
  product: ProductDocument | null | undefined,
  visibleCategoryIds: Set<string>
): asserts product is ProductDocument {
  if (!product || product.status !== "ACTIVE" || !visibleCategoryIds.has(String(product.categoryId))) {
    throw new AppError("Product is not available", 400);
  }
}

export const productSnapshot = (product: ProductDocument): ProductSnapshot => ({
  productTitle: product.productTitle,
  slug: product.slug,
  thumbnail: product.thumbnail,
  customerSellPrice: product.customerSellPrice,
  customerSpecialPrice: product.customerSpecialPrice,
});

export const comboSnapshotFromDoc = (
  combo: ComboDocument,
  members: Map<string, ProductDocument>
): ComboSnapshot => ({
  comboTitle: combo.comboTitle,
  slug: combo.slug,
  thumbnail: combo.thumbnail,
  comboPrice: combo.comboPrice,
  items: combo.items.map((item) => {
    const product = members.get(String(item.productId));
    const unitPrice = product ? getFinalPrice(product) : 0;
    return {
      productId: item.productId,
      productTitle: product?.productTitle ?? "",
      quantity: item.quantity,
      unitPrice,
    };
  }),
});

// Combo is available: ACTIVE, inside campaign window, all member products
// in stock for the requested quantity and still ACTIVE/visible.
const assertComboPurchasable = async (
  combo: ComboDocument | null | undefined,
  quantity: number,
  visibleCategoryIds: Set<string>
): Promise<Map<string, ProductDocument>> => {
  if (!combo || combo.status !== "ACTIVE") throw new AppError("Combo is not available", 400);
  const now = new Date();
  if (combo.startsAt && combo.startsAt > now) throw new AppError("Combo is not available yet", 400);
  if (combo.endsAt && combo.endsAt <= now) throw new AppError("Combo has ended", 400);

  const members = await Product.find({ _id: { $in: combo.items.map((i) => i.productId) } });
  const byId = new Map(members.map((p) => [String(p._id), p]));
  for (const item of combo.items) {
    const product = byId.get(String(item.productId));
    if (!product) throw new AppError("A product in this combo is no longer available", 400);
    if (product.status !== "ACTIVE" || !visibleCategoryIds.has(String(product.categoryId))) {
      throw new AppError("A product in this combo is no longer available", 400);
    }
    if (product.stock < item.quantity * quantity) {
      throw new AppError("Insufficient stock for a combo item", 400);
    }
  }
  return byId;
};

export interface CartLine {
  item: CartItemDocument;
  product?: ProductDocument;
  combo?: ComboDocument;
  comboMembers?: Map<string, ProductDocument>;
  issue: string | null;
}

// Load the cart with live product/combo data and refresh prices. Items with
// problems get an "issue" (shown to the customer, kept out of coupon/subtotal).
export const loadCart = async (customerId: Types.ObjectId): Promise<{ cart: CartDocument; lines: CartLine[] }> => {
  const cart = await getOrCreateCart(customerId);
  const items = await CartItem.find({ cartId: cart._id }).sort({ createdAt: 1 });

  const productIds = items.filter((i) => i.productId).map((i) => i.productId as Types.ObjectId);
  const comboIds = items.filter((i) => i.comboId).map((i) => i.comboId as Types.ObjectId);
  const [products, combos] = await Promise.all([
    productIds.length ? Product.find({ _id: { $in: productIds } }) : Promise.resolve([]),
    comboIds.length ? Combo.find({ _id: { $in: comboIds } }) : Promise.resolve([]),
  ]);
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const comboById = new Map(combos.map((c) => [String(c._id), c]));

  // Load every member product used by any combo in the cart (dedup by id)
  const memberIds = new Set<string>();
  for (const combo of combos) for (const item of combo.items) memberIds.add(String(item.productId));
  const memberProducts = memberIds.size
    ? await Product.find({ _id: { $in: [...memberIds] } })
    : [];
  const memberById = new Map(memberProducts.map((p) => [String(p._id), p]));

  const visible = new Set((await getVisibleCategoryIds()).map(String));

  // Aggregate per-product requested quantity across product lines AND combo member usage
  const requested = new Map<string, number>();
  for (const item of items) {
    if (item.productId) {
      const id = String(item.productId);
      requested.set(id, (requested.get(id) || 0) + item.quantity);
    } else if (item.comboId) {
      const combo = comboById.get(String(item.comboId));
      if (!combo) continue;
      for (const member of combo.items) {
        const id = String(member.productId);
        requested.set(id, (requested.get(id) || 0) + member.quantity * item.quantity);
      }
    }
  }

  const lines: CartLine[] = [];
  for (const item of items) {
    let issue: string | null = null;
    let product: ProductDocument | undefined;
    let combo: ComboDocument | undefined;
    let comboMembers: Map<string, ProductDocument> | undefined;

    if (item.productId) {
      product = productById.get(String(item.productId));
      try {
        assertPurchasable(product, visible);
        resolveSelection(product, item.selectedSize || undefined, item.selectedUnit || undefined);
        // Pre-order products are always buyable: the admin fulfils them after the delivery window,
        // so stock does not block the sale and stock is not decremented at order time.
        if (!product.isPreOrder) {
          if (product.stock <= 0) issue = "Out of stock";
          else if ((requested.get(String(product._id)) || 0) > product.stock) issue = "Insufficient product stock";
        }
      } catch (error) {
        issue = (error as Error).message;
      }
      if (product) {
        const unitPrice = getFinalPrice(product);
        const subtotal = roundMoney(unitPrice * item.quantity);
        if (
          item.unitPrice !== unitPrice ||
          item.subtotal !== subtotal ||
          !item.productSnapshot ||
          item.productSnapshot.productTitle !== product.productTitle
        ) {
          item.unitPrice = unitPrice;
          item.subtotal = subtotal;
          item.productSnapshot = productSnapshot(product);
          await item.save();
        }
      }
    } else if (item.comboId) {
      combo = comboById.get(String(item.comboId));
      try {
        comboMembers = await assertComboPurchasable(combo, item.quantity, visible);
        // Check aggregate consumption of combo member stock
        if (combo) {
          for (const memberLine of combo.items) {
            const memberProduct = memberById.get(String(memberLine.productId));
            if (memberProduct && (requested.get(String(memberProduct._id)) || 0) > memberProduct.stock) {
              throw new AppError("Insufficient stock for a combo item", 400);
            }
          }
        }
      } catch (error) {
        issue = (error as Error).message;
      }
      if (combo) {
        comboMembers = comboMembers || new Map(memberProducts.map((p) => [String(p._id), p]));
        const unitPrice = combo.comboPrice;
        const subtotal = roundMoney(unitPrice * item.quantity);
        const snapshot = comboSnapshotFromDoc(combo, comboMembers);
        if (
          item.unitPrice !== unitPrice ||
          item.subtotal !== subtotal ||
          !item.comboSnapshot ||
          item.comboSnapshot.comboTitle !== combo.comboTitle
        ) {
          item.unitPrice = unitPrice;
          item.subtotal = subtotal;
          item.comboSnapshot = snapshot;
          await item.save();
        }
      }
    } else {
      issue = "Invalid cart item";
    }

    lines.push({ item, product, combo, comboMembers, issue });
  }
  return { cart, lines };
};

export const toCartResponse = (cart: CartDocument, lines: CartLine[]) => {
  const items = lines.map(({ item, product, combo, issue }) => {
    const base = {
      _id: item._id,
      cartId: item.cartId,
      quantity: item.quantity,
      selectedSize: item.selectedSize,
      selectedUnit: item.selectedUnit,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      isAvailable: !issue,
      issue,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
    if (item.productId) {
      return {
        ...base,
        type: "product" as const,
        productId: item.productId,
        comboId: null,
        productSnapshot: item.productSnapshot,
        comboSnapshot: null,
        availability: product ? getAvailability(product.stock) : "OUT_OF_STOCK",
      };
    }
    return {
      ...base,
      type: "combo" as const,
      productId: null,
      comboId: item.comboId,
      productSnapshot: null,
      comboSnapshot: item.comboSnapshot,
      availability: combo ? "IN_STOCK" : "OUT_OF_STOCK",
    };
  });
  const available = items.filter((i) => i.isAvailable);
  return {
    _id: cart._id,
    customerId: cart.customerId,
    items,
    itemCount: items.length,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotal: roundMoney(available.reduce((sum, i) => sum + i.subtotal, 0)),
    hasIssues: items.some((i) => !i.isAvailable),
  };
};

export interface ShippingInfo {
  customerName: string;
  phoneNumber: string;
  email: string | null;
  shippingAddress: string;
  city: string;
  area: string;
  orderNotes: string;
  paymentMethod: PaymentMethod;
  fulfillmentMethod: FulfillmentMethod;
}

// Admin-only manual discount request. The *amount* in money is computed by the
// backend from `eligibleSubtotal`; the *value* is what the admin typed.
export interface AdminDiscountInput {
  type: AdminDiscountType;
  value: number;
}

export interface AdminDiscountResult {
  type: AdminDiscountType;
  value: number;
  amount: number;
  eligibleSubtotal: number;
}

export const parseAdminDiscountInput = (body: Record<string, unknown> = {}): AdminDiscountInput | null => {
  const type = body.adminDiscountType;
  const rawValue = body.adminDiscountValue;
  const hasType = type !== undefined && type !== null && type !== "";
  const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== "";
  if (!hasType && !hasValue) return null;
  if (!isAdminDiscountType(type)) {
    throw new AppError(`adminDiscountType must be one of: ${ADMIN_DISCOUNT_TYPES.join(", ")}`, 400);
  }
  const value = typeof rawValue === "string" ? Number(rawValue) : rawValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AppError("adminDiscountValue must be a non-negative number", 400);
  }
  if (type === "PERCENTAGE" && value > 100) {
    throw new AppError("Percentage discount cannot be more than 100", 400);
  }
  if (value === 0) return null;
  return { type, value: roundMoney(value) };
};

// Resolve the actual taka taken off this order from an admin-discount request.
// The eligible subtotal is the order amount *after* the coupon (so admin + coupon
// never double-count, and the result can never make the total go negative).
export const calculateAdminDiscount = (
  input: AdminDiscountInput,
  eligibleSubtotal: number
): AdminDiscountResult => {
  const base = Math.max(0, roundMoney(eligibleSubtotal));
  let amount: number;
  if (input.type === "PERCENTAGE") {
    amount = roundMoney((base * input.value) / 100);
  } else {
    amount = roundMoney(input.value);
  }
  amount = Math.min(amount, base);
  if (amount < 0) amount = 0;
  return { type: input.type, value: input.value, amount, eligibleSubtotal: base };
};

// Validate checkout form. Only these fields are read (postal code is not part of the system).
const EMAIL_REGEX = /^\S+@\S+\.\S+$/;

export const parseShippingInfo = (body: Record<string, unknown> = {}): ShippingInfo => {
  const text = (value: unknown, label: string, { required, max }: { required: boolean; max: number }): string => {
    if (value === undefined || value === null || value === "") {
      if (required) throw new AppError(`${label} is required`, 400);
      return "";
    }
    if (typeof value !== "string" || (required && !value.trim())) {
      throw new AppError(`${label} is required`, 400);
    }
    if (value.trim().length > max) throw new AppError(`${label} cannot exceed ${max} characters`, 400);
    return value.trim();
  };

  const customerName = text(body.customerName, "Customer name", { required: true, max: 100 });
  const phoneNumber = normalizeBdPhone(text(body.phoneNumber, "Phone number", { required: true, max: 20 }));
  if (!phoneNumber) throw new AppError("Please provide a valid Bangladeshi phone number (e.g. 01712345678)", 400);

  const email = text(body.email, "Email", { required: false, max: 100 });
  if (email && !EMAIL_REGEX.test(email)) throw new AppError("Please provide a valid email", 400);

  const shippingAddress = text(body.shippingAddress, "Shipping address", { required: true, max: 300 });
  const city = text(body.city, "City", { required: true, max: 60 });
  const area = text(body.area, "Area", { required: true, max: 60 });
  const orderNotes = text(body.orderNotes, "Order notes", { required: false, max: 500 });

  if (!isPaymentMethod(body.paymentMethod)) {
    throw new AppError(`Payment method is required. Allowed: ${PAYMENT_METHODS.join(", ")}`, 400);
  }

  // Default to DELIVERY so existing clients keep working; STORE_PICKUP waives the delivery charge.
  const fulfillmentRaw = body.fulfillmentMethod;
  const fulfillmentMethod: FulfillmentMethod =
    fulfillmentRaw === undefined || fulfillmentRaw === null || fulfillmentRaw === ""
      ? "DELIVERY"
      : isFulfillmentMethod(fulfillmentRaw)
      ? fulfillmentRaw
      : (() => {
          throw new AppError(`fulfillmentMethod must be one of: ${FULFILLMENT_METHODS.join(", ")}`, 400);
        })();

  return {
    customerName,
    phoneNumber,
    email: email ? email.toLowerCase() : null,
    shippingAddress,
    city,
    area,
    orderNotes,
    paymentMethod: body.paymentMethod,
    fulfillmentMethod,
  };
};

export interface DraftItem {
  productId: Types.ObjectId | null;
  comboId: Types.ObjectId | null;
  productTitleSnapshot: string;
  thumbnailSnapshot: string;
  quantity: number;
  selectedSize: string | null;
  selectedUnit: string | null;
  unitPrice: number;
  subtotal: number;
  // Set only on pre-order product lines, so the order controller knows to skip stock decrement.
  isPreOrder?: boolean;
  comboItemsSnapshot: {
    productId: Types.ObjectId;
    productTitle: string;
    quantity: number;
    unitPrice: number;
  }[];
}

export interface OrderDraft {
  cart: CartDocument;
  cartItemIds: Types.ObjectId[];
  items: DraftItem[];
  // Combo lines needed again at order-create time for stock decrement
  comboLines: { comboId: Types.ObjectId; quantity: number }[];
  subtotal: number;
  discount: number;
  coupon: AppliedCoupon | null;
  // Non-null only when the request carried a valid admin-discount AND the caller was authorized to use it.
  adminDiscount: AdminDiscountResult | null;
  shippingCost: number;
  totalAmount: number;
  shippingInfo: ShippingInfo;
  // Pre-order snapshot. isPreOrder = any product line is a pre-order product;
  // preOrderMinDays = the longest window across those products (so the slowest line sets the promise).
  isPreOrder: boolean;
  preOrderMinDays: number;
  expectedDeliveryDate: Date | null;
}

export interface BuildOrderDraftOptions {
  couponCode?: string | null;
  // Only pass this when the authenticated user has orders.adminDiscount. The order controller
  // enforces that, so this utility can trust the input and just compute the amount.
  adminDiscount?: AdminDiscountInput | null;
}

// Validate the whole cart for checkout and calculate totals (prices from the database only)
export const buildOrderDraft = async (
  customerId: Types.ObjectId,
  shippingInfo: ShippingInfo,
  options: BuildOrderDraftOptions = {}
): Promise<OrderDraft> => {
  const couponCode = options.couponCode ?? null;
  const adminDiscountInput = options.adminDiscount ?? null;
  const { cart, lines } = await loadCart(customerId);
  if (lines.length === 0) throw new AppError("Your cart is empty", 400);

  const problem = lines.find((l) => l.issue);
  if (problem) {
    const title = problem.product
      ? problem.product.productTitle
      : problem.combo
      ? problem.combo.comboTitle
      : problem.item.productSnapshot?.productTitle || problem.item.comboSnapshot?.comboTitle || "Item";
    const message = problem.issue === "Out of stock" ? "Insufficient product stock" : problem.issue;
    throw new AppError(`${message}: ${title}`, 400);
  }

  const items: DraftItem[] = lines.map(({ item, product, combo, comboMembers }) => {
    if (product) {
      const unitPrice = getFinalPrice(product);
      return {
        productId: product._id,
        comboId: null,
        productTitleSnapshot: product.productTitle,
        thumbnailSnapshot: product.thumbnail,
        quantity: item.quantity,
        selectedSize: item.selectedSize,
        selectedUnit: item.selectedUnit,
        unitPrice,
        subtotal: roundMoney(unitPrice * item.quantity),
        isPreOrder: product.isPreOrder,
        comboItemsSnapshot: [],
      };
    }
    // Combo line (combo always set here because loadCart's issue check passed)
    const c = combo as ComboDocument;
    const members = comboMembers || new Map<string, ProductDocument>();
    const unitPrice = c.comboPrice;
    return {
      productId: null,
      comboId: c._id,
      productTitleSnapshot: c.comboTitle,
      thumbnailSnapshot: c.thumbnail,
      quantity: item.quantity,
      selectedSize: null,
      selectedUnit: null,
      unitPrice,
      subtotal: roundMoney(unitPrice * item.quantity),
      comboItemsSnapshot: c.items.map((m) => {
        const memberProduct = members.get(String(m.productId));
        return {
          productId: m.productId,
          productTitle: memberProduct?.productTitle ?? "",
          quantity: m.quantity,
          unitPrice: memberProduct ? getFinalPrice(memberProduct) : 0,
        };
      }),
    };
  });

  const subtotal = roundMoney(items.reduce((sum, i) => sum + i.subtotal, 0));

  // Coupon applies to product lines only; combo lines are excluded (combos already carry their own savings)
  const couponLines = lines
    .filter(({ item, product }) => item.productId && product)
    .map(({ item, product }) => ({
      productId: item.productId as Types.ObjectId,
      categoryId: (product as ProductDocument).categoryId,
      subtotal: item.subtotal,
    }));
  const productSubtotal = roundMoney(couponLines.reduce((sum, l) => sum + l.subtotal, 0));
  const coupon = couponCode
    ? await evaluateCoupon(couponCode, customerId, couponLines, productSubtotal)
    : null;
  const discount = coupon ? coupon.discount : 0;

  // Admin discount applies after the coupon so the two never double-count. The
  // utility already clamped to the eligible amount, so the final total stays >= 0.
  const eligibleForAdminDiscount = Math.max(0, roundMoney(subtotal - discount));
  const adminDiscount = adminDiscountInput
    ? calculateAdminDiscount(adminDiscountInput, eligibleForAdminDiscount)
    : null;
  const adminDiscountAmount = adminDiscount ? adminDiscount.amount : 0;

  // Store pickup: never charge shipping. Delivery: existing per-city rules on the
  // amount after the coupon (admin discount does not change the shipping tier).
  const shippingCost =
    shippingInfo.fulfillmentMethod === "STORE_PICKUP"
      ? 0
      : calculateShippingCharge(await getShippingConfig(), shippingInfo.city, subtotal - discount);
  const totalAmount = roundMoney(Math.max(0, subtotal - discount - adminDiscountAmount + shippingCost));

  const cartItemIds = lines.map(({ item }) => item._id);
  const comboLines = lines
    .filter((l) => l.combo)
    .map((l) => ({ comboId: (l.combo as ComboDocument)._id, quantity: l.item.quantity }));

  // Pre-order aggregation: an order is pre-order when ANY product line is a pre-order product.
  // Its promised delivery window is the longest among those lines, so the slowest item sets the ETA.
  const preOrderProducts = lines
    .map((l) => l.product)
    .filter((p): p is ProductDocument => Boolean(p?.isPreOrder));
  const isPreOrder = preOrderProducts.length > 0;
  const preOrderMinDays = isPreOrder
    ? Math.max(
        ...preOrderProducts.map((p) => Math.max(p.preOrderMinDays || 0, PRE_ORDER.MIN_DELIVERY_DAYS))
      )
    : 0;
  const expectedDeliveryDate = isPreOrder
    ? new Date(Date.now() + preOrderMinDays * 24 * 60 * 60 * 1000)
    : null;

  return {
    cart,
    cartItemIds,
    items,
    comboLines,
    subtotal,
    discount,
    coupon,
    adminDiscount,
    shippingCost,
    totalAmount,
    shippingInfo,
    isPreOrder,
    preOrderMinDays,
    expectedDeliveryDate,
  };
};
