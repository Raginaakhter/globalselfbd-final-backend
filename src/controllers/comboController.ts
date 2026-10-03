import mongoose from "mongoose";
import type { Request, Response } from "express";
import Combo, { COMBO_LIMITS, type ComboDocument, type IComboItem } from "../models/Combo";
import Category from "../models/Category";
import Product from "../models/Product";
import OrderItem from "../models/OrderItem";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import { isValidImageUrl } from "../utils/imageValidation";
import { slugify, isValidSlug, uniqueSlug } from "../utils/slugify";
import { getFinalPrice } from "../utils/productView";
import { roundMoney } from "../utils/checkout";
import {
  assertObjectId,
  assertStatus,
  escapeRegex,
  getPagination,
  isNonEmptyString,
  queryString,
} from "../utils/validators";
import {
  assertComboProducts,
  findComboOr404,
  parseComboItems,
  toComboItemDetails,
  toComboResponse,
  type ComboItemDetail,
} from "../utils/combos";

type Body = Record<string, unknown>;

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  displayOrder: { displayOrder: 1, createdAt: -1 },
  price_asc: { comboPrice: 1 },
  price_desc: { comboPrice: -1 },
  mostSold: { soldCount: -1, createdAt: -1 },
};

const parseDate = (value: unknown, label: string): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new AppError(`${label} must be a valid date`, 400);
  return date;
};

const parseGallery = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new AppError("Gallery must be an array of image URLs", 400);
  if (!value.every(isValidImageUrl)) throw new AppError("Gallery contains an invalid image URL", 400);
  const unique = [...new Set((value as string[]).map((url) => url.trim()))];
  if (unique.length > COMBO_LIMITS.GALLERY_MAX) {
    throw new AppError(`Gallery can have at most ${COMBO_LIMITS.GALLERY_MAX} images`, 400);
  }
  return unique;
};

const resolveComboSlug = async (
  rawSlug: unknown,
  excludeId?: mongoose.Types.ObjectId
): Promise<string> => {
  if (typeof rawSlug !== "string") throw new AppError("Slug must be a string", 400);
  const slug = slugify(rawSlug);
  if (!slug || !isValidSlug(slug)) throw new AppError("Slug is invalid", 400);
  const filter: Record<string, unknown> = { slug };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Combo.exists(filter)) throw new AppError(`Slug "${slug}" is already in use`, 409);
  return slug;
};

interface ParsedCombo {
  comboTitle?: string;
  description?: string;
  comboPrice?: number;
  thumbnail?: string;
  gallery?: string[];
  categoryId?: mongoose.Types.ObjectId | null;
  items?: IComboItem[];
  startsAt?: Date | null;
  endsAt?: Date | null;
  status?: "ACTIVE" | "INACTIVE";
  displayOrder?: number;
}

const parseComboFields = async (body: Body): Promise<ParsedCombo> => {
  const out: ParsedCombo = {};

  if (body.comboTitle !== undefined) {
    if (!isNonEmptyString(body.comboTitle)) throw new AppError("Combo title is required", 400);
    const title = body.comboTitle.trim();
    if (title.length > COMBO_LIMITS.TITLE_MAX) {
      throw new AppError(`Combo title cannot exceed ${COMBO_LIMITS.TITLE_MAX} characters`, 400);
    }
    out.comboTitle = title;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      throw new AppError("Description must be text", 400);
    }
    const description = (body.description as string | null) || "";
    if (description.length > COMBO_LIMITS.DESCRIPTION_MAX) {
      throw new AppError(`Description cannot exceed ${COMBO_LIMITS.DESCRIPTION_MAX} characters`, 400);
    }
    out.description = description;
  }

  if (body.comboPrice !== undefined) {
    const n = typeof body.comboPrice === "string" ? Number(body.comboPrice) : body.comboPrice;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new AppError("Combo price must be a number greater than 0", 400);
    }
    out.comboPrice = roundMoney(n);
  }

  if (body.thumbnail !== undefined) {
    if (!isValidImageUrl(body.thumbnail)) throw new AppError("Thumbnail must be a valid image URL", 400);
    out.thumbnail = body.thumbnail.trim();
  }

  if (body.gallery !== undefined) {
    out.gallery = parseGallery(body.gallery === null ? [] : body.gallery);
  }

  if (body.categoryId !== undefined) {
    if (body.categoryId === null || body.categoryId === "") {
      out.categoryId = null;
    } else {
      assertObjectId(body.categoryId, "category ID");
      const category = await Category.findById(body.categoryId).select("_id status");
      if (!category) throw new AppError("Category not found", 404);
      if (category.status !== "ACTIVE") throw new AppError("Category is inactive", 400);
      out.categoryId = category._id;
    }
  }

  if (body.items !== undefined) {
    out.items = parseComboItems(body.items);
  }

  const startsAt = parseDate(body.startsAt, "Start date");
  if (startsAt !== undefined) out.startsAt = startsAt;
  const endsAt = parseDate(body.endsAt, "End date");
  if (endsAt !== undefined) out.endsAt = endsAt;

  if (body.status !== undefined) {
    assertStatus(body.status);
    out.status = body.status;
  }

  if (body.displayOrder !== undefined) {
    const n = typeof body.displayOrder === "string" ? Number(body.displayOrder) : body.displayOrder;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 99999) {
      throw new AppError("displayOrder must be a whole number between 0 and 99999", 400);
    }
    out.displayOrder = n;
  }

  return out;
};

