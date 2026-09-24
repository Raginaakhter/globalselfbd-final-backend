import type { Request, Response } from "express";
import type { Model, Types } from "mongoose";
import Category, { type CategoryDocument } from "../models/Category";
import Product from "../models/Product";
import AppError from "../utils/AppError";
import { slugify, isValidSlug, uniqueSlug } from "../utils/slugify";
import { isValidImageUrl } from "../utils/imageValidation";
import {
  isNonEmptyString,
  assertObjectId,
  assertStatus,
  escapeRegex,
  queryString,
} from "../utils/validators";
import { loadCategoryMap, getAncestry, buildPath, type CategoryMap, type CategoryRecord } from "../utils/categoryTree";
import { LIMITS } from "../config/productOptions";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;
type CountMap = Map<string, number>;

const NAME_COLLATION = { locale: "en", strength: 2 };

// ---------- helpers ----------

// Height of the subtree under a category (a leaf = 1)
const subtreeHeight = (id: Types.ObjectId | string, map: CategoryMap): number => {
  const children = [...map.values()].filter((c) => String(c.parentCategoryId) === String(id));
  return 1 + Math.max(0, ...children.map((child) => subtreeHeight(child._id, map)));
};

const countBy = async <T>(Model: Model<T>, field: string, ids: Types.ObjectId[]): Promise<CountMap> => {
  const rows = await Model.aggregate<{ _id: unknown; count: number }>([
    { $match: { [field]: { $in: ids } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
};

const findCategoryOr404 = async (id: unknown): Promise<CategoryDocument> => {
  assertObjectId(id, "category ID");
  const category = await Category.findById(id);
  if (!category) throw new AppError("Category not found", 404);
  return category;
};

const assertUniqueName = async (name: string, excludeId?: Types.ObjectId): Promise<void> => {
  const filter: Record<string, unknown> = { name };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Category.findOne(filter).collation(NAME_COLLATION).select("_id")) {
    throw new AppError(`A category named "${name}" already exists`, 409);
  }
};

// Returns a normalized slug or throws; checks it is not used by another category
const resolveRequestedSlug = async (rawSlug: unknown, excludeId?: Types.ObjectId): Promise<string> => {
  if (typeof rawSlug !== "string") throw new AppError("Slug must be a string", 400);
  const slug = slugify(rawSlug);
  if (!slug || !isValidSlug(slug)) throw new AppError("Slug is invalid", 400);
  const filter: Record<string, unknown> = { slug };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Category.exists(filter)) throw new AppError(`Slug "${slug}" is already in use`, 409);
  return slug;
};

// Validate a new parent: exists, ACTIVE, not itself, no cycle, depth limit
const resolveParent = async (rawParentId: unknown, categoryId: Types.ObjectId | null): Promise<Types.ObjectId | null> => {
  if (rawParentId === null || rawParentId === "" || rawParentId === undefined) return null;
  assertObjectId(rawParentId, "parent category ID");

  if (categoryId && String(rawParentId) === String(categoryId)) {
    throw new AppError("A category cannot be its own parent", 400);
  }

  const map = await loadCategoryMap();
  const parent = map.get(String(rawParentId));
  if (!parent) throw new AppError("Parent category not found", 404);
  if (parent.status !== "ACTIVE") throw new AppError("Parent category is inactive", 400);

  const ancestry = getAncestry(parent._id, map);
  if (categoryId && ancestry.some((c) => String(c._id) === String(categoryId))) {
    throw new AppError("Circular category relationship is not allowed (the parent is inside this category)", 400);
  }

  const ownHeight = categoryId ? subtreeHeight(categoryId, map) : 1;
  if (ancestry.length + ownHeight > LIMITS.CATEGORY_DEPTH_MAX) {
    throw new AppError(`Category nesting cannot exceed ${LIMITS.CATEGORY_DEPTH_MAX} levels`, 400);
  }
  return parent._id;
};

const validateTextFields = ({ name, description, imageUrl }: Body, { requireName }: { requireName: boolean }): void => {
  if (requireName || name !== undefined) {
    if (!isNonEmptyString(name)) throw new AppError("Category name is required", 400);
    if (name.trim().length > LIMITS.CATEGORY_NAME_MAX) {
      throw new AppError(`Category name cannot exceed ${LIMITS.CATEGORY_NAME_MAX} characters`, 400);
    }
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== "string") throw new AppError("Description must be text", 400);
    if (description.length > LIMITS.CATEGORY_DESCRIPTION_MAX) {
      throw new AppError(`Description cannot exceed ${LIMITS.CATEGORY_DESCRIPTION_MAX} characters`, 400);
    }
  }
  if (imageUrl !== undefined && imageUrl !== null && imageUrl !== "" && !isValidImageUrl(imageUrl)) {
    throw new AppError("Image URL must be a valid http(s) URL", 400);
  }
};

const toCategoryResponse = (
  category: CategoryDocument | CategoryRecord,
  map: CategoryMap,
  counts: { children?: CountMap; products?: CountMap } = {}
) => {
  const c: CategoryRecord =
    "toObject" in category && typeof category.toObject === "function" ? category.toObject() : (category as CategoryRecord);
  const parent = c.parentCategoryId ? map.get(String(c.parentCategoryId)) : null;
  return {
    ...c,
    parent: parent ? { _id: parent._id, name: parent.name, slug: parent.slug, status: parent.status } : null,
    path: buildPath(c._id, map),
    level: getAncestry(c._id, map).length - 1,
    childrenCount: counts.children ? counts.children.get(String(c._id)) || 0 : undefined,
    productCount: counts.products ? counts.products.get(String(c._id)) || 0 : undefined,
  };
};
type CategoryResponse = ReturnType<typeof toCategoryResponse>;

const assertParentActiveForActivation = async (category: CategoryDocument): Promise<void> => {
  if (!category.parentCategoryId) return;
  const parent = await Category.findById(category.parentCategoryId).select("status");
  if (parent && parent.status !== "ACTIVE") {
    throw new AppError("Cannot activate: the parent category is inactive", 400);
  }
};

// ---------- handlers ----------

// @desc    Create a category
// @route   POST /api/categories
// @access  categories.create
export const createCategory = async (req: Request, res: Response) => {
  const { name, slug, parentCategoryId, imageUrl, description, status = "ACTIVE" } = (req.body || {}) as Body;
  validateTextFields({ name, description, imageUrl }, { requireName: true });
  assertStatus(status);

  const cleanName = (name as string).trim();
  await assertUniqueName(cleanName);

  const finalSlug =
    slug !== undefined && slug !== null && slug !== ""
      ? await resolveRequestedSlug(slug)
      : await uniqueSlug(Category, slugify(cleanName) || "category");

  const parentId = await resolveParent(parentCategoryId, null);

  const category = await Category.create({
    name: cleanName,
    slug: finalSlug,
    parentCategoryId: parentId,
    imageUrl: (imageUrl as string) || null,
    description: (description as string) || "",
    status,
  });

  const map = await loadCategoryMap();
  res.status(201).json({
    success: true,
    message: "Category created successfully",
    data: toCategoryResponse(category, map, { children: new Map(), products: new Map() }),
  });
};

// @desc    List categories (flat with path, or nested tree)
// @route   GET /api/categories
// @access  categories.view
export const getCategories = async (req: Request, res: Response) => {
  const status = queryString(req.query.status);
  const parentId = queryString(req.query.parentId);
  const search = queryString(req.query.search);
  const tree = queryString(req.query.tree);
  if (status) assertStatus(status);
  if (parentId && parentId !== "null") assertObjectId(parentId, "parent ID");

  const map = await loadCategoryMap();
  const ids = [...map.values()].map((c) => c._id);
  const counts = {
    children: await countBy(Category, "parentCategoryId", ids),
    products: await countBy(Product, "categoryId", ids),
  };

  let list = [...map.values()];
  if (status) list = list.filter((c) => c.status === status);
  if (parentId === "null") list = list.filter((c) => !c.parentCategoryId);
  else if (parentId) list = list.filter((c) => String(c.parentCategoryId) === parentId);
  if (isNonEmptyString(search)) {
    const pattern = new RegExp(escapeRegex(search.trim()), "i");
    list = list.filter((c) => pattern.test(c.name) || pattern.test(c.slug));
  }

  const items = list.map((c) => toCategoryResponse(c, map, counts)).sort((a, b) => a.path.localeCompare(b.path));

  if (tree === "true") {
    // Nest the (filtered) categories; a category whose parent was filtered out becomes a root
    type Node = CategoryResponse & { children: Node[] };
    const byId = new Map<string, Node>(items.map((c) => [String(c._id), { ...c, children: [] }]));
    const roots: Node[] = [];
    for (const node of byId.values()) {
      const parent = node.parentCategoryId ? byId.get(String(node.parentCategoryId)) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return res.status(200).json({ success: true, message: "Categories fetched successfully", data: roots });
  }

  return res.status(200).json({
    success: true,
    message: "Categories fetched successfully",
    data: items,
  });
};

// @desc    Get one category with parent, children and counts
// @route   GET /api/categories/:id
// @access  categories.view
export const getCategory = async (req: Request, res: Response) => {
  const category = await findCategoryOr404(req.params.id);
  const map = await loadCategoryMap();

  const children = [...map.values()]
    .filter((c) => String(c.parentCategoryId) === String(category._id))
    .map((c) => ({ _id: c._id, name: c.name, slug: c.slug, status: c.status }));
  const productCount = await Product.countDocuments({ categoryId: category._id });

  res.status(200).json({
    success: true,
    message: "Category fetched successfully",
    data: {
      ...toCategoryResponse(category, map),
      childrenCount: children.length,
      productCount,
      children,
      breadcrumb: getAncestry(category._id, map).map((c) => ({ _id: c._id, name: c.name, slug: c.slug })),
    },
  });
};

// @desc    Update a category
// @route   PUT /api/categories/:id
// @access  categories.update
export const updateCategory = async (req: Request, res: Response) => {
  const category = await findCategoryOr404(req.params.id);
  const { name, slug, parentCategoryId, imageUrl, description, status } = (req.body || {}) as Body;
  validateTextFields({ name, description, imageUrl }, { requireName: false });

  if (typeof name === "string") {
    const cleanName = name.trim();
    if (cleanName.toLowerCase() !== category.name.toLowerCase()) {
      await assertUniqueName(cleanName, category._id);
    }
    category.name = cleanName;
  }

  // Slug only changes when the admin sends one (keeps URLs stable when renaming)
  if (slug !== undefined && slug !== null && slug !== "" && slugify(slug) !== category.slug) {
    category.slug = await resolveRequestedSlug(slug, category._id);
  }

  if (parentCategoryId !== undefined) {
    const current = category.parentCategoryId ? String(category.parentCategoryId) : null;
    const requested = parentCategoryId ? String(parentCategoryId) : null;
    if (requested !== current) {
      category.parentCategoryId = await resolveParent(parentCategoryId, category._id);
    }
  }

  if (imageUrl !== undefined) category.imageUrl = (imageUrl as string) || null;
  if (description !== undefined) category.description = (description as string) || "";

  if (status !== undefined) {
    assertStatus(status);
    if (status === "ACTIVE") await assertParentActiveForActivation(category);
    category.status = status;
  }

  await category.save();

  const map = await loadCategoryMap();
  const counts = {
    children: await countBy(Category, "parentCategoryId", [category._id]),
    products: await countBy(Product, "categoryId", [category._id]),
  };
  res.status(200).json({
    success: true,
    message: "Category updated successfully",
    data: toCategoryResponse(category, map, counts),
  });
};

// @desc    Activate or deactivate a category
// @route   PATCH /api/categories/:id/status
// @access  categories.update
export const updateCategoryStatus = async (req: Request, res: Response) => {
  const category = await findCategoryOr404(req.params.id);
  const { status } = (req.body || {}) as Body;
  assertStatus(status);

  if (category.status === status) {
    throw new AppError(`Category is already ${status}`, 400);
  }
  if (status === "ACTIVE") await assertParentActiveForActivation(category);

  category.status = status;
  await category.save();

  res.status(200).json({
    success: true,
    message: `Category ${status === "ACTIVE" ? "activated" : "deactivated"} successfully`,
    data: category,
  });
};

// @desc    Delete a category (only if it has no sub-categories and no products)
// @route   DELETE /api/categories/:id
// @access  categories.delete
export const deleteCategory = async (req: Request, res: Response) => {
  const category = await findCategoryOr404(req.params.id);

  const [childCount, productCount] = await Promise.all([
    Category.countDocuments({ parentCategoryId: category._id }),
    Product.countDocuments({ categoryId: category._id }),
  ]);
  if (childCount > 0 || productCount > 0) {
    throw new AppError("Category cannot be deleted because it contains products or sub-categories", 409);
  }

  await category.deleteOne();

  res.status(200).json({
    success: true,
    message: "Category deleted successfully",
    data: { _id: category._id, name: category.name },
  });
};
