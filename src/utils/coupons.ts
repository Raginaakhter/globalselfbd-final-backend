import type { ClientSession, Types } from "mongoose";
import Coupon, { COUPON_CODE_REGEX, couponState, type CouponDocument } from "../models/Coupon";
import CouponRedemption from "../models/CouponRedemption";
import AppError from "./AppError";
import { getAncestry, loadCategoryMap } from "./categoryTree";

const roundMoney = (n: number): number => Math.round(n * 100) / 100;
const taka = (n: number) => `৳${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export const normalizeCouponCode = (code: unknown): string | null => {
  if (code === undefined || code === null || code === "") return null;
  if (typeof code !== "string") throw new AppError("Coupon code must be text", 400);
  const clean = code.trim().toUpperCase();
  if (!clean) return null;
  if (!COUPON_CODE_REGEX.test(clean)) throw new AppError("Invalid coupon code", 400);
  return clean;
};

// A cart line as the coupon sees it
export interface CouponLine {
  productId: Types.ObjectId;
  categoryId: Types.ObjectId;
  subtotal: number;
}

export interface AppliedCoupon {
  coupon: CouponDocument;
  code: string;
  // Part of the cart the coupon counts (all items for ENTIRE_ORDER)
  eligibleSubtotal: number;
  discount: number;
}

const MESSAGES: Record<string, string> = {
  INACTIVE: "This coupon is not active",
  SCHEDULED: "This coupon is not valid yet",
  EXPIRED: "This coupon has expired",
  USED_UP: "This coupon has reached its usage limit",
};

// Customer's uses that still count (cancelled orders give the use back)
const usesByCustomer = (couponId: Types.ObjectId, customerId: Types.ObjectId, session?: ClientSession) =>
  CouponRedemption.countDocuments({ couponId, customerId, releasedAt: null }).session(session ?? null);

// Check a code against the cart and calculate the discount. Throws a clear message when it cannot be used.
export const evaluateCoupon = async (
  code: string,
  customerId: Types.ObjectId,
  lines: CouponLine[],
  subtotal: number
): Promise<AppliedCoupon> => {
  const coupon = await Coupon.findOne({ code });
  if (!coupon) throw new AppError("Invalid coupon code", 400);

  const state = couponState(coupon);
  if (state !== "ACTIVE") throw new AppError(MESSAGES[state], 400);

  if (coupon.perUserLimit != null && (await usesByCustomer(coupon._id, customerId)) >= coupon.perUserLimit) {
    throw new AppError(
      coupon.perUserLimit === 1 ? "You have already used this coupon" : `You can use this coupon only ${coupon.perUserLimit} times`,
      400
    );
  }

  if (coupon.minOrderAmount != null && subtotal < coupon.minOrderAmount) {
    throw new AppError(`Add ${taka(roundMoney(coupon.minOrderAmount - subtotal))} more to use this coupon (minimum order ${taka(coupon.minOrderAmount)})`, 400);
  }

  let eligible = lines;
  if (coupon.scope === "PRODUCTS") {
    const ids = new Set(coupon.productIds.map(String));
    eligible = lines.filter((l) => ids.has(String(l.productId)));
  } else if (coupon.scope === "CATEGORIES") {
    // A category also covers its sub-categories
    const ids = new Set(coupon.categoryIds.map(String));
    const map = await loadCategoryMap();
    eligible = lines.filter((l) => getAncestry(l.categoryId, map).some((c) => ids.has(String(c._id))));
  }
  const eligibleSubtotal = roundMoney(eligible.reduce((sum, l) => sum + l.subtotal, 0));
  if (eligibleSubtotal <= 0) throw new AppError("This coupon does not apply to the items in your cart", 400);

  let discount =
    coupon.discountType === "PERCENTAGE" ? (eligibleSubtotal * coupon.discountValue) / 100 : coupon.discountValue;
  if (coupon.maxDiscount != null) discount = Math.min(discount, coupon.maxDiscount);
  discount = roundMoney(Math.min(discount, eligibleSubtotal));

  return { coupon, code: coupon.code, eligibleSubtotal, discount };
};

// Inside the order transaction: count one use. The conditions are checked again atomically,
// so two customers can never go over the usage limit at the same moment.
export const claimCoupon = async (
  applied: AppliedCoupon,
  customerId: Types.ObjectId,
  orderId: Types.ObjectId,
  session: ClientSession
): Promise<void> => {
  const now = new Date();
  const claimed = await Coupon.findOneAndUpdate(
    {
      _id: applied.coupon._id,
      status: "ACTIVE",
      startsAt: { $lte: now },
      expiresAt: { $gt: now },
      $expr: { $or: [{ $eq: ["$usageLimit", null] }, { $lt: ["$usedCount", "$usageLimit"] }] },
    },
    { $inc: { usedCount: 1 } },
    { session, returnDocument: "after" }
  );
  if (!claimed) throw new AppError("This coupon can no longer be used. Please remove it and try again", 409);

  if (claimed.perUserLimit != null && (await usesByCustomer(claimed._id, customerId, session)) >= claimed.perUserLimit) {
    throw new AppError("You have already used this coupon", 409);
  }
  await CouponRedemption.create([{ couponId: claimed._id, customerId, orderId, discount: applied.discount }], { session });
};

// Inside the cancel transaction: give the use back (only once per order)
export const releaseCoupon = async (orderId: Types.ObjectId, session: ClientSession): Promise<void> => {
  const redemption = await CouponRedemption.findOneAndUpdate(
    { orderId, releasedAt: null },
    { $set: { releasedAt: new Date() } },
    { session }
  );
  if (redemption) {
    await Coupon.updateOne({ _id: redemption.couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
  }
};
