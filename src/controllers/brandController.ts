import type { Request, Response } from "express";
import type { Types } from "mongoose";
import Brand, { BRAND_LIMITS, type BrandDocument } from "../models/Brand";
import AppError from "../utils/AppError";
import { isValidImageUrl } from "../utils/imageValidation";
import { slugify, isValidSlug, uniqueSlug } from "../utils/slugify";
import {
  assertObjectId,
  assertStatus,
  escapeRegex,
  isNonEmptyString,
  optionalText,
  optionalLink,
  optionalInteger,
  queryString,
} from "../utils/validators";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const NAME_COLLATION = { locale: "en", strength: 2 };
const SORT = { sortOrder: 1, name: 1 } as const;

const findBrandOr404 = async (id: unknown): Promise<BrandDocument> => {
  assertObjectId(id, "brand ID");
  const brand = await Brand.findById(id);
  if (!brand) throw new AppError("Brand not found", 404);
  return brand;
};

const assertUniqueName = async (name: string, excludeId?: Types.ObjectId): Promise<void> => {
  const filter: Record<string, unknown> = { name };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Brand.findOne(filter).collation(NAME_COLLATION).select("_id")) {
    throw new AppError(`A brand named "${name}" already exists`, 409);
  }
};

const resolveSlug = async (rawSlug: unknown, excludeId?: Types.ObjectId): Promise<string> => {
  if (typeof rawSlug !== "string") throw new AppError("Slug must be a string", 400);
  const slug = slugify(rawSlug);
  if (!slug || !isValidSlug(slug)) throw new AppError("Slug is invalid", 400);
  const filter: Record<string, unknown> = { slug };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Brand.exists(filter)) throw new AppError(`Slug "${slug}" is already in use`, 409);
  return slug;
};

const parseBrandFields = (body: Body) => {
  const fields: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (!isNonEmptyString(body.name)) throw new AppError("Brand name is required", 400);
    if (body.name.trim().length > BRAND_LIMITS.NAME_MAX) {
      throw new AppError(`Brand name cannot exceed ${BRAND_LIMITS.NAME_MAX} characters`, 400);
    }
    fields.name = body.name.trim();
  }
  if (body.logoUrl !== undefined) {
    if (!isValidImageUrl(body.logoUrl)) throw new AppError("Brand logo must be a valid image URL", 400);
    fields.logoUrl = body.logoUrl.trim();
  }
  const description = optionalText(body.description, "Description", BRAND_LIMITS.DESCRIPTION_MAX);
  if (description !== undefined) fields.description = description;
  const link = optionalLink(body.link, "Link");
  if (link !== undefined) fields.link = link;
  const sortOrder = optionalInteger(body.sortOrder, "Sort order", 0, 9999);
  if (sortOrder !== undefined) fields.sortOrder = sortOrder;

  if (body.isFeatured !== undefined) {
    if (body.isFeatured !== true && body.isFeatured !== false) throw new AppError("isFeatured must be true or false", 400);
    fields.isFeatured = body.isFeatured;
  }
  if (body.status !== undefined) {
    assertStatus(body.status);
    fields.status = body.status;
  }
  return fields;
};

// @desc    List brands (search, filter by status/featured)
// @route   GET /api/brands
// @access  brands.view
export const getBrands = async (req: Request, res: Response) => {
  const filter: Record<string, unknown> = {};
  const status = queryString(req.query.status);
  const featured = queryString(req.query.featured);
  const search = queryString(req.query.search);
  if (status) {
    assertStatus(status);
    filter.status = status;
  }
  if (featured !== undefined) {
    if (featured !== "true" && featured !== "false") throw new AppError("featured must be true or false", 400);
    filter.isFeatured = featured === "true";
  }
  if (isNonEmptyString(search)) filter.name = new RegExp(escapeRegex(search.trim()), "i");

  const brands = await Brand.find(filter).sort(SORT);
  res.status(200).json({ success: true, message: "Brands fetched successfully", data: brands });
};

