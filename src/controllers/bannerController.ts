import type { Request, Response } from "express";
import type { Types } from "mongoose";
import Banner, {
  BANNER_LIMITS,
  BANNER_PLACEMENTS,
  MAX_ACTIVE_PROMO,
  type BannerDocument,
  type BannerPlacement,
  type IBanner,
} from "../models/Banner";
import AppError from "../utils/AppError";
import { isValidImageUrl } from "../utils/imageValidation";
import {
  assertObjectId,
  assertStatus,
  optionalText,
  optionalLink,
  optionalInteger,
  queryString,
} from "../utils/validators";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const MAX_BANNERS = 20;
const SORT = { sortOrder: 1, createdAt: 1 } as const;

const isPlacement = (value: unknown): value is BannerPlacement =>
  typeof value === "string" && (BANNER_PLACEMENTS as readonly string[]).includes(value);

const findBannerOr404 = async (id: unknown): Promise<BannerDocument> => {
  assertObjectId(id, "banner ID");
  const banner = await Banner.findById(id);
  if (!banner) throw new AppError("Banner not found", 404);
  return banner;
};

// The landing page has room for MAX_ACTIVE_PROMO promo cards
const assertPromoSlotFree = async (excludeId?: Types.ObjectId): Promise<void> => {
  const filter: Record<string, unknown> = { placement: "PROMO", status: "ACTIVE" };
  if (excludeId) filter._id = { $ne: excludeId };
  if ((await Banner.countDocuments(filter)) >= MAX_ACTIVE_PROMO) {
    throw new AppError(
      `Only ${MAX_ACTIVE_PROMO} promo cards can be active at once. Deactivate one first, or save this one as INACTIVE`,
      409
    );
  }
};

// Read the banner fields that were sent; everything except the image is optional
const parseBannerFields = (body: Body): Partial<IBanner> => {
  const fields: Partial<IBanner> = {};

  if (body.placement !== undefined) {
    if (!isPlacement(body.placement)) throw new AppError("Placement must be HERO (big banner) or PROMO (promo card)", 400);
    fields.placement = body.placement;
  }
  if (body.imageUrl !== undefined) {
    if (!isValidImageUrl(body.imageUrl)) throw new AppError("Banner image must be a valid image URL", 400);
    fields.imageUrl = body.imageUrl.trim();
  }
  if (body.mobileImageUrl !== undefined) {
    if (body.mobileImageUrl === null || body.mobileImageUrl === "") fields.mobileImageUrl = "";
    else if (!isValidImageUrl(body.mobileImageUrl)) throw new AppError("Mobile image must be a valid image URL", 400);
    else fields.mobileImageUrl = body.mobileImageUrl.trim();
  }

  const title = optionalText(body.title, "Title", BANNER_LIMITS.TITLE_MAX);
  if (title !== undefined) fields.title = title;
  const subtitle = optionalText(body.subtitle, "Subtitle", BANNER_LIMITS.SUBTITLE_MAX);
  if (subtitle !== undefined) fields.subtitle = subtitle;
  const description = optionalText(body.description, "Description", BANNER_LIMITS.DESCRIPTION_MAX);
  if (description !== undefined) fields.description = description;
  const buttonText = optionalText(body.buttonText, "Button text", BANNER_LIMITS.BUTTON_TEXT_MAX);
  if (buttonText !== undefined) fields.buttonText = buttonText;
  const altText = optionalText(body.altText, "Alt text", BANNER_LIMITS.ALT_TEXT_MAX);
  if (altText !== undefined) fields.altText = altText;
  const buttonLink = optionalLink(body.buttonLink, "Button link");
  if (buttonLink !== undefined) fields.buttonLink = buttonLink;
  const sortOrder = optionalInteger(body.sortOrder, "Sort order", 0, 9999);
  if (sortOrder !== undefined) fields.sortOrder = sortOrder;

  if (body.status !== undefined) {
    assertStatus(body.status);
    fields.status = body.status;
  }
  return fields;
};

// ?placement=HERO|PROMO filter
const placementFilter = (req: Request): Record<string, unknown> => {
  const placement = queryString(req.query.placement);
  if (placement === undefined) return {};
  if (!isPlacement(placement)) throw new AppError("placement must be HERO or PROMO", 400);
  return { placement };
};

// @desc    List all banners and promo cards (active and inactive), in display order
// @route   GET /api/banners
// @access  banners.view
export const getBanners = async (req: Request, res: Response) => {
  const filter = placementFilter(req);
  const status = queryString(req.query.status);
  if (status) {
    assertStatus(status);
    filter.status = status;
  }
  const banners = await Banner.find(filter).sort(SORT);
  res.status(200).json({ success: true, message: "Banners fetched successfully", data: banners });
};

// @desc    Get one banner
// @route   GET /api/banners/:id
// @access  banners.view
export const getBanner = async (req: Request, res: Response) => {
  const banner = await findBannerOr404(req.params.id);
  res.status(200).json({ success: true, message: "Banner fetched successfully", data: banner });
};

