import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import {
  ORDER_STATUS,
  ORDER_STATUSES,
  PAYMENT_STATUS,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  type OrderStatus,
  type PaymentStatus,
  type PaymentMethod,
} from "../config/orderOptions";

// Items are stored in OrderItem. There is intentionally no postal code field.
export interface IOrder {
  orderNumber: string;
  customerId: Types.ObjectId;
  // Money is always calculated by the backend
  subtotal: number;
  discount: number;
  shippingCost: number;
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
  // When each step happened (used by the sales and payment reports)
  confirmedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  // Set once when stock is returned, so a cancel can never restore stock twice
  stockRestoredAt: Date | null;
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
    shippingCost: { type: Number, required: true, min: 0 },
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
    confirmedAt: { type: Date, default: null },
    shippedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null, index: true },
    refundedAt: { type: Date, default: null },
    stockRestoredAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

orderSchema.index({ createdAt: -1 });

const Order = model<IOrder>("Order", orderSchema);
export default Order;