// @desc    Get one brand
// @route   GET /api/brands/:id
// @access  brands.view
export const getBrand = async (req: Request, res: Response) => {
  const brand = await findBrandOr404(req.params.id);
  res.status(200).json({ success: true, message: "Brand fetched successfully", data: brand });
};

// @desc    Add a brand (name and logo are required)
// @route   POST /api/brands
// @access  brands.create
export const createBrand = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  if (!isNonEmptyString(body.name)) throw new AppError("Brand name is required", 400);
  if (body.logoUrl === undefined || body.logoUrl === null || body.logoUrl === "") {
    throw new AppError("Brand logo is required (upload it first with /api/uploads/images?folder=brands)", 400);
  }
  const fields = parseBrandFields(body);
  await assertUniqueName(fields.name as string);

  fields.slug =
    body.slug !== undefined && body.slug !== null && body.slug !== ""
      ? await resolveSlug(body.slug)
      : await uniqueSlug(Brand, slugify(fields.name) || "brand");

  if (fields.sortOrder === undefined) {
    const last = await Brand.findOne().sort({ sortOrder: -1 }).select("sortOrder");
    fields.sortOrder = last ? last.sortOrder + 1 : 0;
  }

  const brand = await Brand.create(fields);
  res.status(201).json({ success: true, message: "Brand created successfully", data: brand });
};

// @desc    Edit a brand (send only the fields to change)
// @route   PUT /api/brands/:id
// @access  brands.update
export const updateBrand = async (req: Request, res: Response) => {
  const brand = await findBrandOr404(req.params.id);
  const body = (req.body || {}) as Body;
  if (body.logoUrl === null || body.logoUrl === "") {
    throw new AppError("Brand logo cannot be removed. Send a new logo URL instead", 400);
  }
  const fields = parseBrandFields(body);

  if (typeof fields.name === "string" && fields.name.toLowerCase() !== brand.name.toLowerCase()) {
    await assertUniqueName(fields.name, brand._id);
  }
  // Slug changes only when sent (keeps brand page URLs stable when renaming)
  if (body.slug !== undefined && body.slug !== null && body.slug !== "" && slugify(body.slug) !== brand.slug) {
    fields.slug = await resolveSlug(body.slug, brand._id);
  }

  brand.set(fields);
  await brand.save();
  res.status(200).json({ success: true, message: "Brand updated successfully", data: brand });
};

// @desc    Show or hide a brand
// @route   PATCH /api/brands/:id/status
// @access  brands.update
export const updateBrandStatus = async (req: Request, res: Response) => {
  const brand = await findBrandOr404(req.params.id);
  const { status } = (req.body || {}) as Body;
  assertStatus(status);
  if (brand.status === status) throw new AppError(`Brand is already ${status}`, 400);

  brand.status = status;
  await brand.save();
  res.status(200).json({
    success: true,
    message: `Brand ${status === "ACTIVE" ? "activated" : "deactivated"} successfully`,
    data: brand,
  });
};

// @desc    Delete a brand
// @route   DELETE /api/brands/:id
// @access  brands.delete
export const deleteBrand = async (req: Request, res: Response) => {
  const brand = await findBrandOr404(req.params.id);
  await brand.deleteOne();
  res.status(200).json({ success: true, message: "Brand deleted successfully", data: { _id: brand._id, name: brand.name } });
};

// @desc    Active brands for the landing page ("Shop Top Brands")
// @route   GET /api/public/brands?featured=true
// @access  Public
export const getPublicBrands = async (req: Request, res: Response) => {
  const filter: Record<string, unknown> = { status: "ACTIVE" };
  const featured = queryString(req.query.featured);
  if (featured === "true") filter.isFeatured = true;
  const brands = await Brand.find(filter).sort(SORT).select("name slug logoUrl description link isFeatured sortOrder");
  res.status(200).json({ success: true, message: "Brands fetched successfully", data: brands });
};
