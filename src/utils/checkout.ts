import type { Types } from "mongoose";
import Product, { type ProductDocument } from "../models/Product";
import Cart, { type CartDocument } from "../models/Cart";
import CartItem, { type CartItemDocument, type ProductSnapshot } from "../models/CartItem";
import AppError from "./AppError";
import { getVisibleCategoryIds } from "./categoryTree";
import { getAvailability, getFinalPrice } from "./productView";
import { quantitiesByProduct } from "./inventory";
import { isNonEmptyString, normalizeBdPhone } from "./validators";
import { PAYMENT_METHODS, SHIPPING, isPaymentMethod, type PaymentMethod } from "../config/orderOptions";
import type { Size } from "../config/productOptions";

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

// Shipping cost from the city (Dhaka vs outside). Free above FREE_SHIPPING_MIN if set.
export const calculateShipping = (city: string, subtotal: number): number => {
  if (SHIPPING.FREE_SHIPPING_MIN > 0 && subtotal >= SHIPPING.FREE_SHIPPING_MIN) return 0;
  const isDhaka = SHIPPING.DHAKA_CITIES.includes(String(city).trim().toLowerCase());
  return isDhaka ? SHIPPING.INSIDE_DHAKA : SHIPPING.OUTSIDE_DHAKA;
};

export interface CartLine {
  item: CartItemDocument;
  product: ProductDocument | undefined;
  issue: string | null;
}

// Load the cart with live product data and refresh prices. Items with problems get an "issue".
export const loadCart = async (customerId: Types.ObjectId): Promise<{ cart: CartDocument; lines: CartLine[] }> => {
  const cart = await getOrCreateCart(customerId);
  const items = await CartItem.find({ cartId: cart._id }).sort({ createdAt: 1 });
  const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } });
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const visible = new Set((await getVisibleCategoryIds()).map(String));
  const requested = quantitiesByProduct(items);

  const lines: CartLine[] = [];
  for (const item of items) {
    const product = productById.get(String(item.productId));
    let issue: string | null = null;
    try {
      assertPurchasable(product, visible);
      resolveSelection(product, item.selectedSize || undefined, item.selectedUnit || undefined);
      if (product.stock <= 0) issue = "Out of stock";
      else if ((requested.get(String(product._id)) || 0) > product.stock) issue = "Insufficient product stock";
    } catch (error) {
      issue = (error as Error).message;
    }

    // Keep stored price/snapshot in sync with the live product
    if (product) {
      const unitPrice = getFinalPrice(product);
      const subtotal = roundMoney(unitPrice * item.quantity);
      if (item.unitPrice !== unitPrice || item.subtotal !== subtotal || item.productSnapshot.productTitle !== product.productTitle) {
        item.unitPrice = unitPrice;
        item.subtotal = subtotal;
        item.productSnapshot = productSnapshot(product);
        await item.save();
      }
    }

    lines.push({ item, product, issue });
  }
  return { cart, lines };
};

export const toCartResponse = (cart: CartDocument, lines: CartLine[]) => {
  const items = lines.map(({ item, product, issue }) => ({
    _id: item._id,
    cartId: item.cartId,
    productId: item.productId,
    quantity: item.quantity,
    selectedSize: item.selectedSize,
    selectedUnit: item.selectedUnit,
    unitPrice: item.unitPrice,
    subtotal: item.subtotal,
    productSnapshot: item.productSnapshot,
    availability: product ? getAvailability(product.stock) : "OUT_OF_STOCK",
    isAvailable: !issue,
    issue,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
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
}

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

  return {
    customerName,
    phoneNumber,
    email: email ? email.toLowerCase() : null,
    shippingAddress,
    city,
    area,
    orderNotes,
    paymentMethod: body.paymentMethod,
  };
};

export interface DraftItem {
  productId: Types.ObjectId;
  productTitleSnapshot: string;
  thumbnailSnapshot: string;
  quantity: number;
  selectedSize: string | null;
  selectedUnit: string | null;
  unitPrice: number;
  subtotal: number;
}

export interface OrderDraft {
  cart: CartDocument;
  cartItemIds: Types.ObjectId[];
  items: DraftItem[];
  subtotal: number;
  discount: number;
  shippingCost: number;
  totalAmount: number;
  shippingInfo: ShippingInfo;
}

// Validate the whole cart for checkout and calculate totals (prices from the database only)
export const buildOrderDraft = async (customerId: Types.ObjectId, shippingInfo: ShippingInfo): Promise<OrderDraft> => {
  const { cart, lines } = await loadCart(customerId);
  if (lines.length === 0) throw new AppError("Your cart is empty", 400);

  const problem = lines.find((l) => l.issue);
  if (problem) {
    const title = problem.product ? problem.product.productTitle : problem.item.productSnapshot.productTitle;
    const message = problem.issue === "Out of stock" ? "Insufficient product stock" : problem.issue;
    throw new AppError(`${message}: ${title}`, 400);
  }

  const items: DraftItem[] = lines.map(({ item, product }) => {
    // Lines without an issue always have a product
    const p = product as ProductDocument;
    return {
      productId: p._id,
      productTitleSnapshot: p.productTitle,
      thumbnailSnapshot: p.thumbnail,
      quantity: item.quantity,
      selectedSize: item.selectedSize,
      selectedUnit: item.selectedUnit,
      unitPrice: getFinalPrice(p),
      subtotal: roundMoney(getFinalPrice(p) * item.quantity),
    };
  });

  const subtotal = roundMoney(items.reduce((sum, i) => sum + i.subtotal, 0));
  const discount = 0; // coupons will set this later
  const shippingCost = calculateShipping(shippingInfo.city, subtotal - discount);
  const totalAmount = roundMoney(subtotal - discount + shippingCost);

  const cartItemIds = lines.map(({ item }) => item._id);
  return { cart, cartItemIds, items, subtotal, discount, shippingCost, totalAmount, shippingInfo };
};
