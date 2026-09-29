import type { Types } from "mongoose";
import { AVAILABILITY, type Availability } from "../config/productOptions";
import type { IProduct } from "../models/Product";
import type { ICategory } from "../models/Category";

export const getAvailability = (stock: number): Availability =>
  stock > 0 ? AVAILABILITY.IN_STOCK : AVAILABILITY.OUT_OF_STOCK;

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

// Shape a product for the response; hides stock/cost unless allowed
export const toProductResponse = (
  product: ProductLike | { toObject(): ProductLike },
  visibility: ProductVisibility = {}
) => {
  const p: ProductLike = "toObject" in product && typeof product.toObject === "function" ? product.toObject() : (product as ProductLike);
  const finalPrice = getFinalPrice(p);

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
    availability: getAvailability(p.stock),
    // Approved reviews only (for the product card and details page)
    rating: { averageRating: p.ratingAverage ?? 0, totalReviews: p.ratingCount ?? 0 },
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };

  if (visibility.canSeeStock) data.stock = p.stock;
  if (visibility.canSeeCost) data.productCost = p.productCost;
  return data;
};
