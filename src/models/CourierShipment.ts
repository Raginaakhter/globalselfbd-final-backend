import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import {
  STEADFAST_DELIVERY_STATUSES,
  type SteadfastDeliveryStatus,
} from "../config/steadfast";

// --------------------------------------------------------------------------
// Courier shipment record — created when an admin explicitly books a parcel
// with Steadfast. ONE active shipment per order (enforced by a unique partial
// index below); a replacement shipment is allowed only through the
// `supersededByShipmentId` chain, which preserves the original history.
// --------------------------------------------------------------------------

// Internal booking lifecycle — distinct from courier delivery status and
// settlement status so the three can never be conflated.
export const COURIER_BOOKING_STATUSES = [
  "NOT_BOOKED",
  "IN_PROGRESS",
  "SUCCESS",
  "FAILED",
  "UNCERTAIN", // API timed out / response lost — admin must verify before retry
] as const;
export type CourierBookingStatus = (typeof COURIER_BOOKING_STATUSES)[number];

export const COURIER_SETTLEMENT_STATUSES = [
  "PENDING",
  "PARTIALLY_SETTLED",
  "SETTLED",
  "UNDER_RECONCILIATION",
  "DISPUTED",
] as const;
export type CourierSettlementStatus = (typeof COURIER_SETTLEMENT_STATUSES)[number];

// Snapshot of one order item at booking time — never mutated when the
// product's price later changes. Keeps the shipment detail page accurate
// against the exact numbers submitted to the courier.
interface IShipmentItemSnapshot {
  productId: Types.ObjectId | null;
  productTitle: string;
  variant: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface ICourierShipment {
  // Shared identifiers --------------------------------------------------------
  orderId: Types.ObjectId;
  orderNumber: string; // snapshot of order.orderNumber so queries stay fast
  invoice: string; // the value sent as `invoice` to Steadfast
  deliveryMethod: "STEADFAST";

  // Booking lifecycle --------------------------------------------------------
  bookingStatus: CourierBookingStatus;
  bookingAttemptedAt: Date | null;
  bookingSucceededAt: Date | null;
  bookingFailureReason: string | null;
  bookingResponseStatus: number | null; // HTTP code from Steadfast
  // Idempotency key tied to the SPECIFIC create_order attempt — a second
  // attempt that reuses this key is refused by the server.
  bookingIdempotencyKey: string;
  // Admin who clicked "Send to Steadfast"
  bookedBy: Types.ObjectId | null;

  // Steadfast identifiers (populated on SUCCESS) -----------------------------
  consignmentId: string | null;
  trackingCode: string | null;
  courierInvoice: string | null;

  // Courier delivery status --------------------------------------------------
  deliveryStatus: SteadfastDeliveryStatus;
  lastDeliveryStatusSyncedAt: Date | null;
  lastDeliveryStatusSyncError: string | null;

  // Order snapshot -----------------------------------------------------------
  // Captured at booking so the dashboard shows the exact numbers submitted
  // even if the underlying order/products change later.
  customerName: string;
  customerPhone: string;
  customerAltPhone: string;
  customerEmail: string;
  deliveryAddress: string;
  items: IShipmentItemSnapshot[];
  subtotal: number;
  discount: number;
  shippingCost: number;
  orderTotal: number;
  advancePaid: number;

  // COD submission + settlement ----------------------------------------------
  codAmountSubmitted: number; // what we told Steadfast to collect
  codAmountReceived: number; // what we actually received back (ledger)
  settlementStatus: CourierSettlementStatus;
  lastSettlementRecordedAt: Date | null;

  // Courier fees -------------------------------------------------------------
  configuredCharge: number; // snapshot of courier charge setting at booking
  actualCharge: number | null; // verified actual charge if admin recorded it
  actualChargeRecordedBy: Types.ObjectId | null;
  actualChargeRecordedAt: Date | null;

  // Cancellation state (requested != confirmed) ------------------------------
  cancellationRequestedAt: Date | null;
  cancellationRequestedBy: Types.ObjectId | null;
  cancellationReason: string;
  cancellationApiResponse: string | null;
  cancelledAt: Date | null; // only set when a verified status confirms it

  // Return state (separate from physical receipt) ----------------------------
  returnRequestedAt: Date | null;
  returnRequestedBy: Types.ObjectId | null;
  returnReceivedAt: Date | null;
  returnReceivedBy: Types.ObjectId | null;
  returnInspectionCompletedAt: Date | null;
  // true once at least one return-receive record has restored stock —
  // guards against double restoration on repeated clicks.
  stockRestoredFromReturn: boolean;

  // Replacement chain --------------------------------------------------------
  supersededByShipmentId: Types.ObjectId | null;
  // Raw booking response (minus secrets) kept for audit/troubleshooting.
  rawBookingResponse: unknown;
  rawBookingRequest: unknown;

  createdAt: Date;
  updatedAt: Date;
}

export type CourierShipmentDocument = HydratedDocument<ICourierShipment>;

const itemSnapshotSchema = new Schema<IShipmentItemSnapshot>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    productTitle: { type: String, required: true },
    variant: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const courierShipmentSchema = new Schema<ICourierShipment>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    orderNumber: { type: String, required: true, index: true },
    invoice: { type: String, required: true, index: true },
    deliveryMethod: { type: String, enum: ["STEADFAST"], required: true, default: "STEADFAST" },