// @desc    Create a big banner (HERO) or a promo card (PROMO); only imageUrl is required
// @route   POST /api/banners
// @access  banners.create
export const createBanner = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  if (body.imageUrl === undefined || body.imageUrl === null || body.imageUrl === "") {
    throw new AppError("Banner image is required (upload it first with /api/uploads/images?folder=banners)", 400);
  }
  const fields = parseBannerFields(body);
  const placement = fields.placement || "HERO";
  const status = fields.status || "ACTIVE";

  if ((await Banner.countDocuments()) >= MAX_BANNERS) {
    throw new AppError(`You can have at most ${MAX_BANNERS} banners. Delete an old one first`, 400);
  }
  if (placement === "PROMO" && status === "ACTIVE") await assertPromoSlotFree();

  // New items go to the end of their placement unless an order is given
  if (fields.sortOrder === undefined) {
    const last = await Banner.findOne({ placement }).sort({ sortOrder: -1 }).select("sortOrder");
    fields.sortOrder = last ? last.sortOrder + 1 : 0;
  }

  const banner = await Banner.create({ ...fields, placement, status });
  res.status(201).json({
    success: true,
    message: placement === "PROMO" ? "Promo card created successfully" : "Banner created successfully",
    data: banner,
  });
};

// @desc    Update a banner (send only the fields to change; "" clears a text field)
// @route   PUT /api/banners/:id
// @access  banners.update
export const updateBanner = async (req: Request, res: Response) => {
  const banner = await findBannerOr404(req.params.id);
  const body = (req.body || {}) as Body;
  if (body.imageUrl === null || body.imageUrl === "") {
    throw new AppError("Banner image cannot be removed. Send a new image URL instead", 400);
  }
  const fields = parseBannerFields(body);

  // Becoming an active promo card (moved to PROMO or re-activated) needs a free slot
  const nextPlacement = fields.placement || banner.placement;
  const nextStatus = fields.status || banner.status;
  const wasActivePromo = banner.placement === "PROMO" && banner.status === "ACTIVE";
  if (nextPlacement === "PROMO" && nextStatus === "ACTIVE" && !wasActivePromo) {
    await assertPromoSlotFree(banner._id);
  }

  banner.set(fields);
  await banner.save();
  res.status(200).json({ success: true, message: "Banner updated successfully", data: banner });
};

// @desc    Show or hide a banner on the landing page
// @route   PATCH /api/banners/:id/status
// @access  banners.update
export const updateBannerStatus = async (req: Request, res: Response) => {
  const banner = await findBannerOr404(req.params.id);
  const { status } = (req.body || {}) as Body;
  assertStatus(status);
  if (banner.status === status) throw new AppError(`Banner is already ${status}`, 400);
  if (status === "ACTIVE" && banner.placement === "PROMO") await assertPromoSlotFree(banner._id);

  banner.status = status;
  await banner.save();
  res.status(200).json({
    success: true,
    message: `Banner ${status === "ACTIVE" ? "activated" : "deactivated"} successfully`,
    data: banner,
  });
};

// @desc    Set the display order (first id shows first); order banners and promo cards separately
// @route   PATCH /api/banners/reorder
// @access  banners.update
export const reorderBanners = async (req: Request, res: Response) => {
  const { ids } = (req.body || {}) as Body;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError('Send "ids": an array of banner IDs in the new order', 400);
  }
  ids.forEach((id) => assertObjectId(id, "banner ID"));
  if (new Set(ids).size !== ids.length) throw new AppError("Banner IDs must not repeat", 400);

  const found = await Banner.find({ _id: { $in: ids } }).select("placement");
  if (found.length !== ids.length) throw new AppError("One or more banners were not found", 404);
  if (new Set(found.map((b) => b.placement)).size > 1) {
    throw new AppError("Reorder big banners (HERO) and promo cards (PROMO) separately", 400);
  }

  await Banner.bulkWrite(ids.map((id, index) => ({ updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index } } } })));
  const banners = await Banner.find({ placement: found[0].placement }).sort(SORT);
  res.status(200).json({ success: true, message: "Banner order updated", data: banners });
};

// @desc    Delete a banner
// @route   DELETE /api/banners/:id
// @access  banners.delete
export const deleteBanner = async (req: Request, res: Response) => {
  const banner = await findBannerOr404(req.params.id);
  await banner.deleteOne();
  res.status(200).json({ success: true, message: "Banner deleted successfully", data: { _id: banner._id } });
};

// @desc    Active banners and promo cards for the landing page (?placement=HERO|PROMO)
// @route   GET /api/public/banners
// @access  Public
export const getPublicBanners = async (req: Request, res: Response) => {
  const banners = await Banner.find({ ...placementFilter(req), status: "ACTIVE" })
    .sort({ placement: 1, ...SORT })
    .select("placement imageUrl mobileImageUrl title subtitle description buttonText buttonLink altText sortOrder");
  res.status(200).json({ success: true, message: "Banners fetched successfully", data: banners });
};
