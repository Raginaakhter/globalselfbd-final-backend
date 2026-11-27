import type { Types } from "mongoose";
import { AVAILABILITY, AVAILABILITY_STATUS, type Availability, type AvailabilityStatus } from "../config/productOptions";
import type { IProduct } from "../models/Product";
import type { ICategory } from "../models/Category";
import AppError from "./AppError";
import { isPreOrderEligible, type PreorderConfig } from "./preorder";

// `available` is what customers can buy right now: stock - reserved.
// A pre-order product is always treated as available (purchasable), because the admin
// promises delivery after the fulfilment window even when today's stock is zero.
export const getAvailability = (
  available: number,
  isPreOrder = false
): Availability => (available > 0 || isPreOrder ? AVAILABILITY.IN_STOCK : AVAILABILITY.OUT_OF_STOCK);

// The three storefront states: In Stock / Pre-order / Out of Stock.
export const getAvailabilityStatus = (available: number, isPreOrder = false): AvailabilityStatus =>
  isPreOrder ? AVAILABILITY_STATUS.PRE_ORDER : available > 0 ? AVAILABILITY_STATUS.IN_STOCK : AVAILABILITY_STATUS.OUT_OF_STOCK;

const AVAILABLE_EXPR = { $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] };

// Mongo filter for ?availability=IN_STOCK | PRE_ORDER | OUT_OF_STOCK (matches getAvailabilityStatus).
export const availabilityFilter = (value: string): Record<string, unknown> => {
  if (value === AVAILABILITY_STATUS.PRE_ORDER) return { isPreOrder: true };
  if (value === AVAILABILITY_STATUS.IN_STOCK) return { isPreOrder: { $ne: true }, $expr: { $gt: [AVAILABLE_EXPR, 0] } };
  if (value === AVAILABILITY_STATUS.OUT_OF_STOCK) return { isPreOrder: { $ne: true }, $expr: { $lte: [AVAILABLE_EXPR, 0] } };
  throw new AppError("availability must be IN_STOCK, PRE_ORDER or OUT_OF_STOCK", 400);
};

// Mongo filter for ?preOrderSource=AUTO | MANUAL | NONE — products selling as pre-order
// right now because of the site rule (AUTO) or the admin's setting (MANUAL), or not at all.
export const preOrderSourceFilter = (value: string): Record<string, unknown> => {
  if (value === "NONE") return { isPreOrder: { $ne: true } };
  if (value === "AUTO" || value === "MANUAL") return { isPreOrder: true, preOrderSource: value };
  throw new AppError("preOrderSource must be AUTO, MANUAL or NONE", 400);
};

export const getFinalPrice = (product: Pick<IProduct, "customerSellPrice" | "customerSpecialPrice">): number =>
  product.customerSpecialPrice != null ? product.customerSpecialPrice : product.customerSellPrice;

export interface ProductVisibility {
  canSeeStock?: boolean;
  canSeeCost?: boolean;
  canSeeInactive?: boolean;
}

// What a viewer may see, based on permissions (never on role names)
//  - stock:       inventory.view
//  - productCost: products.update (purchase cost is internal business data)
//  - inactive products / categories: products.update
export const getProductVisibility = (permissions: Set<string> = new Set()): Required<ProductVisibility> => ({
  canSeeStock: permissions.has("inventory.view"),
  canSeeCost: permissions.has("products.update"),
  canSeeInactive: permissions.has("products.update"),
});

type CategoryLike = Types.ObjectId | (Pick<ICategory, "name" | "slug" | "status"> & { _id: Types.ObjectId }) | null;

// A product as stored, with categoryId either an ID or a populated category
export type ProductLike = Omit<IProduct, "categoryId"> & { _id: Types.ObjectId; categoryId: CategoryLike };

const categoryRef = (category: CategoryLike) =>
  category && typeof category === "object" && "name" in category
    ? { _id: category._id, name: category.name, slug: category.slug, status: category.status }
    : category;

// Shape a product for the response; hides stock/cost unless allowed.
// Pass `preorder` (the site config) to admins so they also get the product's
// pre-order policy: `preOrderEnabled` = may it sell as pre-order when out of stock.
export const toProductResponse = (
  product: ProductLike | { toObject(): ProductLike },
  visibility: ProductVisibility = {},
  preorder?: PreorderConfig
) => {
  const p: ProductLike = "toObject" in product && typeof product.toObject === "function" ? product.toObject() : (product as ProductLike);
  const finalPrice = getFinalPrice(p);
  const available = Math.max(0, (p.stock ?? 0) - (p.reserved ?? 0));

  const data: Record<string, unknown> = {
    _id: p._id,
    productTitle: p.productTitle,
    slug: p.slug,
    productDescription: p.productDescription,
    categoryId: categoryRef(p.categoryId),
    customerSellPrice: p.customerSellPrice,
    customerSpecialPrice: p.customerSpecialPrice,
    finalPrice,
    discountPercent:
      p.customerSpecialPrice != null
        ? Math.round(((p.customerSellPrice - p.customerSpecialPrice) / p.customerSellPrice) * 100)
        : 0,
    isFabric: p.isFabric,
    sizes: p.sizes,
    unit: p.unit,
    quantity: p.quantity,
    thumbnail: p.thumbnail,
    gallery: p.gallery,
    availability: getAvailability(available, p.isPreOrder),
    availabilityStatus: getAvailabilityStatus(available, p.isPreOrder),
    isPreOrder: p.isPreOrder,
    preOrderMinDays: p.preOrderMinDays,
    freeDelivery: !!p.freeDelivery,
    // Approved reviews only (for the product card and details page)
    rating: { averageRating: p.ratingAverage ?? 0, totalReviews: p.ratingCount ?? 0 },
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };

  if (visibility.canSeeStock) {
    data.stock = p.stock;
    data.reserved = p.reserved ?? 0;
    data.available = available;
    data.lowStockThreshold = p.lowStockThreshold ?? 0;
    data.sku = p.sku ?? "";
  }
  if (visibility.canSeeCost) data.productCost = p.productCost;
  if (visibility.canSeeInactive) {
    data.preOrderSource = p.preOrderSource ?? null;
    if (preorder) data.preOrderEnabled = isPreOrderEligible(p.preOrderSource, preorder);
  }
  return data;
};
