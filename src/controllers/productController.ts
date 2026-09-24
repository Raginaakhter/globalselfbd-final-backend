import mongoose from "mongoose";
import type { Request, Response } from "express";
import Product, { type IProduct, type ProductDocument } from "../models/Product";
import Category from "../models/Category";
import type { CategoryDocument } from "../models/Category";
import OrderItem from "../models/OrderItem";
import CartItem from "../models/CartItem";
import { loadPermissions } from "../middleware/auth";
import AppError from "../utils/AppError";
import { slugify, isValidSlug, uniqueSlug } from "../utils/slugify";
import { isValidImageUrl } from "../utils/imageValidation";
import {
  getProductVisibility,
  toProductResponse,
  type ProductLike,
  type ProductVisibility,
} from "../utils/productView";
import {
  loadCategoryMap,
  getAncestry,
  getVisibleCategoryIds,
  getCategoryWithDescendants,
} from "../utils/categoryTree";
import {
  isNonEmptyString,
  assertObjectId,
  assertStatus,
  escapeRegex,
  getPagination,
  queryString,
} from "../utils/validators";
import {
  SIZES,
  UNITS,
  STATUSES,
  AVAILABILITY,
  LIMITS,
  type Size,
  type Unit,
} from "../config/productOptions";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;
type CategoryRefDoc = Pick<CategoryDocument, "_id" | "name" | "slug" | "status">;
type PopulatedProduct = Omit<ProductDocument, "categoryId"> & { categoryId: CategoryRefDoc };

const CATEGORY_FIELDS = "name slug status";

// ---------- input parsing ----------

const toNumber = (value: unknown, label: string): number => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new AppError(`${label} must be a valid number`, 400);
  }
  return n;
};

const toBoolean = (value: unknown, label: string): boolean => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new AppError(`${label} must be true or false`, 400);
};

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === "";

const parseImageList = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value)) throw new AppError(`${label} must be an array of image URLs`, 400);
  if (!value.every(isValidImageUrl)) throw new AppError(`${label} contains an invalid image URL`, 400);
  return [...new Set((value as string[]).map((url) => url.trim()))];
};

type ProductFields = Partial<
  Pick<
    IProduct,
    | "productTitle"
    | "productDescription"
    | "stock"
    | "productCost"
    | "customerSellPrice"
    | "customerSpecialPrice"
    | "isFabric"
    | "sizes"
    | "unit"
    | "quantity"
    | "thumbnail"
    | "gallery"
    | "status"
    | "slug"
  >
> & { categoryId?: string };

