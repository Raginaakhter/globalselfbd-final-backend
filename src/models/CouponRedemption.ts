import { Schema, model, type Types } from "mongoose";

// One row per order that used a coupon. Used for the per-customer limit.
// When the order is cancelled the row is released and the coupon use is given back.
export interface ICouponRedemption {
  couponId: Types.ObjectId;
  customerId: Types.ObjectId;
  orderId: Types.ObjectId;
  discount: number;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const couponRedemptionSchema = new Schema<ICouponRedemption>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
    discount: { type: Number, required: true, min: 0 },
    releasedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

couponRedemptionSchema.index({ couponId: 1, customerId: 1, releasedAt: 1 });

const CouponRedemption = model<ICouponRedemption>("CouponRedemption", couponRedemptionSchema);
export default CouponRedemption;
