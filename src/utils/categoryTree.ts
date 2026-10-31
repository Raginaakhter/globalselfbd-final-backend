import type { Types } from "mongoose";
import Category, { type ICategory } from "../models/Category";
import { LIMITS } from "../config/productOptions";

export type CategoryRecord = ICategory & { _id: Types.ObjectId };
export type CategoryMap = Map<string, CategoryRecord>;

// Category data is read on nearly every storefront request (product list, product
// detail, cart, offers, …) but changes only when an admin edits a category.
// A short in-memory cache turns N Mongo round-trips per minute into one.
// The TTL is a safety net; mutations also call invalidateCategoryCache() so
// edits are reflected immediately on this process.
const CACHE_TTL_MS = 60_000;
let cachedMap: CategoryMap | null = null;
let cachedMapAt = 0;
let inflightMap: Promise<CategoryMap> | null = null;
let cachedVisibleIds: Types.ObjectId[] | null = null;
let cachedVisibleIdsAt = 0;

export const invalidateCategoryCache = (): void => {
  cachedMap = null;
  cachedMapAt = 0;
  cachedVisibleIds = null;
  cachedVisibleIdsAt = 0;
};

// All categories in memory (category trees are small) for paths, cycles and counts
export const loadCategoryMap = async (): Promise<CategoryMap> => {
  const now = Date.now();
  if (cachedMap && now - cachedMapAt < CACHE_TTL_MS) return cachedMap;
  // Collapse concurrent cold reads into one Mongo query
  if (inflightMap) return inflightMap;
  inflightMap = (async () => {
    const all = await Category.find().select("-__v").lean();
    const map = new Map(all.map((c) => [String(c._id), c]));
    cachedMap = map;
    cachedMapAt = Date.now();
    return map;
  })();
  try {
    return await inflightMap;
  } finally {
    inflightMap = null;
  }
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
  const now = Date.now();
  if (cachedVisibleIds && now - cachedVisibleIdsAt < CACHE_TTL_MS) return cachedVisibleIds;
  const map = await loadCategoryMap();
  const ids = [...map.values()]
    .filter((c) => getAncestry(c._id, map).every((a) => a.status === "ACTIVE"))
    .map((c) => c._id);
  cachedVisibleIds = ids;
  cachedVisibleIdsAt = Date.now();
  return ids;
};

// A category and all its descendants
export const getCategoryWithDescendants = async (categoryId: string): Promise<Types.ObjectId[]> => {
  const map = await loadCategoryMap();
  return [...map.values()]
    .filter((c) => getAncestry(c._id, map).some((a) => String(a._id) === String(categoryId)))
    .map((c) => c._id);
};
