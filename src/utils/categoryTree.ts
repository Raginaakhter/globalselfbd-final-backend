import type { Types } from "mongoose";
import Category, { type ICategory } from "../models/Category";
import { LIMITS } from "../config/productOptions";

export type CategoryRecord = ICategory & { _id: Types.ObjectId };
export type CategoryMap = Map<string, CategoryRecord>;

// All categories in memory (category trees are small) for paths, cycles and counts
export const loadCategoryMap = async (): Promise<CategoryMap> => {
  const all = await Category.find().lean();
  return new Map(all.map((c) => [String(c._id), c]));
};

// Walk up from a category to the root: [root, ..., category]
export const getAncestry = (id: Types.ObjectId | string, map: CategoryMap): CategoryRecord[] => {
  const chain: CategoryRecord[] = [];
  let current = map.get(String(id));
  while (current && chain.length <= LIMITS.CATEGORY_DEPTH_MAX + 1) {
    chain.unshift(current);
    current = current.parentCategoryId ? map.get(String(current.parentCategoryId)) : undefined;
  }
  return chain;
};

export const buildPath = (id: Types.ObjectId | string, map: CategoryMap): string =>
  getAncestry(id, map)
    .map((c) => c.name)
    .join(" > ");

// Categories customers can browse: ACTIVE and every ancestor ACTIVE
export const getVisibleCategoryIds = async (): Promise<Types.ObjectId[]> => {
  const map = await loadCategoryMap();
  return [...map.values()]
    .filter((c) => getAncestry(c._id, map).every((a) => a.status === "ACTIVE"))
    .map((c) => c._id);
};

// A category and all its descendants
export const getCategoryWithDescendants = async (categoryId: string): Promise<Types.ObjectId[]> => {
  const map = await loadCategoryMap();
  return [...map.values()]
    .filter((c) => getAncestry(c._id, map).some((a) => String(a._id) === String(categoryId)))
    .map((c) => c._id);
};