// Parse only the fields present in the body; returns clean values
const parseProductFields = (body: Body): ProductFields => {
  const out: ProductFields = {};

  if (body.productTitle !== undefined) {
    if (!isNonEmptyString(body.productTitle)) throw new AppError("Product title is required", 400);
    if (body.productTitle.trim().length > LIMITS.TITLE_MAX) {
      throw new AppError(`Product title cannot exceed ${LIMITS.TITLE_MAX} characters`, 400);
    }
    out.productTitle = body.productTitle.trim();
  }

  if (body.productDescription !== undefined) {
    if (body.productDescription !== null && typeof body.productDescription !== "string") {
      throw new AppError("Product description must be text", 400);
    }
    const description = (body.productDescription as string | null) || "";
    if (description.length > LIMITS.DESCRIPTION_MAX) {
      throw new AppError(`Product description cannot exceed ${LIMITS.DESCRIPTION_MAX} characters`, 400);
    }
    out.productDescription = description;
  }

  if (body.categoryId !== undefined) {
    if (isBlank(body.categoryId)) throw new AppError("Category is required", 400);
    assertObjectId(body.categoryId, "category ID");
    out.categoryId = String(body.categoryId);
  }

  if (body.stock !== undefined) {
    const stock = toNumber(body.stock, "Stock");
    if (!Number.isInteger(stock) || stock < 0) throw new AppError("Stock must be a whole number of 0 or more", 400);
    out.stock = stock;
  }

  if (body.productCost !== undefined) {
    const cost = toNumber(body.productCost, "Product cost");
    if (cost < 0) throw new AppError("Product cost cannot be negative", 400);
    out.productCost = cost;
  }

  if (body.customerSellPrice !== undefined) {
    const price = toNumber(body.customerSellPrice, "Customer sell price");
    if (price <= 0) throw new AppError("Customer sell price must be greater than 0", 400);
    out.customerSellPrice = price;
  }

  if (body.customerSpecialPrice !== undefined) {
    if (isBlank(body.customerSpecialPrice)) {
      out.customerSpecialPrice = null;
    } else {
      const special = toNumber(body.customerSpecialPrice, "Customer special price");
      if (special <= 0) throw new AppError("Customer special price must be greater than 0", 400);
      out.customerSpecialPrice = special;
    }
  }

  if (body.isFabric !== undefined) out.isFabric = toBoolean(body.isFabric, "isFabric");

  if (body.sizes !== undefined) {
    if (!Array.isArray(body.sizes)) throw new AppError("Sizes must be an array", 400);
    const sizes = body.sizes.map((s: unknown) => (typeof s === "string" ? s.trim().toUpperCase() : s));
    const invalid = sizes.filter((s) => !(SIZES as readonly unknown[]).includes(s));
    if (invalid.length) {
      throw new AppError(`Invalid size: ${invalid.join(", ")}. Allowed: ${SIZES.join(", ")}`, 400);
    }
    out.sizes = [...new Set(sizes as Size[])];
  }

  if (body.unit !== undefined) {
    if (isBlank(body.unit)) {
      out.unit = null;
    } else {
      const raw = body.unit;
      const unit = UNITS.find((u) => typeof raw === "string" && u.toLowerCase() === raw.trim().toLowerCase());
      if (!unit) throw new AppError(`Invalid unit. Allowed: ${UNITS.join(", ")}`, 400);
      out.unit = unit as Unit;
    }
  }

  if (body.quantity !== undefined) {
    if (isBlank(body.quantity)) {
      out.quantity = null;
    } else {
      const quantity = toNumber(body.quantity, "Quantity");
      if (quantity <= 0) throw new AppError("Quantity must be greater than 0", 400);
      out.quantity = quantity;
    }
  }

  if (body.thumbnail !== undefined) {
    if (!isValidImageUrl(body.thumbnail)) throw new AppError("Thumbnail must be a valid image URL", 400);
    out.thumbnail = body.thumbnail.trim();
  }

  if (body.gallery !== undefined) {
    const gallery = parseImageList(body.gallery === null ? [] : body.gallery, "Gallery");
    if (gallery.length > LIMITS.GALLERY_MAX) {
      throw new AppError(`Gallery can have at most ${LIMITS.GALLERY_MAX} images`, 400);
    }
    out.gallery = gallery;
  }

  if (body.status !== undefined) {
    assertStatus(body.status);
    out.status = body.status;
  }

  return out;
};

type RuleFields = Pick<IProduct, "customerSpecialPrice" | "customerSellPrice" | "unit" | "quantity" | "isFabric" | "sizes">;

// Rules that depend on several fields; runs on the final (merged) product
const validateProductRules = (p: RuleFields): void => {
  if (p.customerSpecialPrice != null && p.customerSpecialPrice > p.customerSellPrice) {
    throw new AppError("Customer special price cannot be greater than customer sell price", 400);
  }

  const hasUnit = p.unit != null;
  const hasQuantity = p.quantity != null;
  if (hasUnit !== hasQuantity) {
    throw new AppError("Unit and quantity must be provided together", 400);
  }

  if (p.isFabric) {
    if ((!p.sizes || p.sizes.length === 0) && !hasUnit) {
      throw new AppError("Fabric products need at least one size, or a unit and quantity", 400);
    }
  } else {
    // Sizes are fabric-only configuration
    p.sizes = [];
  }
};

// Category must exist and be ACTIVE to be assigned
const assertAssignableCategory = async (categoryId: string): Promise<void> => {
  const category = await Category.findById(categoryId).select(CATEGORY_FIELDS);
  if (!category) throw new AppError("Category not found", 404);
  if (category.status !== "ACTIVE") throw new AppError("Category is inactive", 400);
};

const resolveProductSlug = async (rawSlug: unknown, excludeId?: mongoose.Types.ObjectId): Promise<string> => {
  if (typeof rawSlug !== "string") throw new AppError("Slug must be a string", 400);
  const slug = slugify(rawSlug);
  if (!slug || !isValidSlug(slug)) throw new AppError("Slug is invalid", 400);
  const filter: Record<string, unknown> = { slug };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Product.exists(filter)) throw new AppError(`Slug "${slug}" is already in use`, 409);
  return slug;
};

