import type { Types } from "mongoose";
import User from "../models/User";
import Role from "../models/Role";
import Product, { type ProductDocument } from "../models/Product";
import Combo, { type ComboDocument } from "../models/Combo";
import AppError from "./AppError";
import { ROLES } from "../config/permissions";
import { assertObjectId, normalizeBdPhone } from "./validators";
import { getVisibleCategoryIds } from "./categoryTree";
import { isComboLive } from "./combos";
import { getFinalPrice } from "./productView";
import {
  availableOf,
} from "./inventory";
import {
  roundMoney,
  resolveSelection,
  parseShippingInfo,
  parseAdminDiscountInput,
  calculateAdminDiscount,
  type ShippingInfo,
  type AdminDiscountInput,
  type AdminDiscountResult,
  type DraftItem,
} from "./checkout";
import { getShippingConfig, calculateShippingCharge } from "./shipping";
import { evaluateCoupon, normalizeCouponCode, type AppliedCoupon } from "./coupons";
import { PRE_ORDER, CART_LIMITS } from "../config/orderOptions";

// --------------------------------------------------------------------------
// Guest checkout: shoppers can place an order without ever logging in. They
// provide items + shipping info in one call; we find (or auto-create) a
// passive customer account by phone so the order is still linked to a user
// (which lets them later log in via OTP and see this order under "My Orders").
// --------------------------------------------------------------------------

// Find a customer account by phone, or create one with no password. The
// account is marked ACTIVE and uses the Customer role; the user can later
// claim it by logging in with the same phone number via OTP.
export const findOrCreateGuestCustomer = async (
  phoneNumber: string,
  fallback: { fullName: string; email?: string | null }
): Promise<{ _id: Types.ObjectId }> => {
  const normalized = normalizeBdPhone(phoneNumber);
  if (!normalized) throw new AppError("Please provide a valid Bangladeshi phone number (e.g. 01712345678)", 400);

  const existing = await User.findOne({ phoneNumber: normalized });
  if (existing) {
    // Refresh name/email on the stored customer only when they are missing,
    // so a logged-in customer's own profile is never overwritten by a guest flow.
    const update: Record<string, unknown> = {};
    if (!existing.fullName && fallback.fullName) update.fullName = fallback.fullName;
    if (!existing.email && fallback.email) update.email = fallback.email.toLowerCase();
    if (Object.keys(update).length) {
      await User.updateOne({ _id: existing._id }, { $set: update });
    }
    return { _id: existing._id };
  }

  const customerRole = await Role.findOne({ name: ROLES.CUSTOMER }).select("_id").lean();
  if (!customerRole) throw new AppError("Customer role is not configured", 500);

  const created = await User.create({
    fullName: fallback.fullName || "Guest",
    phoneNumber: normalized,
    email: fallback.email ? fallback.email.toLowerCase() : "",
    role: customerRole._id,
    status: "ACTIVE",
  });
  return { _id: created._id };
};

// --------------------------------------------------------------------------
// Direct items → order draft (no cart). Mirrors buildOrderDraft() but takes
// the items directly from the request body instead of reading from CartItem.
// --------------------------------------------------------------------------

export interface GuestItemInput {
  productId?: string;
  comboId?: string;
  quantity: number;
  size?: string;
  unit?: string;
}

export interface GuestOrderDraft {
  items: DraftItem[];
  comboLines: { comboId: Types.ObjectId; quantity: number }[];
  subtotal: number;
  discount: number;
  coupon: AppliedCoupon | null;
  adminDiscount: AdminDiscountResult | null;
  shippingCost: number;
  totalAmount: number;
  shippingInfo: ShippingInfo;
  isPreOrder: boolean;
  preOrderMinDays: number;
  expectedDeliveryDate: Date | null;
}

interface ParsedLine {
  productId?: string;
  comboId?: string;
  quantity: number;
  size?: string;
  unit?: string;
}

