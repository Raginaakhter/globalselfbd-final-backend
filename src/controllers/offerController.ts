import mongoose from "mongoose";
import type { Request, Response } from "express";
import Offer, {
  OFFER_DISCOUNT_TYPES,
  OFFER_LIMITS,
  OFFER_STATES,
  OFFER_STATUSES,
  isHexColor,
  offerState,
  type IOffer,
  type OfferDocument,
  type OfferState,
} from "../models/Offer";
import Category from "../models/Category";
import Product from "../models/Product";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import { isValidImageUrl } from "../utils/imageValidation";
import { slugify, isValidSlug, uniqueSlug } from "../utils/slugify";
import { getAuthUser } from "../middleware/auth";
import { roundMoney } from "../utils/checkout";
import {
  assertObjectId,
  escapeRegex,
  getPagination,
  isNonEmptyString,
  queryString,
} from "../utils/validators";

type Body = Record<string, unknown>;

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  displayOrder: { displayOrder: 1, createdAt: -1 },
  endingSoon: { endsAt: 1 },
};

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const parseDate = (value: unknown, label: string): Date | undefined => {
  if (value === undefined) return undefined;
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new AppError(`${label} must be a valid date`, 400);
  return date;
};

const parseIdList = (value: unknown, label: string, max: number): mongoose.Types.ObjectId[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AppError(`${label} must be an array of IDs`, 400);
  const unique = [...new Set(value.map((v) => String(v)))];
  unique.forEach((id) => assertObjectId(id, label));
  if (unique.length > max) throw new AppError(`${label} can have at most ${max} items`, 400);
  return unique.map((id) => new mongoose.Types.ObjectId(id));
};

interface ParsedOffer {
  title?: string;
  description?: string;
  bannerImage?: string | null;
  badgeColor?: string | null;
  badgeLabel?: string;
  discountType?: "PERCENTAGE" | "FIXED";
  discountValue?: number;
  startsAt?: Date;
  endsAt?: Date;
  productIds?: mongoose.Types.ObjectId[];
  categoryIds?: mongoose.Types.ObjectId[];
  minOrderValue?: number | null;
  status?: "ACTIVE" | "INACTIVE";
  displayOrder?: number;
}