const validateComboRules = (combo: {
  startsAt?: Date | null;
  endsAt?: Date | null;
}): void => {
  if (combo.startsAt && combo.endsAt && combo.endsAt <= combo.startsAt) {
    throw new AppError("End date must be after the start date", 400);
  }
};

const respondWithCombo = async (
  res: Response,
  combo: ComboDocument,
  statusCode = 200,
  message = "Combo fetched successfully"
) => {
  const members = await Product.find({ _id: { $in: combo.items.map((i) => i.productId) } });
  const byId = new Map(members.map((p) => [String(p._id), p]));
  const details: ComboItemDetail[] = toComboItemDetails(
    combo.items
      .map((i) => {
        const product = byId.get(String(i.productId));
        return product ? { product, quantity: i.quantity } : null;
      })
      .filter((x): x is { product: typeof members[number]; quantity: number } => x !== null)
  );
  res.status(statusCode).json({ success: true, message, data: toComboResponse(combo, { memberDetails: details }) });
};

// @desc    List combos with filters/sort/pagination
// @route   GET /api/combos
// @access  combos.view
export const getCombos = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const status = queryString(req.query.status);
  const categoryId = queryString(req.query.categoryId);
  const sort = queryString(req.query.sort) || "displayOrder";

  const filter: Record<string, unknown> = {};
  if (status) {
    assertStatus(status);
    filter.status = status;
  }
  if (categoryId) {
    assertObjectId(categoryId, "category ID");
    filter.categoryId = new mongoose.Types.ObjectId(categoryId);
  }
  if (isNonEmptyString(search)) {
    filter.comboTitle = new RegExp(escapeRegex(search.trim()), "i");
  }
  if (!SORTS[sort]) {
    throw new AppError(`sort must be one of: ${Object.keys(SORTS).join(", ")}`, 400);
  }

  const [combos, total] = await Promise.all([
    Combo.find(filter).sort(SORTS[sort]).skip(skip).limit(limit),
    Combo.countDocuments(filter),
  ]);

  const productIds = [...new Set(combos.flatMap((c) => c.items.map((i) => String(i.productId))))];
  const products = await Product.find({ _id: { $in: productIds } });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const data = combos.map((combo) => {
    const details = toComboItemDetails(
      combo.items
        .map((i) => {
          const product = byId.get(String(i.productId));
          return product ? { product, quantity: i.quantity } : null;
        })
        .filter((x): x is { product: typeof products[number]; quantity: number } => x !== null)
    );
    return toComboResponse(combo, { memberDetails: details });
  });

  res.status(200).json({
    success: true,
    message: "Combos fetched successfully",
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    Get one combo by ID or slug
// @route   GET /api/combos/:id
// @access  combos.view
export const getCombo = async (req: Request, res: Response) => {
  const idOrSlug = String(req.params.id);
  const combo = mongoose.isValidObjectId(idOrSlug)
    ? await Combo.findById(idOrSlug)
    : await Combo.findOne({ slug: idOrSlug.toLowerCase() });
  if (!combo) throw new AppError("Combo not found", 404);
  await respondWithCombo(res, combo);
};

// @desc    Create a combo
// @route   POST /api/combos
// @access  combos.create
export const createCombo = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  for (const field of ["comboTitle", "comboPrice", "thumbnail", "items"]) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw new AppError(`${field} is required`, 400);
    }
  }
  const fields = await parseComboFields(body);
  validateComboRules(fields);

  if (!fields.items) throw new AppError("items is required", 400);
  await assertComboProducts(fields.items);

  const slug = isNonEmptyString(body.slug)
    ? await resolveComboSlug(body.slug)
    : await uniqueSlug(Combo, slugify(fields.comboTitle || "combo") || "combo");

  if (fields.displayOrder === undefined) {
    const last = await Combo.findOne().sort({ displayOrder: -1 }).select("displayOrder");
    fields.displayOrder = last ? last.displayOrder + 1 : 0;
  }

  const combo = await Combo.create({
    ...fields,
    slug,
    status: fields.status || "ACTIVE",
    gallery: fields.gallery || [],
    description: fields.description || "",
    categoryId: fields.categoryId ?? null,
    startsAt: fields.startsAt ?? null,
    endsAt: fields.endsAt ?? null,
  });

  await logActivity(req, {
    action: "COMBO_CREATED",
    newValue: { _id: combo._id, comboTitle: combo.comboTitle, comboPrice: combo.comboPrice },
  });

  await respondWithCombo(res, combo, 201, "Combo created successfully");
};