const parseItemsPayload = (raw: unknown): ParsedLine[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError("items must be a non-empty array", 400);
  }
  if (raw.length > CART_LIMITS.MAX_ITEMS) {
    throw new AppError(`You can place at most ${CART_LIMITS.MAX_ITEMS} different items in one order`, 400);
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") throw new AppError(`items[${i}] must be an object`, 400);
    const r = entry as Record<string, unknown>;
    const hasProduct = r.productId !== undefined && r.productId !== null && r.productId !== "";
    const hasCombo = r.comboId !== undefined && r.comboId !== null && r.comboId !== "";
    if (hasProduct === hasCombo) {
      throw new AppError(`items[${i}] must set either productId OR comboId`, 400);
    }
    if (hasProduct) assertObjectId(r.productId, `items[${i}].productId`);
    if (hasCombo) assertObjectId(r.comboId, `items[${i}].comboId`);
    const quantityRaw = typeof r.quantity === "string" ? Number(r.quantity) : r.quantity;
    if (typeof quantityRaw !== "number" || !Number.isInteger(quantityRaw) || quantityRaw < 1) {
      throw new AppError(`items[${i}].quantity must be a whole number of at least 1`, 400);
    }
    if (quantityRaw > CART_LIMITS.MAX_QUANTITY_PER_ITEM) {
      throw new AppError(`items[${i}].quantity exceeds the per-item maximum of ${CART_LIMITS.MAX_QUANTITY_PER_ITEM}`, 400);
    }
    return {
      productId: hasProduct ? String(r.productId) : undefined,
      comboId: hasCombo ? String(r.comboId) : undefined,
      quantity: quantityRaw,
      size: typeof r.size === "string" ? r.size : undefined,
      unit: typeof r.unit === "string" ? r.unit : undefined,
    };
  });
};

const assertComboMembersAvailable = async (
  combo: ComboDocument,
  quantity: number,
  visible: Set<string>
): Promise<Map<string, ProductDocument>> => {
  const members = await Product.find({ _id: { $in: combo.items.map((i) => i.productId) } });
  const byId = new Map(members.map((p) => [String(p._id), p]));
  for (const item of combo.items) {
    const product = byId.get(String(item.productId));
    if (!product) throw new AppError("A product in this combo is no longer available", 400);
    if (product.status !== "ACTIVE" || !visible.has(String(product.categoryId))) {
      throw new AppError("A product in this combo is no longer available", 400);
    }
    if (!product.isPreOrder && availableOf(product) < item.quantity * quantity) {
      throw new AppError(`Insufficient stock for combo item: ${product.productTitle}`, 400);
    }
  }
  return byId;
};