const parseOfferFields = async (body: Body, existing?: OfferDocument): Promise<ParsedOffer> => {
  const out: ParsedOffer = {};

  if (body.title !== undefined || !existing) {
    if (!isNonEmptyString(body.title)) throw new AppError("Title is required", 400);
    const title = body.title.trim();
    if (title.length > OFFER_LIMITS.TITLE_MAX) {
      throw new AppError(`Title cannot exceed ${OFFER_LIMITS.TITLE_MAX} characters`, 400);
    }
    out.title = title;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      throw new AppError("Description must be text", 400);
    }
    const text = (body.description as string | null) || "";
    if (text.length > OFFER_LIMITS.DESCRIPTION_MAX) {
      throw new AppError(`Description cannot exceed ${OFFER_LIMITS.DESCRIPTION_MAX} characters`, 400);
    }
    out.description = text;
  }

  if (body.bannerImage !== undefined) {
    if (body.bannerImage === null || body.bannerImage === "") out.bannerImage = null;
    else if (!isValidImageUrl(body.bannerImage)) throw new AppError("Banner image must be a valid URL", 400);
    else out.bannerImage = body.bannerImage.trim();
  }

  if (body.badgeColor !== undefined) {
    if (body.badgeColor === null || body.badgeColor === "") out.badgeColor = null;
    else if (!isHexColor(body.badgeColor)) throw new AppError('Badge color must be a hex code like "#ff0040"', 400);
    else out.badgeColor = (body.badgeColor as string).trim();
  }

  if (body.badgeLabel !== undefined) {
    if (body.badgeLabel !== null && typeof body.badgeLabel !== "string") {
      throw new AppError("Badge label must be text", 400);
    }
    const label = (body.badgeLabel as string | null) || "";
    if (label.length > OFFER_LIMITS.BADGE_LABEL_MAX) {
      throw new AppError(`Badge label cannot exceed ${OFFER_LIMITS.BADGE_LABEL_MAX} characters`, 400);
    }
    out.badgeLabel = label.trim();
  }

  if (body.discountType !== undefined || !existing) {
    if (!oneOf(OFFER_DISCOUNT_TYPES, body.discountType)) {
      throw new AppError(`discountType must be one of: ${OFFER_DISCOUNT_TYPES.join(", ")}`, 400);
    }
    out.discountType = body.discountType;
  }

  if (body.discountValue !== undefined || !existing) {
    const n = typeof body.discountValue === "string" ? Number(body.discountValue) : body.discountValue;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new AppError("discountValue must be a number greater than 0", 400);
    }
    out.discountValue = roundMoney(n);
  }

  const startsAt = parseDate(body.startsAt, "Start date");
  const endsAt = parseDate(body.endsAt, "End date");
  if (startsAt) out.startsAt = startsAt;
  if (endsAt) out.endsAt = endsAt;
  if (!existing && (!startsAt || !endsAt)) {
    throw new AppError("Start date and end date are required", 400);
  }

  const productIds = parseIdList(body.productIds, "Product ID", OFFER_LIMITS.MAX_PRODUCTS);
  if (productIds) out.productIds = productIds;
  const categoryIds = parseIdList(body.categoryIds, "Category ID", OFFER_LIMITS.MAX_CATEGORIES);
  if (categoryIds) out.categoryIds = categoryIds;

  if (body.minOrderValue !== undefined) {
    if (body.minOrderValue === null || body.minOrderValue === "") out.minOrderValue = null;
    else {
      const n = typeof body.minOrderValue === "string" ? Number(body.minOrderValue) : body.minOrderValue;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        throw new AppError("minOrderValue must be a non-negative number", 400);
      }
      out.minOrderValue = roundMoney(n);
    }
  }

  if (body.status !== undefined) {
    if (!oneOf(OFFER_STATUSES, body.status)) throw new AppError("status must be ACTIVE or INACTIVE", 400);
    out.status = body.status;
  }

  if (body.displayOrder !== undefined) {
    const n = typeof body.displayOrder === "string" ? Number(body.displayOrder) : body.displayOrder;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 99999) {
      throw new AppError("displayOrder must be a whole number between 0 and 99999", 400);
    }
    out.displayOrder = n;
  }

  // Rules that depend on multiple fields
  const merged = { ...(existing ? existing.toObject() : {}), ...out } as IOffer;
  if (merged.discountType === "PERCENTAGE" && merged.discountValue > 100) {
    throw new AppError("Percentage discount cannot be more than 100", 400);
  }
  if (merged.startsAt && merged.endsAt && merged.endsAt <= merged.startsAt) {
    throw new AppError("End date must be after the start date", 400);
  }
  if (
    (!merged.productIds || merged.productIds.length === 0) &&
    (!merged.categoryIds || merged.categoryIds.length === 0)
  ) {
    throw new AppError("Select at least one product or category for the offer", 400);
  }
  if (merged.productIds && merged.productIds.length > 0) {
    const count = await Product.countDocuments({ _id: { $in: merged.productIds } });
    if (count !== merged.productIds.length) {
      throw new AppError("One or more products were not found", 400);
    }
  }
  if (merged.categoryIds && merged.categoryIds.length > 0) {
    const count = await Category.countDocuments({ _id: { $in: merged.categoryIds } });
    if (count !== merged.categoryIds.length) {
      throw new AppError("One or more categories were not found", 400);
    }
  }

  return out;
};

const toResponse = (offer: OfferDocument | (IOffer & { _id: mongoose.Types.ObjectId })) => {
  const o = "toObject" in offer ? offer.toObject() : offer;
  return { ...o, state: offerState(o as IOffer) };
};

const findOfferOr404 = async (id: unknown): Promise<OfferDocument> => {
  assertObjectId(id, "offer ID");
  const offer = await Offer.findById(id);
  if (!offer) throw new AppError("Offer not found", 404);
  return offer;
};