// @desc    Update a combo (send only the fields to change)
// @route   PATCH /api/combos/:id
// @access  combos.update
export const updateCombo = async (req: Request, res: Response) => {
  const combo = await findComboOr404(req.params.id);
  const body = (req.body || {}) as Body;
  const fields = await parseComboFields(body);

  if (fields.items) {
    await assertComboProducts(fields.items);
  }

  const merged = {
    startsAt: fields.startsAt !== undefined ? fields.startsAt : combo.startsAt,
    endsAt: fields.endsAt !== undefined ? fields.endsAt : combo.endsAt,
  };
  validateComboRules(merged);

  if (isNonEmptyString(body.slug) && slugify(body.slug) !== combo.slug) {
    const slug = await resolveComboSlug(body.slug, combo._id);
    combo.slug = slug;
  }

  const oldValue = { comboTitle: combo.comboTitle, comboPrice: combo.comboPrice, status: combo.status };
  combo.set(fields);
  await combo.save();

  await logActivity(req, {
    action: "COMBO_UPDATED",
    oldValue,
    newValue: { comboTitle: combo.comboTitle, comboPrice: combo.comboPrice, status: combo.status },
  });

  await respondWithCombo(res, combo, 200, "Combo updated successfully");
};

// @desc    Activate or deactivate a combo
// @route   PATCH /api/combos/:id/status
// @access  combos.update
export const updateComboStatus = async (req: Request, res: Response) => {
  const combo = await findComboOr404(req.params.id);
  const { status } = (req.body || {}) as Body;
  assertStatus(status);
  if (combo.status === status) throw new AppError(`Combo is already ${status}`, 400);

  const oldValue = { status: combo.status };
  combo.status = status;
  await combo.save();

  await logActivity(req, {
    action: "COMBO_STATUS_CHANGED",
    oldValue,
    newValue: { status: combo.status },
  });

  await respondWithCombo(
    res,
    combo,
    200,
    `Combo ${status === "ACTIVE" ? "activated" : "deactivated"} successfully`
  );
};

// @desc    Set the display order (first ID shows first)
// @route   PATCH /api/combos/reorder
// @access  combos.update
export const reorderCombos = async (req: Request, res: Response) => {
  const { ids } = (req.body || {}) as Body;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError('Send "ids": an array of combo IDs in the new order', 400);
  }
  ids.forEach((id) => assertObjectId(id, "combo ID"));
  if (new Set(ids).size !== ids.length) throw new AppError("Combo IDs must not repeat", 400);

  const found = await Combo.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) throw new AppError("One or more combos were not found", 404);

  await Combo.bulkWrite(
    ids.map((id: string, index: number) => ({
      updateOne: { filter: { _id: id }, update: { $set: { displayOrder: index } } },
    }))
  );

  await logActivity(req, {
    action: "COMBO_REORDERED",
    newValue: { count: ids.length },
  });

  const combos = await Combo.find({ _id: { $in: ids } }).sort({ displayOrder: 1 });
  res.status(200).json({ success: true, message: "Combo order updated", data: combos });
};

