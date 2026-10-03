import mongoose, { type ClientSession, type Types } from "mongoose";
import Combo, { COMBO_LIMITS, type ComboDocument, type IComboItem } from "../models/Combo";
import Product, { type ProductDocument } from "../models/Product";
import AppError from "./AppError";
import { getFinalPrice } from "./productView";
import { getVisibleCategoryIds } from "./categoryTree";
import { roundMoney } from "./checkout";

export type ComboRecord = ComboDocument;

export const findComboOr404 = async (id: unknown): Promise<ComboDocument> => {
  if (typeof id !== "string" || !mongoose.isValidObjectId(id)) {
    throw new AppError("Invalid combo ID", 400);
  }
  const combo = await Combo.findById(id);
  if (!combo) throw new AppError("Combo not found", 404);
  return combo;
};

// Combo is sellable now: ACTIVE and inside the campaign window (if any)
export const isComboLive = (
  combo: Pick<ComboDocument, "status" | "startsAt" | "endsAt">,
  now = new Date()
): boolean => {
  if (combo.status !== "ACTIVE") return false;
  if (combo.startsAt && combo.startsAt > now) return false;
  if (combo.endsAt && combo.endsAt <= now) return false;
  return true;
};

export interface ComboMemberProduct {
  product: ProductDocument;
  quantity: number;
}

// Load member products for a combo; fails if any are missing, inactive, or in an
// inactive category. Also enforces that there are enough products to buy
// `multiplier` copies of the combo.
export const loadComboMemberProducts = async (
  combo: ComboDocument,
  multiplier = 1
): Promise<ComboMemberProduct[]> => {
  const productIds = combo.items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds } });
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const visible = new Set((await getVisibleCategoryIds()).map(String));

  const members: ComboMemberProduct[] = [];
  for (const item of combo.items) {
    const product = byId.get(String(item.productId));
    if (!product) throw new AppError(`A product in this combo is no longer available`, 400);
    if (product.status !== "ACTIVE" || !visible.has(String(product.categoryId))) {
      throw new AppError(`A product in this combo is no longer available`, 400);
    }
    const totalNeeded = item.quantity * multiplier;
    if (product.stock < totalNeeded) {
      throw new AppError(`Insufficient stock for a combo item`, 400);
    }
    members.push({ product, quantity: item.quantity });
  }
  return members;
};

// Analytics-style price breakdown from the member products' current prices
export const summarizePricing = (
  comboPrice: number,
  items: { product: ProductDocument; quantity: number }[]
) => {
  const originalTotal = roundMoney(
    items.reduce((sum, { product, quantity }) => sum + getFinalPrice(product) * quantity, 0)
  );
  const savings = Math.max(roundMoney(originalTotal - comboPrice), 0);
  const discountPercent = originalTotal > 0 ? Math.round((savings / originalTotal) * 100) : 0;
  return { originalTotal, savings, discountPercent };
};

export interface ComboItemDetail {
  productId: Types.ObjectId;
  productTitle: string;
  slug: string;
  thumbnail: string;
  quantity: number;
  // Current price per unit (uses customerSpecialPrice when set)
  unitPrice: number;
  subtotal: number;
}

export const toComboItemDetails = (
  items: { product: ProductDocument; quantity: number }[]
): ComboItemDetail[] =>
  items.map(({ product, quantity }) => {
    const unitPrice = getFinalPrice(product);
    return {
      productId: product._id,
      productTitle: product.productTitle,
      slug: product.slug,
      thumbnail: product.thumbnail,
      quantity,
      unitPrice,
      subtotal: roundMoney(unitPrice * quantity),
    };
  });

export interface ComboResponseOptions {
  canSeeInactive?: boolean;
  memberDetails?: ComboItemDetail[];
}

