import type { Request, Response } from "express";
import { Types } from "mongoose";
import Coupon, {
  COUPON_CODE_REGEX,
  COUPON_SCOPES,
  COUPON_STATES,
  COUPON_STATUSES,
  DISCOUNT_TYPES,
  couponState,
  type CouponDocument,
  type CouponScope,
  type DiscountType,
  type ICoupon,
} from "../models/Coupon";
import Category from "../models/Category";
import Product from "../models/Product";
import AppError from "../utils/AppError";
import { getAuthUser } from "../middleware/auth";
import { assertObjectId, escapeRegex, getPagination, isNonEmptyString, queryString } from "../utils/validators";
import { loadCart, roundMoney } from "../utils/checkout";
import { evaluateCoupon, normalizeCouponCode } from "../utils/coupons";
import { calculateShippingCharge, getShippingConfig } from "../utils/shipping";
import type { ProductDocument } from "../models/Product";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

// Optional money/count field: undefined = not sent, null/"" = no limit
const optionalNumber = (value: unknown, label: string, { min, integer }: { min: number; integer?: boolean }): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new AppError(`${label} must be ${integer ? "a whole number" : "a number"} of at least ${min}`, 400);
  }
  return integer ? n : roundMoney(n);
};

const parseDate = (value: unknown, label: string): Date | undefined => {
  if (value === undefined) return undefined;
  const d = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) throw new AppError(`${label} must be a valid date`, 400);
  return d;
};

const parseIdList = (value: unknown, label: string): Types.ObjectId[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AppError(`${label} must be a list of IDs`, 400);
  const unique = [...new Set(value.map(String))];
  unique.forEach((id) => assertObjectId(id, label));
  if (unique.length > 200) throw new AppError(`${label} can have at most 200 items`, 400);
  return unique.map((id) => new Types.ObjectId(id));
};

// Read and check the form. `existing` is set for updates (only sent fields change).
const parseCoupon = async (body: Body, existing?: CouponDocument): Promise<Partial<ICoupon>> => {
  const data: Partial<ICoupon> = {};

  if (body.code !== undefined || !existing) {
    if (!isNonEmptyString(body.code)) throw new AppError("Coupon code is required", 400);
    const code = body.code.trim().toUpperCase();
    if (!COUPON_CODE_REGEX.test(code)) throw new AppError("Coupon code must be 3-30 letters, numbers, - or _ (e.g. SUMMER20)", 400);
    data.code = code;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") throw new AppError("Description must be text", 400);
    const text = (body.description ?? "").trim();
    if (text.length > 300) throw new AppError("Description cannot exceed 300 characters", 400);
    data.description = text;
  }
  if (body.discountType !== undefined || !existing) {
    if (!oneOf(DISCOUNT_TYPES, body.discountType)) throw new AppError(`Discount type must be one of: ${DISCOUNT_TYPES.join(", ")}`, 400);
    data.discountType = body.discountType;
  }
  if (body.discountValue !== undefined || !existing) {
    const v = optionalNumber(body.discountValue, "Discount value", { min: 0.01 });
    if (v == null) throw new AppError("Discount value is required", 400);
    data.discountValue = v;
  }
  const minOrderAmount = optionalNumber(body.minOrderAmount, "Min order amount", { min: 0 });
  if (minOrderAmount !== undefined) data.minOrderAmount = minOrderAmount || null;
  const maxDiscount = optionalNumber(body.maxDiscount, "Max discount cap", { min: 1 });
  if (maxDiscount !== undefined) data.maxDiscount = maxDiscount;
  const usageLimit = optionalNumber(body.usageLimit, "Total usage limit", { min: 1, integer: true });
  if (usageLimit !== undefined) data.usageLimit = usageLimit;
  const perUserLimit = optionalNumber(body.perUserLimit, "Per-user usage limit", { min: 1, integer: true });
  if (perUserLimit !== undefined) data.perUserLimit = perUserLimit;

  if (body.scope !== undefined) {
    if (!oneOf(COUPON_SCOPES, body.scope)) throw new AppError(`Scope must be one of: ${COUPON_SCOPES.join(", ")}`, 400);
    data.scope = body.scope;
  }
  const categoryIds = parseIdList(body.categoryIds, "Category ID");
  if (categoryIds) data.categoryIds = categoryIds;
  const productIds = parseIdList(body.productIds, "Product ID");
  if (productIds) data.productIds = productIds;

  const startsAt = parseDate(body.startsAt, "Start date");
  const expiresAt = parseDate(body.expiresAt, "Expiry date");
  if (!existing && (!startsAt || !expiresAt)) throw new AppError("Start date and expiry date are required", 400);
  if (startsAt) data.startsAt = startsAt;
  if (expiresAt) data.expiresAt = expiresAt;

  if (body.status !== undefined) {
    if (!oneOf(COUPON_STATUSES, body.status)) throw new AppError("status must be ACTIVE or INACTIVE", 400);
    data.status = body.status;
  }

  // Rules that depend on several fields: check the final values
  const final = { ...(existing ? existing.toObject() : {}), ...data } as ICoupon;
  if (final.discountType === "PERCENTAGE" && final.discountValue > 100) throw new AppError("Percentage discount cannot be more than 100", 400);
  if (final.expiresAt <= final.startsAt) throw new AppError("Expiry date must be after the start date", 400);
  const scope: CouponScope = final.scope || "ENTIRE_ORDER";
  if (scope === "CATEGORIES") {
    const ids = final.categoryIds || [];
    if (!ids.length) throw new AppError("Select at least one category for this coupon", 400);
    if ((await Category.countDocuments({ _id: { $in: ids } })) !== ids.length) throw new AppError("One or more categories were not found", 400);
  }
  if (scope === "PRODUCTS") {
    const ids = final.productIds || [];
    if (!ids.length) throw new AppError("Select at least one product for this coupon", 400);
    if ((await Product.countDocuments({ _id: { $in: ids } })) !== ids.length) throw new AppError("One or more products were not found", 400);
  }
  // Keep only the list the scope uses
  if (data.scope || data.categoryIds || data.productIds) {
    data.categoryIds = scope === "CATEGORIES" ? final.categoryIds : [];
    data.productIds = scope === "PRODUCTS" ? final.productIds : [];
  }
  return data;
};