// @desc    Delete a combo (combos that were ordered are deactivated instead)
// @route   DELETE /api/combos/:id
// @access  combos.delete
export const deleteCombo = async (req: Request, res: Response) => {
  const combo = await findComboOr404(req.params.id);

  if (await OrderItem.exists({ comboId: combo._id })) {
    combo.status = "INACTIVE";
    await combo.save();
    await logActivity(req, {
      action: "COMBO_DELETED",
      oldValue: { comboTitle: combo.comboTitle },
      newValue: { softDeleted: true },
    });
    return res.status(200).json({
      success: true,
      message: "Combo has orders, so it was deactivated instead of deleted",
      data: { _id: combo._id, comboTitle: combo.comboTitle, deleted: false },
    });
  }

  await combo.deleteOne();
  await logActivity(req, {
    action: "COMBO_DELETED",
    oldValue: { _id: combo._id, comboTitle: combo.comboTitle },
    newValue: { deleted: true },
  });

  return res.status(200).json({
    success: true,
    message: "Combo deleted successfully",
    data: { _id: combo._id, comboTitle: combo.comboTitle, deleted: true },
  });
};

// @desc    Add a gallery image (admin uploads image first, then POSTs its URL)
// @route   POST /api/combos/:id/gallery
// @access  combos.update
export const addComboGalleryImage = async (req: Request, res: Response) => {
  const combo = await findComboOr404(req.params.id);
  const { url } = (req.body || {}) as Body;
  if (!isValidImageUrl(url)) throw new AppError("A valid image URL is required", 400);
  if (combo.gallery.length >= COMBO_LIMITS.GALLERY_MAX) {
    throw new AppError(`Gallery can have at most ${COMBO_LIMITS.GALLERY_MAX} images`, 400);
  }
  if (combo.gallery.includes(url.trim())) {
    throw new AppError("This image is already in the gallery", 409);
  }
  combo.gallery = [...combo.gallery, url.trim()];
  await combo.save();
  await respondWithCombo(res, combo, 201, "Gallery image added");
};

// @desc    Remove a gallery image by URL
// @route   DELETE /api/combos/:id/gallery
// @access  combos.update
export const removeComboGalleryImage = async (req: Request, res: Response) => {
  const combo = await findComboOr404(req.params.id);
  const { url } = (req.body || {}) as Body;
  if (typeof url !== "string" || !url.trim()) {
    throw new AppError("Image URL is required", 400);
  }
  if (!combo.gallery.includes(url.trim())) {
    throw new AppError("Image not found in gallery", 404);
  }
  combo.gallery = combo.gallery.filter((entry) => entry !== url.trim());
  await combo.save();
  await respondWithCombo(res, combo, 200, "Gallery image removed");
};

// @desc    Replace the combo thumbnail
// @route   POST /api/combos/:id/image
// @access  combos.update
export const updateComboThumbnail = async (req: Request, res: Response) => {
  const combo = await findComboOr404(req.params.id);
  const { url } = (req.body || {}) as Body;
  if (!isValidImageUrl(url)) throw new AppError("A valid image URL is required", 400);
  combo.thumbnail = url.trim();
  await combo.save();
  await respondWithCombo(res, combo, 200, "Thumbnail updated");
};

const parseIdList = (value: unknown, label: string): mongoose.Types.ObjectId[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(`${label} must be a non-empty array of IDs`, 400);
  }
  const unique = [...new Set(value.map((v: unknown) => String(v)))];
  unique.forEach((id) => assertObjectId(id, label));
  if (unique.length > 200) throw new AppError(`${label} can have at most 200 items`, 400);
  return unique.map((id) => new mongoose.Types.ObjectId(id));
};

// @desc    Activate multiple combos at once
// @route   POST /api/combos/bulk-activate
// @access  combos.update
export const bulkActivateCombos = async (req: Request, res: Response) => {
  const ids = parseIdList((req.body || {}).ids, "Combo IDs");
  const result = await Combo.updateMany({ _id: { $in: ids } }, { $set: { status: "ACTIVE" } });
  await logActivity(req, {
    action: "COMBO_STATUS_CHANGED",
    newValue: { bulk: true, status: "ACTIVE", requested: ids.length, modified: result.modifiedCount },
  });
  res.status(200).json({
    success: true,
    message: "Combos activated",
    data: { requested: ids.length, matched: result.matchedCount, modified: result.modifiedCount },
  });
};