export const toComboResponse = (
  combo: ComboDocument,
  options: ComboResponseOptions = {}
) => {
  const details = options.memberDetails ?? [];
  const originalTotal = details.length
    ? roundMoney(details.reduce((sum, d) => sum + d.subtotal, 0))
    : 0;
  const savings = details.length ? Math.max(roundMoney(originalTotal - combo.comboPrice), 0) : 0;
  const discountPercent =
    details.length && originalTotal > 0 ? Math.round((savings / originalTotal) * 100) : 0;

  return {
    _id: combo._id,
    comboTitle: combo.comboTitle,
    slug: combo.slug,
    description: combo.description,
    comboPrice: combo.comboPrice,
    thumbnail: combo.thumbnail,
    gallery: combo.gallery,
    categoryId: combo.categoryId,
    items: combo.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    itemDetails: details,
    originalTotal,
    savings,
    discountPercent,
    startsAt: combo.startsAt,
    endsAt: combo.endsAt,
    status: combo.status,
    isLive: isComboLive(combo),
    displayOrder: combo.displayOrder,
    soldCount: combo.soldCount,
    revenue: combo.revenue,
    views: combo.views,
    createdAt: combo.createdAt,
    updatedAt: combo.updatedAt,
  };
};

// Build an item-list from user input: validates object shape and productId
export const parseComboItems = (value: unknown): IComboItem[] => {
  if (!Array.isArray(value)) {
    throw new AppError('"items" must be a list of { productId, quantity }', 400);
  }
  if (value.length < COMBO_LIMITS.MIN_ITEMS || value.length > COMBO_LIMITS.MAX_ITEMS) {
    throw new AppError(
      `A combo must have between ${COMBO_LIMITS.MIN_ITEMS} and ${COMBO_LIMITS.MAX_ITEMS} items`,
      400
    );
  }
  const parsed: IComboItem[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      throw new AppError("Each combo item must be an object with productId and quantity", 400);
    }
    const raw = entry as { productId?: unknown; quantity?: unknown };
    if (typeof raw.productId !== "string" || !mongoose.isValidObjectId(raw.productId)) {
      throw new AppError("Each combo item needs a valid productId", 400);
    }
    const qty = typeof raw.quantity === "string" ? Number(raw.quantity) : raw.quantity;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > COMBO_LIMITS.MAX_ITEM_QUANTITY) {
      throw new AppError(
        `Each combo item quantity must be a whole number between 1 and ${COMBO_LIMITS.MAX_ITEM_QUANTITY}`,
        400
      );
    }
    if (seen.has(raw.productId)) {
      throw new AppError("A combo cannot include the same product twice", 400);
    }
    seen.add(raw.productId);
    parsed.push({ productId: new mongoose.Types.ObjectId(raw.productId), quantity: qty });
  }
  return parsed;
};

// Make sure all referenced products exist, are ACTIVE and visible
export const assertComboProducts = async (items: IComboItem[]): Promise<void> => {
  const ids = items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: ids } }).select("_id status categoryId");
  if (products.length !== ids.length) {
    throw new AppError("One or more products in the combo were not found", 400);
  }
  const visible = new Set((await getVisibleCategoryIds()).map(String));
  for (const product of products) {
    if (product.status !== "ACTIVE") {
      throw new AppError("One or more products in the combo are inactive", 400);
    }
    if (!visible.has(String(product.categoryId))) {
      throw new AppError("One or more products in the combo are not available", 400);
    }
  }
};

// Decrement stock for every member product atomically; used when a combo is ordered.
export const decrementComboStock = async (
  combo: ComboDocument,
  multiplier: number,
  session: ClientSession
): Promise<void> => {
  for (const item of combo.items) {
    const needed = item.quantity * multiplier;
    const result = await Product.updateOne(
      { _id: item.productId, status: "ACTIVE", stock: { $gte: needed } },
      { $inc: { stock: -needed } },
      { session }
    );
    if (result.modifiedCount !== 1) {
      throw new AppError("Insufficient stock for a combo item", 409);
    }
  }
};

// Return stock for every member product (combo order cancelled)
export const restoreComboStock = async (
  combo: Pick<ComboDocument, "items">,
  multiplier: number,
  session: ClientSession
): Promise<void> => {
  for (const item of combo.items) {
    const giveBack = item.quantity * multiplier;
    await Product.updateOne({ _id: item.productId }, { $inc: { stock: giveBack } }, { session });
  }
};