const toResponse = (c: CouponDocument | (ICoupon & { _id: Types.ObjectId })) => {
  const obj = "toObject" in c ? c.toObject() : c;
  return { ...obj, state: couponState(obj), remainingUses: obj.usageLimit == null ? null : Math.max(obj.usageLimit - obj.usedCount, 0) };
};

const findCouponOr404 = async (id: unknown): Promise<CouponDocument> => {
  assertObjectId(id, "Coupon ID");
  const coupon = await Coupon.findById(id);
  if (!coupon) throw new AppError("Coupon not found", 404);
  return coupon;
};

const duplicateCode = (error: unknown) => {
  if ((error as { code?: number }).code === 11000) throw new AppError("A coupon with this code already exists", 409);
  throw error;
};

// Filters for the list: state is worked out from status + dates + usage
const stateFilter = (state: string, now: Date): Record<string, unknown> => {
  switch (state) {
    case "INACTIVE":
      return { status: "INACTIVE" };
    case "EXPIRED":
      return { status: "ACTIVE", expiresAt: { $lte: now } };
    case "SCHEDULED":
      return { status: "ACTIVE", startsAt: { $gt: now }, expiresAt: { $gt: now } };
    case "USED_UP":
      return { status: "ACTIVE", startsAt: { $lte: now }, expiresAt: { $gt: now }, $expr: { $and: [{ $ne: ["$usageLimit", null] }, { $gte: ["$usedCount", "$usageLimit"] }] } };
    default: // ACTIVE
      return { status: "ACTIVE", startsAt: { $lte: now }, expiresAt: { $gt: now }, $expr: { $or: [{ $eq: ["$usageLimit", null] }, { $lt: ["$usedCount", "$usageLimit"] }] } };
  }
};

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  expiring: { expiresAt: 1 },
  mostUsed: { usedCount: -1, createdAt: -1 },
  code: { code: 1 },
};