// @desc    Deactivate multiple combos at once
// @route   POST /api/combos/bulk-deactivate
// @access  combos.update
export const bulkDeactivateCombos = async (req: Request, res: Response) => {
  const ids = parseIdList((req.body || {}).ids, "Combo IDs");
  const result = await Combo.updateMany({ _id: { $in: ids } }, { $set: { status: "INACTIVE" } });
  await logActivity(req, {
    action: "COMBO_STATUS_CHANGED",
    newValue: { bulk: true, status: "INACTIVE", requested: ids.length, modified: result.modifiedCount },
  });
  res.status(200).json({
    success: true,
    message: "Combos deactivated",
    data: { requested: ids.length, matched: result.matchedCount, modified: result.modifiedCount },
  });
};

// @desc    Delete multiple combos (deactivates any that have orders)
// @route   POST /api/combos/bulk-delete
// @access  combos.delete
export const bulkDeleteCombos = async (req: Request, res: Response) => {
  const ids = parseIdList((req.body || {}).ids, "Combo IDs");

  const withOrders = await OrderItem.distinct("comboId", { comboId: { $in: ids } });
  const safeToDelete = ids.filter((id) => !withOrders.some((o) => String(o) === String(id)));

  await Combo.updateMany(
    { _id: { $in: withOrders } },
    { $set: { status: "INACTIVE" } }
  );
  const removed = await Combo.deleteMany({ _id: { $in: safeToDelete } });

  await logActivity(req, {
    action: "COMBO_DELETED",
    newValue: {
      bulk: true,
      requested: ids.length,
      deleted: removed.deletedCount,
      deactivated: withOrders.length,
    },
  });

  res.status(200).json({
    success: true,
    message: "Bulk delete processed",
    data: {
      requested: ids.length,
      deleted: removed.deletedCount,
      deactivatedBecauseOfOrders: withOrders.length,
    },
  });
};

// @desc    Analytics for one combo (views, sold count, revenue)
// @route   GET /api/combos/:id/stats
// @access  combos.view
export const getComboStats = async (req: Request, res: Response) => {
  const combo = await findComboOr404(req.params.id);
  res.status(200).json({
    success: true,
    message: "Combo stats fetched",
    data: {
      _id: combo._id,
      comboTitle: combo.comboTitle,
      views: combo.views,
      soldCount: combo.soldCount,
      revenue: combo.revenue,
    },
  });
};

// @desc    Overall combo analytics (totals + top performers)
// @route   GET /api/combos/stats/summary
// @access  combos.view
export const getCombosStatsSummary = async (_req: Request, res: Response) => {
  const [agg] = await Combo.aggregate<{
    totalRevenue: number;
    totalSold: number;
    totalViews: number;
    totalCombos: number;
  }>([
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: "$revenue" },
        totalSold: { $sum: "$soldCount" },
        totalViews: { $sum: "$views" },
        totalCombos: { $sum: 1 },
      },
    },
  ]);

  const topPerformers = await Combo.find()
    .sort({ revenue: -1, soldCount: -1 })
    .limit(5)
    .select("_id comboTitle slug comboPrice soldCount revenue thumbnail");

  res.status(200).json({
    success: true,
    message: "Combo stats summary fetched",
    data: {
      totals: agg || { totalRevenue: 0, totalSold: 0, totalViews: 0, totalCombos: 0 },
      topPerformers,
    },
  });
};

// @desc    Product picker for the combo form (returns active products matching a search)
// @route   GET /api/combos/products/picker
// @access  combos.view
export const comboProductPicker = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query, 200);
  const search = queryString(req.query.search);
  const filter: Record<string, unknown> = { status: "ACTIVE" };
  if (isNonEmptyString(search)) {
    filter.productTitle = new RegExp(escapeRegex(search.trim()), "i");
  }
  const products = await Product.find(filter)
    .select("_id productTitle slug thumbnail customerSellPrice customerSpecialPrice stock")
    .sort({ productTitle: 1 })
    .skip(skip)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: "Products fetched for combo picker",
    data: products.map((p) => ({
      _id: p._id,
      productTitle: p.productTitle,
      slug: p.slug,
      thumbnail: p.thumbnail,
      customerSellPrice: p.customerSellPrice,
      customerSpecialPrice: p.customerSpecialPrice,
      finalPrice: getFinalPrice(p),
      stock: p.stock,
    })),
    pagination: { page, limit },
  });
};