    bookingStatus: {
      type: String,
      enum: COURIER_BOOKING_STATUSES,
      default: "NOT_BOOKED",
      index: true,
    },
    bookingAttemptedAt: { type: Date, default: null },
    bookingSucceededAt: { type: Date, default: null },
    bookingFailureReason: { type: String, default: null, maxlength: 1000 },
    bookingResponseStatus: { type: Number, default: null },
    bookingIdempotencyKey: { type: String, required: true },
    bookedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    consignmentId: { type: String, default: null, index: true },
    trackingCode: { type: String, default: null, index: true },
    courierInvoice: { type: String, default: null },

    deliveryStatus: {
      type: String,
      enum: STEADFAST_DELIVERY_STATUSES,
      default: "pending",
      index: true,
    },
    lastDeliveryStatusSyncedAt: { type: Date, default: null },
    lastDeliveryStatusSyncError: { type: String, default: null, maxlength: 500 },

    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true, index: true },
    customerAltPhone: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    deliveryAddress: { type: String, required: true },

    items: { type: [itemSnapshotSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0 },
    shippingCost: { type: Number, required: true, min: 0 },
    orderTotal: { type: Number, required: true, min: 0 },
    advancePaid: { type: Number, required: true, min: 0, default: 0 },

    codAmountSubmitted: { type: Number, required: true, min: 0 },
    codAmountReceived: { type: Number, required: true, min: 0, default: 0 },
    settlementStatus: {
      type: String,
      enum: COURIER_SETTLEMENT_STATUSES,
      default: "PENDING",
      index: true,
    },
    lastSettlementRecordedAt: { type: Date, default: null },

    configuredCharge: { type: Number, required: true, min: 0, default: 0 },
    actualCharge: { type: Number, default: null, min: 0 },
    actualChargeRecordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actualChargeRecordedAt: { type: Date, default: null },

    cancellationRequestedAt: { type: Date, default: null },
    cancellationRequestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, default: "", maxlength: 500 },
    cancellationApiResponse: { type: String, default: null, maxlength: 2000 },
    cancelledAt: { type: Date, default: null },

    returnRequestedAt: { type: Date, default: null },
    returnRequestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    returnReceivedAt: { type: Date, default: null },
    returnReceivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    returnInspectionCompletedAt: { type: Date, default: null },
    stockRestoredFromReturn: { type: Boolean, default: false },

    supersededByShipmentId: { type: Schema.Types.ObjectId, ref: "CourierShipment", default: null },
    rawBookingResponse: { type: Schema.Types.Mixed, default: null },
    rawBookingRequest: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Only ONE active (non-superseded) shipment per order — a replacement must
// come through supersededByShipmentId. Partial index means multiple cancelled/
// voided rows for the same order don't block a new active one.
courierShipmentSchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { supersededByShipmentId: null } }
);

// Idempotency guard — a specific booking attempt is identified by its key.
courierShipmentSchema.index({ bookingIdempotencyKey: 1 }, { unique: true });

courierShipmentSchema.index({ createdAt: -1 });
courierShipmentSchema.index({ bookingStatus: 1, createdAt: -1 });

const CourierShipment = model<ICourierShipment>("CourierShipment", courierShipmentSchema);
export default CourierShipment;
