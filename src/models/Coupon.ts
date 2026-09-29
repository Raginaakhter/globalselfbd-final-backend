import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const DISCOUNT_TYPES = ["PERCENTAGE", "FIXED"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

// Which items the discount is calculated on
export const COUPON_SCOPES = ["ENTIRE_ORDER", "CATEGORIES", "PRODUCTS"] as const;
export type CouponScope = (typeof COUPON_SCOPES)[number];

export const COUPON_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

// What customers and the admin list see: the saved status plus the dates and usage
export const COUPON_STATES = ["ACTIVE", "INACTIVE", "SCHEDULED", "EXPIRED", "USED_UP"] as const;
export type CouponState = (typeof COUPON_STATES)[number];

export const COUPON_CODE_REGEX = /^[A-Z0-9_-]{3,30}$/;

export interface ICoupon {
  code: string;
  description: string;
  discountType: DiscountType;
  // Percent (1-100) or taka amount
  discountValue: number;
  // Cart subtotal needed before the coupon works (null = no minimum)
  minOrderAmount: number | null;
  // Highest discount in taka, mainly for percentage coupons (null = no cap)
  maxDiscount: number | null;
  // Uses across all customers (null = unlimited)
  usageLimit: number | null;
  // Uses per customer (null = unlimited)
  perUserLimit: number | null;
  scope: CouponScope;
  categoryIds: Types.ObjectId[];
  productIds: Types.ObjectId[];
  startsAt: Date;
  expiresAt: Date;
  status: CouponStatus;
  // Orders currently using the coupon (a cancelled order gives its use back)
  usedCount: number;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CouponDocument = HydratedDocument<ICoupon>;

const couponSchema = new Schema<ICoupon>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 30 },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    discountType: { type: String, enum: DISCOUNT_TYPES, required: true },
    discountValue: { type: Number, required: true, min: 0 },
    minOrderAmount: { type: Number, min: 0, default: null },
    maxDiscount: { type: Number, min: 0, default: null },
    usageLimit: { type: Number, min: 1, default: null },
    perUserLimit: { type: Number, min: 1, default: null },
    scope: { type: String, enum: COUPON_SCOPES, default: "ENTIRE_ORDER" },
    categoryIds: [{ type: Schema.Types.ObjectId, ref: "Category" }],
    productIds: [{ type: Schema.Types.ObjectId, ref: "Product" }],
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    status: { type: String, enum: COUPON_STATUSES, default: "ACTIVE", index: true },
    usedCount: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
  }
);

couponSchema.index({ createdAt: -1 });

export const couponState = (c: Pick<ICoupon, "status" | "startsAt" | "expiresAt" | "usageLimit" | "usedCount">, now = new Date()): CouponState => {
  if (c.status === "INACTIVE") return "INACTIVE";
  if (c.expiresAt <= now) return "EXPIRED";
  if (c.startsAt > now) return "SCHEDULED";
  if (c.usageLimit != null && c.usedCount >= c.usageLimit) return "USED_UP";
  return "ACTIVE";
};

const Coupon = model<ICoupon>("Coupon", couponSchema);
export default Coupon;