// @desc    List coupons (search, state/type filters, sort, pagination)
// @route   GET /api/coupons
// @access  coupons.view
export const getCoupons = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const state = queryString(req.query.status);
  const discountType = queryString(req.query.discountType);
  const sort = queryString(req.query.sort) || "newest";
  const now = new Date();

  const filter: Record<string, unknown> = {};
  if (state) {
    if (!oneOf(COUPON_STATES, state)) throw new AppError(`status must be one of: ${COUPON_STATES.join(", ")}`, 400);
    Object.assign(filter, stateFilter(state, now));
  }
  if (discountType) {
    if (!oneOf(DISCOUNT_TYPES, discountType)) throw new AppError(`discountType must be one of: ${DISCOUNT_TYPES.join(", ")}`, 400);
    filter.discountType = discountType;
  }
  if (isNonEmptyString(search)) {
    const re = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ code: re }, { description: re }];
  }
  if (!SORTS[sort]) throw new AppError(`sort must be one of: ${Object.keys(SORTS).join(", ")}`, 400);

  const [coupons, total] = await Promise.all([
    Coupon.find(filter).sort(SORTS[sort]).skip(skip).limit(limit).lean(),
    Coupon.countDocuments(filter),
  ]);
  res.status(200).json({
    success: true,
    message: "Coupons fetched successfully",
    data: coupons.map(toResponse),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    One coupon with the names of its categories/products
// @route   GET /api/coupons/:id
// @access  coupons.view
export const getCoupon = async (req: Request, res: Response) => {
  const coupon = await findCouponOr404(req.params.id);
  const [categories, products] = await Promise.all([
    Category.find({ _id: { $in: coupon.categoryIds } }).select("name slug").lean(),
    Product.find({ _id: { $in: coupon.productIds } }).select("productTitle slug thumbnail").lean(),
  ]);
  res.status(200).json({ success: true, message: "Coupon fetched successfully", data: { ...toResponse(coupon), categories, products } });
};

// @desc    Create a coupon
// @route   POST /api/coupons
// @access  coupons.create
export const createCoupon = async (req: Request, res: Response) => {
  const data = await parseCoupon((req.body || {}) as Body);
  const coupon = await Coupon.create({ ...data, createdBy: getAuthUser(req)._id }).catch(duplicateCode);
  res.status(201).json({ success: true, message: "Coupon created successfully", data: toResponse(coupon as CouponDocument) });
};

// @desc    Edit a coupon (send only the fields to change)
// @route   PUT /api/coupons/:id
// @access  coupons.update
export const updateCoupon = async (req: Request, res: Response) => {
  const coupon = await findCouponOr404(req.params.id);
  const body = (req.body || {}) as Body;
  if (!Object.keys(body).length) throw new AppError("Nothing to update", 400);
  if (body.code !== undefined && coupon.usedCount > 0 && String(body.code).trim().toUpperCase() !== coupon.code) {
    throw new AppError("The code of a coupon that has been used cannot be changed. Create a new coupon instead", 409);
  }
  const data = await parseCoupon(body, coupon);
  coupon.set(data);
  await coupon.save().catch(duplicateCode);
  res.status(200).json({ success: true, message: "Coupon updated successfully", data: toResponse(coupon) });
};

// @desc    Turn a coupon on or off
// @route   PATCH /api/coupons/:id/status
// @access  coupons.update
export const updateCouponStatus = async (req: Request, res: Response) => {
  const { status } = (req.body || {}) as Body;
  if (!oneOf(COUPON_STATUSES, status)) throw new AppError("status must be ACTIVE or INACTIVE", 400);
  const coupon = await findCouponOr404(req.params.id);
  coupon.status = status;
  await coupon.save();
  res.status(200).json({ success: true, message: `Coupon ${status === "ACTIVE" ? "activated" : "deactivated"}`, data: toResponse(coupon) });
};

// @desc    Delete a coupon (orders that used it keep the code and discount)
// @route   DELETE /api/coupons/:id
// @access  coupons.delete
export const deleteCoupon = async (req: Request, res: Response) => {
  const coupon = await findCouponOr404(req.params.id);
  await coupon.deleteOne();
  res.status(200).json({ success: true, message: "Coupon deleted successfully", data: { _id: coupon._id, code: coupon.code } });
};

// @desc    Check a coupon against my cart before placing the order
// @route   POST /api/coupons/apply   { code, city? }
// @access  cart.manage (logged-in customer)
export const applyCoupon = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const code = normalizeCouponCode(body.code);
  if (!code) throw new AppError("Please enter a coupon code", 400);
  const customer = getAuthUser(req);

  const { lines } = await loadCart(customer._id);
  // Coupons apply to product lines only; combo lines are excluded
  const usable = lines.filter((l) => !l.issue && l.product && l.item.productId);
  if (!usable.length) throw new AppError("Your cart is empty", 400);
  const subtotal = roundMoney(usable.reduce((sum, l) => sum + l.item.subtotal, 0));
  const applied = await evaluateCoupon(
    code,
    customer._id,
    usable.map(({ item, product }) => ({
      productId: item.productId as Types.ObjectId,
      categoryId: (product as ProductDocument).categoryId,
      subtotal: item.subtotal,
    })),
    subtotal
  );

  // With the city the full total is shown too
  const city = isNonEmptyString(body.city) ? body.city.trim() : null;
  const shippingCost = city ? calculateShippingCharge(await getShippingConfig(), city, subtotal - applied.discount) : null;

  res.status(200).json({
    success: true,
    message: `Coupon applied: you save ৳${applied.discount.toLocaleString("en-US")}`,
    data: {
      code: applied.code,
      description: applied.coupon.description,
      discountType: applied.coupon.discountType as DiscountType,
      discountValue: applied.coupon.discountValue,
      scope: applied.coupon.scope,
      subtotal,
      eligibleSubtotal: applied.eligibleSubtotal,
      discount: applied.discount,
      shippingCost,
      totalAmount: shippingCost == null ? null : roundMoney(subtotal - applied.discount + shippingCost),
    },
  });
};