export const buildGuestOrderDraft = async (
  customerId: Types.ObjectId,
  body: Record<string, unknown>
): Promise<GuestOrderDraft> => {
  const shippingInfo = parseShippingInfo(body);
  const adminDiscountInput: AdminDiscountInput | null = parseAdminDiscountInput(body); // guest flow ignores it (see below)
  // Guest flow never grants admin discount — authentication would be required.
  const adminDiscount = null;
  void adminDiscountInput;

  const parsedLines = parseItemsPayload(body.items);
  const visible = new Set((await getVisibleCategoryIds()).map(String));

  // Fetch every product and combo referenced in the payload in two queries.
  const productIds = parsedLines.filter((l) => l.productId).map((l) => l.productId!);
  const comboIds = parsedLines.filter((l) => l.comboId).map((l) => l.comboId!);
  const [products, combos] = await Promise.all([
    productIds.length ? Product.find({ _id: { $in: productIds } }) : Promise.resolve([]),
    comboIds.length ? Combo.find({ _id: { $in: comboIds } }) : Promise.resolve([]),
  ]);
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const comboById = new Map(combos.map((c) => [String(c._id), c]));

  // Aggregate product-level demand (used by stock gate — guest items don't
  // share a cart but the same product may appear via several lines or combos).
  const perProductDemand = new Map<string, number>();
  for (const line of parsedLines) {
    if (line.productId) {
      perProductDemand.set(line.productId, (perProductDemand.get(line.productId) || 0) + line.quantity);
    } else if (line.comboId) {
      const combo = comboById.get(line.comboId!);
      if (!combo) throw new AppError("Combo is not available", 400);
      for (const member of combo.items) {
        const key = String(member.productId);
        perProductDemand.set(key, (perProductDemand.get(key) || 0) + member.quantity * line.quantity);
      }
    }
  }

  const items: DraftItem[] = [];
  const comboLines: { comboId: Types.ObjectId; quantity: number }[] = [];
  const preOrderProducts: ProductDocument[] = [];

  for (const line of parsedLines) {
    if (line.productId) {
      const product = productById.get(line.productId);
      if (!product || product.status !== "ACTIVE" || !visible.has(String(product.categoryId))) {
        throw new AppError("A product in your order is no longer available", 400);
      }
      const { selectedSize, selectedUnit } = resolveSelection(product, line.size, line.unit);
      if (!product.isPreOrder) {
        const demand = perProductDemand.get(line.productId) || 0;
        if (availableOf(product) < demand) {
          throw new AppError(`Only ${availableOf(product)} unit${availableOf(product) === 1 ? "" : "s"} available for "${product.productTitle}"`, 400);
        }
      } else {
        preOrderProducts.push(product);
      }
      const unitPrice = getFinalPrice(product);
      items.push({
        productId: product._id,
        comboId: null,
        productTitleSnapshot: product.productTitle,
        thumbnailSnapshot: product.thumbnail,
        quantity: line.quantity,
        selectedSize,
        selectedUnit,
        unitPrice,
        subtotal: roundMoney(unitPrice * line.quantity),
        isPreOrder: product.isPreOrder,
        comboItemsSnapshot: [],
      });
    } else if (line.comboId) {
      const combo = comboById.get(line.comboId);
      if (!combo || !isComboLive(combo)) throw new AppError("Combo is not available", 400);
      const members = await assertComboMembersAvailable(combo, line.quantity, visible);
      // Also enforce aggregate demand on each member in case the same product
      // is both a direct line AND a combo member.
      for (const member of combo.items) {
        const memberProduct = members.get(String(member.productId));
        if (memberProduct && !memberProduct.isPreOrder) {
          const demand = perProductDemand.get(String(memberProduct._id)) || 0;
          if (availableOf(memberProduct) < demand) {
            throw new AppError(`Insufficient stock for combo item: ${memberProduct.productTitle}`, 400);
          }
        }
      }
      const unitPrice = combo.comboPrice;
      items.push({
        productId: null,
        comboId: combo._id,
        productTitleSnapshot: combo.comboTitle,
        thumbnailSnapshot: combo.thumbnail,
        quantity: line.quantity,
        selectedSize: null,
        selectedUnit: null,
        unitPrice,
        subtotal: roundMoney(unitPrice * line.quantity),
        comboItemsSnapshot: combo.items.map((m) => {
          const memberProduct = members.get(String(m.productId));
          return {
            productId: m.productId,
            productTitle: memberProduct?.productTitle ?? "",
            quantity: m.quantity,
            unitPrice: memberProduct ? getFinalPrice(memberProduct) : 0,
          };
        }),
      });
      comboLines.push({ comboId: combo._id, quantity: line.quantity });
    }
  }

  const subtotal = roundMoney(items.reduce((sum, i) => sum + i.subtotal, 0));

  // Coupons work for guests too, as long as the coupon rules don't require
  // first-purchase account history etc.
  const couponLines = items
    .filter((i) => i.productId)
    .map((i) => {
      const product = productById.get(String(i.productId))!;
      return {
        productId: i.productId as Types.ObjectId,
        categoryId: product.categoryId,
        subtotal: i.subtotal,
      };
    });
  const productSubtotal = roundMoney(couponLines.reduce((sum, l) => sum + l.subtotal, 0));
  const couponCode = normalizeCouponCode(body.couponCode);
  const coupon = couponCode ? await evaluateCoupon(couponCode, customerId, couponLines, productSubtotal) : null;
  const discount = coupon ? coupon.discount : 0;

  const eligibleForAdminDiscount = Math.max(0, roundMoney(subtotal - discount));
  const resolvedAdminDiscount = adminDiscount
    ? calculateAdminDiscount(adminDiscount, eligibleForAdminDiscount)
    : null;
  const adminDiscountAmount = resolvedAdminDiscount ? resolvedAdminDiscount.amount : 0;

  const shippingCost =
    shippingInfo.fulfillmentMethod === "STORE_PICKUP"
      ? 0
      : calculateShippingCharge(await getShippingConfig(), shippingInfo.city, subtotal - discount);
  const totalAmount = roundMoney(Math.max(0, subtotal - discount - adminDiscountAmount + shippingCost));

  const isPreOrder = preOrderProducts.length > 0;
  const preOrderMinDays = isPreOrder
    ? Math.max(...preOrderProducts.map((p) => Math.max(p.preOrderMinDays || 0, PRE_ORDER.MIN_DELIVERY_DAYS)))
    : 0;
  const expectedDeliveryDate = isPreOrder
    ? new Date(Date.now() + preOrderMinDays * 24 * 60 * 60 * 1000)
    : null;

  return {
    items,
    comboLines,
    subtotal,
    discount,
    coupon,
    adminDiscount: resolvedAdminDiscount,
    shippingCost,
    totalAmount,
    shippingInfo,
    isPreOrder,
    preOrderMinDays,
    expectedDeliveryDate,
  };
};