const stateFilter = (state: OfferState, now: Date): Record<string, unknown> => {
  switch (state) {
    case "INACTIVE":
      return { status: "INACTIVE" };
    case "ENDED":
      return { status: "ACTIVE", endsAt: { $lte: now } };
    case "SCHEDULED":
      return { status: "ACTIVE", startsAt: { $gt: now }, endsAt: { $gt: now } };
    default: // ACTIVE
      return { status: "ACTIVE", startsAt: { $lte: now }, endsAt: { $gt: now } };
  }
};

// @desc    List offer campaigns
// @route   GET /api/offers
// @access  offers.view
export const getOffers = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const state = queryString(req.query.status);
  const sort = queryString(req.query.sort) || "displayOrder";
  const now = new Date();

  const filter: Record<string, unknown> = {};
  if (state) {
    if (!oneOf(OFFER_STATES, state)) {
      throw new AppError(`status must be one of: ${OFFER_STATES.join(", ")}`, 400);
    }
    Object.assign(filter, stateFilter(state, now));
  }
  if (isNonEmptyString(search)) {
    filter.title = new RegExp(escapeRegex(search.trim()), "i");
  }
  if (!SORTS[sort]) {
    throw new AppError(`sort must be one of: ${Object.keys(SORTS).join(", ")}`, 400);
  }

  const [offers, total] = await Promise.all([
    Offer.find(filter).sort(SORTS[sort]).skip(skip).limit(limit).lean(),
    Offer.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Offers fetched successfully",
    data: offers.map((o) => toResponse(o as IOffer & { _id: mongoose.Types.ObjectId })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    Get one offer (with product/category names)
// @route   GET /api/offers/:id
// @access  offers.view
export const getOffer = async (req: Request, res: Response) => {
  const offer = await findOfferOr404(req.params.id);
  const [products, categories] = await Promise.all([
    Product.find({ _id: { $in: offer.productIds } })
      .select("_id productTitle slug thumbnail customerSellPrice customerSpecialPrice")
      .lean(),
    Category.find({ _id: { $in: offer.categoryIds } })
      .select("_id name slug status")
      .lean(),
  ]);

  res.status(200).json({
    success: true,
    message: "Offer fetched successfully",
    data: { ...toResponse(offer), products, categories },
  });
};

// @desc    Create an offer campaign
// @route   POST /api/offers
// @access  offers.create
export const createOffer = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const fields = await parseOfferFields(body);

  const slug = isNonEmptyString(body.slug)
    ? await (async () => {
        const s = slugify(body.slug);
        if (!s || !isValidSlug(s)) throw new AppError("Slug is invalid", 400);
        if (await Offer.exists({ slug: s })) throw new AppError(`Slug "${s}" is already in use`, 409);
        return s;
      })()
    : await uniqueSlug(Offer, slugify(fields.title || "offer") || "offer");

  if (fields.displayOrder === undefined) {
    const last = await Offer.findOne().sort({ displayOrder: -1 }).select("displayOrder");
    fields.displayOrder = last ? last.displayOrder + 1 : 0;
  }

  const offer = await Offer.create({
    ...fields,
    slug,
    status: fields.status || "ACTIVE",
    createdBy: getAuthUser(req)._id,
  });

  await logActivity(req, {
    action: "OFFER_CREATED",
    newValue: { _id: offer._id, title: offer.title, discountValue: offer.discountValue },
  });

  res.status(201).json({ success: true, message: "Offer created successfully", data: toResponse(offer) });
};

// @desc    Update an offer (send only the fields to change)
// @route   PATCH /api/offers/:id
// @access  offers.update
export const updateOffer = async (req: Request, res: Response) => {
  const offer = await findOfferOr404(req.params.id);
  const body = (req.body || {}) as Body;
  const fields = await parseOfferFields(body, offer);

  if (isNonEmptyString(body.slug) && slugify(body.slug) !== offer.slug) {
    const s = slugify(body.slug);
    if (!s || !isValidSlug(s)) throw new AppError("Slug is invalid", 400);
    if (await Offer.exists({ slug: s, _id: { $ne: offer._id } })) {
      throw new AppError(`Slug "${s}" is already in use`, 409);
    }
    offer.slug = s;
  }

  const oldValue = { title: offer.title, status: offer.status };
  offer.set(fields);
  await offer.save();

  await logActivity(req, {
    action: "OFFER_UPDATED",
    oldValue,
    newValue: { title: offer.title, status: offer.status },
  });

  res.status(200).json({ success: true, message: "Offer updated successfully", data: toResponse(offer) });
};

// @desc    Activate or deactivate an offer
// @route   PATCH /api/offers/:id/status
// @access  offers.update
export const updateOfferStatus = async (req: Request, res: Response) => {
  const offer = await findOfferOr404(req.params.id);
  const { status } = (req.body || {}) as Body;
  if (!oneOf(OFFER_STATUSES, status)) throw new AppError("status must be ACTIVE or INACTIVE", 400);
  if (offer.status === status) throw new AppError(`Offer is already ${status}`, 400);

  const oldValue = { status: offer.status };
  offer.status = status;
  await offer.save();
  await logActivity(req, {
    action: "OFFER_STATUS_CHANGED",
    oldValue,
    newValue: { status: offer.status },
  });

  res.status(200).json({
    success: true,
    message: `Offer ${status === "ACTIVE" ? "activated" : "deactivated"}`,
    data: toResponse(offer),
  });
};

// @desc    Delete an offer
// @route   DELETE /api/offers/:id
// @access  offers.delete
export const deleteOffer = async (req: Request, res: Response) => {
  const offer = await findOfferOr404(req.params.id);
  await offer.deleteOne();
  await logActivity(req, {
    action: "OFFER_DELETED",
    oldValue: { _id: offer._id, title: offer.title },
  });
  res.status(200).json({
    success: true,
    message: "Offer deleted successfully",
    data: { _id: offer._id, title: offer.title },
  });
};

// @desc    Add product(s) to an offer
// @route   POST /api/offers/:id/products
// @access  offers.update
export const addProductsToOffer = async (req: Request, res: Response) => {
  const offer = await findOfferOr404(req.params.id);
  const body = (req.body || {}) as Body;
  const incoming = body.productIds ?? (body.productId ? [body.productId] : undefined);
  const ids = parseIdList(incoming, "Product ID", OFFER_LIMITS.MAX_PRODUCTS);
  if (!ids || ids.length === 0) throw new AppError("No product IDs provided", 400);

  const found = await Product.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) throw new AppError("One or more products were not found", 400);

  const existing = new Set(offer.productIds.map(String));
  const merged = [...offer.productIds, ...ids.filter((id) => !existing.has(String(id)))];
  if (merged.length > OFFER_LIMITS.MAX_PRODUCTS) {
    throw new AppError(`An offer can have at most ${OFFER_LIMITS.MAX_PRODUCTS} products`, 400);
  }

  offer.productIds = merged;
  await offer.save();
  await logActivity(req, {
    action: "OFFER_PRODUCTS_UPDATED",
    newValue: { added: ids.length, total: offer.productIds.length },
  });

  res.status(200).json({
    success: true,
    message: "Products added to offer",
    data: toResponse(offer),
  });
};

// @desc    Remove one product from an offer
// @route   DELETE /api/offers/:id/products/:productId
// @access  offers.update
export const removeProductFromOffer = async (req: Request, res: Response) => {
  const offer = await findOfferOr404(req.params.id);
  assertObjectId(req.params.productId, "product ID");
  const before = offer.productIds.length;
  offer.productIds = offer.productIds.filter(
    (id) => String(id) !== String(req.params.productId)
  );
  if (offer.productIds.length === before) {
    throw new AppError("Product is not part of this offer", 404);
  }
  if (offer.productIds.length === 0 && offer.categoryIds.length === 0) {
    throw new AppError("Offer must include at least one product or category", 400);
  }
  await offer.save();
  await logActivity(req, {
    action: "OFFER_PRODUCTS_UPDATED",
    newValue: { removed: 1, total: offer.productIds.length },
  });
  res.status(200).json({ success: true, message: "Product removed from offer", data: toResponse(offer) });
};
