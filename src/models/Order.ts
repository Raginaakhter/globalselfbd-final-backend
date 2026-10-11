import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import {
  ORDER_STATUS,
  ORDER_STATUSES,
  PAYMENT_STATUS,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  FULFILLMENT_METHODS,
  ADMIN_DISCOUNT_TYPES,
  type OrderStatus,
  type PaymentStatus,
  type PaymentMethod,
  type FulfillmentMethod,
  type AdminDiscountType,
} from "../config/orderOptions";

// Items are stored in OrderItem. There is intentionally no postal code field.
export interface IOrder {
  orderNumber: string;
  customerId: Types.ObjectId;
  // Money is always calculated by the backend
  subtotal: number;
  discount: number;
  // Coupon used on this order (the code is kept even if the coupon is later deleted)
  couponId: Types.ObjectId | null;
  couponCode: string | null;
  // How the customer receives the order; STORE_PICKUP forces shippingCost to 0.
  fulfillmentMethod: FulfillmentMethod;
  shippingCost: number;
  // Manual discount an admin applied at checkout (never for customers). The
  // *value* is what the admin typed (percent or fixed taka); the *amount* is
  // the taka actually taken off this order, which is also what totalAmount uses.
  adminDiscountType: AdminDiscountType | null;
  adminDiscountValue: number;
  adminDiscountAmount: number;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  shippingName: string;
  shippingPhone: string;
  shippingEmail: string | null;
  shippingAddress: string;
  shippingCity: string;
  shippingArea: string;
  orderNotes: string;
  cancelledAt: Date | null;
  // Why this order was cancelled, who cancelled it (admin audit trail)
  cancellationReason: string | null;
  cancelledBy: Types.ObjectId | null;
  // Delivery method the admin assigned to this order. Defaults to MANUAL for
  // every existing order (safe migration) — admins must explicitly switch an
  // eligible order to STEADFAST and then book it from the courier dashboard.
  deliveryMethod: "MANUAL" | "STEADFAST";
  // When each step happened (used by the sales and payment reports)
  confirmedAt: Date | null;
  readyToShipAt: Date | null;
  shippedAt: Date | null;
  outForDeliveryAt: Date | null;
  deliveredAt: Date | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  // Money given back on refund: the product price after discount. The delivery charge is never refunded.
  refundAmount: number;
  // Set once when stock is returned, so a cancel can never restore stock twice
  stockRestoredAt: Date | null;
  // Set once when the delivery+review SMS has been dispatched, so refreshing
  // or re-sending the DELIVERED update can never produce a second SMS.
  deliverySmsSentAt: Date | null;
  // Email counterparts: duplicate-prevention for the single delivery+review email
  // and the one-shot order confirmation email.
  deliveryEmailSentAt: Date | null;
  orderConfirmationSentAt: Date | null;
  // Pre-order snapshot. isPreOrder is true when ANY line in the order is a pre-order product
  // at checkout time; preOrderMinDays is the longest of those products' promised windows,
  // snapshotted so later product edits do not retroactively change this order's promise.
  isPreOrder: boolean;
  preOrderMinDays: number;
  expectedDeliveryDate: Date | null;
  // Internal notes visible only to admin dashboards.
  adminNotes: {
    note: string;
    addedBy: Types.ObjectId | null;
    addedAt: Date;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

export type OrderDocument = HydratedDocument<IOrder>;

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", default: null },
    couponCode: { type: String, default: null },
    fulfillmentMethod: {
      type: String,
      enum: FULFILLMENT_METHODS,
      default: "DELIVERY",
      required: true,
      index: true,
    },
    shippingCost: { type: Number, required: true, min: 0 },
    adminDiscountType: { type: String, enum: ADMIN_DISCOUNT_TYPES, default: null },
    adminDiscountValue: { type: Number, default: 0, min: 0 },
    adminDiscountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: PAYMENT_STATUS.PENDING, index: true },
    orderStatus: { type: String, enum: ORDER_STATUSES, default: ORDER_STATUS.PENDING, index: true },
    shippingName: { type: String, required: true, trim: true },
    shippingPhone: { type: String, required: true, trim: true },
    shippingEmail: { type: String, trim: true, lowercase: true, default: null },
    shippingAddress: { type: String, required: true, trim: true },
    shippingCity: { type: String, required: true, trim: true },
    shippingArea: { type: String, required: true, trim: true },
    orderNotes: { type: String, trim: true, default: "" },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: null, trim: true, maxlength: 500 },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    deliveryMethod: {
      type: String,
      enum: { values: ["MANUAL", "STEADFAST"], message: "deliveryMethod must be MANUAL or STEADFAST" },
      default: "MANUAL",
      index: true,
    },
    confirmedAt: { type: Date, default: null },
    readyToShipAt: { type: Date, default: null },
    shippedAt: { type: Date, default: null },
    outForDeliveryAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null, index: true },
    refundedAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0, min: 0 },
    stockRestoredAt: { type: Date, default: null },
    deliverySmsSentAt: { type: Date, default: null },
    deliveryEmailSentAt: { type: Date, default: null },
    orderConfirmationSentAt: { type: Date, default: null },
    isPreOrder: { type: Boolean, default: false, index: true },
    preOrderMinDays: { type: Number, default: 0, min: 0 },
    expectedDeliveryDate: { type: Date, default: null, index: true },
    adminNotes: {
      type: [
        new Schema(
          {
            note: { type: String, required: true, trim: true, maxlength: 1000 },
            addedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
            addedAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

orderSchema.index({ createdAt: -1 });
orderSchema.index({ isPreOrder: 1, orderStatus: 1, createdAt: -1 });

const Order = model<IOrder>("Order", orderSchema);
export default Order;