export const findProductOr404 = async (id: unknown): Promise<PopulatedProduct> => {
  assertObjectId(id, "product ID");
  const product = await Product.findById(id).populate<{ categoryId: CategoryRefDoc }>("categoryId", CATEGORY_FIELDS);
  if (!product) throw new AppError("Product not found", 404);
  return product;
};

const asProductLike = (product: PopulatedProduct): { toObject(): ProductLike } => product as unknown as { toObject(): ProductLike };

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  price_asc: { customerSellPrice: 1 },
  price_desc: { customerSellPrice: -1 },
  title_asc: { productTitle: 1 },
};

// Shared by the admin list (GET /api/products) and the storefront (GET /api/public/products)
export const listProducts = async (req: Request, visibility: ProductVisibility) => {
  const { page, limit, skip } = getPagination(req.query);
  const category = queryString(req.query.category);
  const includeSubcategories = queryString(req.query.includeSubcategories);
  const search = queryString(req.query.search);
  const status = queryString(req.query.status);
  const availability = queryString(req.query.availability);
  const isFabric = queryString(req.query.isFabric);
  const minPrice = queryString(req.query.minPrice);
  const maxPrice = queryString(req.query.maxPrice);
  const sort = queryString(req.query.sort);

  const filter: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];

  if (visibility.canSeeInactive) {
    if (status) {
      assertStatus(status);
      filter.status = status;
    }
  } else {
    filter.status = "ACTIVE";
    and.push({ categoryId: { $in: await getVisibleCategoryIds() } });
  }

  if (category) {
    assertObjectId(category, "category ID");
    const ids = includeSubcategories === "false" ? [category] : await getCategoryWithDescendants(category);
    and.push({ categoryId: { $in: ids } });
  }
  if (isNonEmptyString(search)) {
    filter.productTitle = new RegExp(escapeRegex(search.trim()), "i");
  }
  if (availability) {
    if (!(Object.values(AVAILABILITY) as string[]).includes(availability)) {
      throw new AppError("availability must be IN_STOCK or OUT_OF_STOCK", 400);
    }
    filter.stock = availability === AVAILABILITY.IN_STOCK ? { $gt: 0 } : 0;
  }
  if (isFabric !== undefined) filter.isFabric = toBoolean(isFabric, "isFabric");
  if (minPrice !== undefined || maxPrice !== undefined) {
    const range: Record<string, number> = {};
    if (minPrice !== undefined) range.$gte = toNumber(minPrice, "minPrice");
    if (maxPrice !== undefined) range.$lte = toNumber(maxPrice, "maxPrice");
    filter.customerSellPrice = range;
  }
  if (sort && !SORTS[sort]) {
    throw new AppError(`sort must be one of: ${Object.keys(SORTS).join(", ")}`, 400);
  }
  if (and.length) filter.$and = and;

  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate<{ categoryId: CategoryRefDoc }>("categoryId", CATEGORY_FIELDS)
      .sort(SORTS[sort || "newest"])
      .skip(skip)
      .limit(limit),
    Product.countDocuments(filter),
  ]);

  return {
    data: products.map((p) => toProductResponse(asProductLike(p), visibility)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

// ---------- handlers ----------

// @desc    Form options: active categories (dropdown), sizes, units
// @route   GET /api/products/options
// @access  products.create | products.update
export const getProductOptions = async (req: Request, res: Response) => {
  const map = await loadCategoryMap();
  const categories = (await getVisibleCategoryIds())
    .map((id) => map.get(String(id)))
    .filter((c) => c !== undefined)
    .map((c) => ({
      _id: c._id,
      name: c.name,
      slug: c.slug,
      path: getAncestry(c._id, map)
        .map((a) => a.name)
        .join(" > "),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  res.status(200).json({
    success: true,
    message: "Product options fetched successfully",
    data: { categories, sizes: SIZES, units: UNITS, statuses: STATUSES },
  });
};

// @desc    Create a product
// @route   POST /api/products
// @access  products.create
export const createProduct = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  for (const field of ["productTitle", "categoryId", "stock", "productCost", "customerSellPrice", "thumbnail"]) {
    if (isBlank(body[field])) throw new AppError(`${field} is required`, 400);
  }

  const fields = parseProductFields(body);
  const product = {
    productDescription: "",
    customerSpecialPrice: null,
    isFabric: false,
    sizes: [],
    unit: null,
    quantity: null,
    gallery: [],
    status: "ACTIVE" as const,
    ...fields,
  } as ProductFields & RuleFields & { categoryId: string; productTitle: string };
  validateProductRules(product);

  await assertAssignableCategory(product.categoryId);

  product.slug = !isBlank(body.slug)
    ? await resolveProductSlug(body.slug)
    : await uniqueSlug(Product, slugify(product.productTitle) || "product");

  const created = await Product.create(product);
  const populated = await created.populate<{ categoryId: CategoryRefDoc }>("categoryId", CATEGORY_FIELDS);

  res.status(201).json({
    success: true,
    message: "Product created successfully",
    data: toProductResponse(asProductLike(populated), getProductVisibility(req.permissions)),
  });
};

// Guests get the customer view; logged-in users get what their permissions allow
const getViewerVisibility = async (req: Request) =>
  getProductVisibility(req.user ? await loadPermissions(req) : new Set());

// @desc    List products (filters, search, sort, pagination)
// @route   GET /api/products
// @access  Public (customer view). Stock needs inventory.view; cost and inactive items need products.update
export const getProducts = async (req: Request, res: Response) => {
  const result = await listProducts(req, await getViewerVisibility(req));
  res.status(200).json({ success: true, message: "Products fetched successfully", ...result });
};

// @desc    Get one product by ID or slug
// @route   GET /api/products/:id
// @access  Public (customer view), more with permissions
export const getProduct = async (req: Request, res: Response) => {
  const visibility = await getViewerVisibility(req);
  const idOrSlug = String(req.params.id);
  const product = mongoose.isValidObjectId(idOrSlug)
    ? await findProductOr404(idOrSlug)
    : await Product.findOne({ slug: idOrSlug.toLowerCase() }).populate<{ categoryId: CategoryRefDoc }>(
        "categoryId",
        CATEGORY_FIELDS
      );
  if (!product) throw new AppError("Product not found", 404);

  if (!visibility.canSeeInactive) {
    const visible = (await getVisibleCategoryIds()).map(String);
    if (product.status !== "ACTIVE" || !visible.includes(String(product.categoryId._id))) {
      throw new AppError("Product not found", 404);
    }
  }

  res.status(200).json({
    success: true,
    message: "Product fetched successfully",
    data: toProductResponse(asProductLike(product), visibility),
  });
};

// @desc    Update a product (send only the fields to change)
// @route   PUT /api/products/:id
// @access  products.update (+ inventory.update to change stock)
export const updateProduct = async (req: Request, res: Response) => {
  const product = await findProductOr404(req.params.id);
  const body = (req.body || {}) as Body;
  const fields = parseProductFields(body);

  if (fields.stock !== undefined && fields.stock !== product.stock && !req.permissions?.has("inventory.update")) {
    throw new AppError("You do not have permission to change stock", 403);
  }

  const currentCategoryId = String(product.categoryId._id);
  if (fields.categoryId !== undefined && fields.categoryId !== currentCategoryId) {
    await assertAssignableCategory(fields.categoryId);
  } else {
    delete fields.categoryId;
  }

  // Validate the merged result before saving anything
  const merged: RuleFields = { ...(product.toObject() as unknown as RuleFields), ...(fields as Partial<RuleFields>) };
  validateProductRules(merged);
  fields.sizes = merged.sizes;

  if (fields.status === "ACTIVE" && product.status !== "ACTIVE" && fields.categoryId === undefined) {
    if (product.categoryId.status !== "ACTIVE") {
      throw new AppError("Cannot activate: the product's category is inactive", 400);
    }
  }

  if (!isBlank(body.slug) && slugify(body.slug) !== product.slug) {
    fields.slug = await resolveProductSlug(body.slug, product._id);
  }

  product.set(fields);
  await product.save();
  const updated = await product.populate<{ categoryId: CategoryRefDoc }>("categoryId", CATEGORY_FIELDS);

  res.status(200).json({
    success: true,
    message: "Product updated successfully",
    data: toProductResponse(asProductLike(updated), getProductVisibility(req.permissions)),
  });
};

// @desc    Activate or deactivate a product
// @route   PATCH /api/products/:id/status
// @access  products.update
export const updateProductStatus = async (req: Request, res: Response) => {
  const product = await findProductOr404(req.params.id);
  const { status } = (req.body || {}) as Body;
  assertStatus(status);

  if (product.status === status) throw new AppError(`Product is already ${status}`, 400);
  if (status === "ACTIVE" && product.categoryId.status !== "ACTIVE") {
    throw new AppError("Cannot activate: the product's category is inactive", 400);
  }

  product.status = status;
  await product.save();

  res.status(200).json({
    success: true,
    message: `Product ${status === "ACTIVE" ? "activated" : "deactivated"} successfully`,
    data: toProductResponse(asProductLike(product), getProductVisibility(req.permissions)),
  });
};

// @desc    Set stock, or adjust it up/down (atomic, never below 0)
// @route   PATCH /api/products/:id/stock
// @access  inventory.update
export const updateProductStock = async (req: Request, res: Response) => {
  const productId = req.params.id;
  assertObjectId(productId, "product ID");
  const { stock, adjustBy } = (req.body || {}) as Body;

  if ((stock === undefined) === (adjustBy === undefined)) {
    throw new AppError('Send either "stock" (new value) or "adjustBy" (e.g. 10 or -3)', 400);
  }

  let product: ProductDocument | null;
  if (stock !== undefined) {
    const value = toNumber(stock, "Stock");
    if (!Number.isInteger(value) || value < 0) throw new AppError("Stock must be a whole number of 0 or more", 400);
    product = await Product.findByIdAndUpdate(productId, { stock: value }, { returnDocument: "after" });
  } else {
    const delta = toNumber(adjustBy, "adjustBy");
    if (!Number.isInteger(delta) || delta === 0) throw new AppError("adjustBy must be a non-zero whole number", 400);
    product = await Product.findOneAndUpdate(
      { _id: productId, stock: { $gte: delta < 0 ? -delta : 0 } },
      { $inc: { stock: delta } },
      { returnDocument: "after" }
    );
    if (!product && (await Product.exists({ _id: productId }))) {
      throw new AppError("Stock cannot go below 0", 400);
    }
  }
  if (!product) throw new AppError("Product not found", 404);
  const populated = await product.populate<{ categoryId: CategoryRefDoc }>("categoryId", CATEGORY_FIELDS);

  res.status(200).json({
    success: true,
    message: "Stock updated successfully",
    data: toProductResponse(asProductLike(populated), getProductVisibility(req.permissions)),
  });
};

// @desc    Add and/or remove gallery images
// @route   PATCH /api/products/:id/gallery
// @access  products.update
export const updateProductGallery = async (req: Request, res: Response) => {
  const product = await findProductOr404(req.params.id);
  const { add = [], remove = [] } = (req.body || {}) as Body;
  const toAdd = parseImageList(add, "add");
  if (!Array.isArray(remove)) throw new AppError("remove must be an array of image URLs", 400);
  if (toAdd.length === 0 && remove.length === 0) {
    throw new AppError('Send image URLs in "add" and/or "remove"', 400);
  }

  const removeSet = new Set<unknown>(remove);
  const gallery = [...new Set([...product.gallery.filter((url) => !removeSet.has(url)), ...toAdd])];
  if (gallery.length > LIMITS.GALLERY_MAX) {
    throw new AppError(`Gallery can have at most ${LIMITS.GALLERY_MAX} images`, 400);
  }

  product.gallery = gallery;
  await product.save();

  res.status(200).json({
    success: true,
    message: "Gallery updated successfully",
    data: toProductResponse(asProductLike(product), getProductVisibility(req.permissions)),
  });
};

// @desc    Delete a product (products that were ordered are deactivated instead)
// @route   DELETE /api/products/:id
// @access  products.delete
export const deleteProduct = async (req: Request, res: Response) => {
  const product = await findProductOr404(req.params.id);

  // Keep ordered products so order history and reports stay linked
  if (await OrderItem.exists({ productId: product._id })) {
    product.status = "INACTIVE";
    await product.save();
    return res.status(200).json({
      success: true,
      message: "Product has orders, so it was deactivated instead of deleted",
      data: { _id: product._id, productTitle: product.productTitle, status: product.status, deleted: false },
    });
  }

  await CartItem.deleteMany({ productId: product._id });
  await product.deleteOne();

  return res.status(200).json({
    success: true,
    message: "Product deleted successfully",
    data: { _id: product._id, productTitle: product.productTitle, deleted: true },
  });
};
