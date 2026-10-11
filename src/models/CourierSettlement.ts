import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// Explicit COD / payout reconciliation ledger. Each row allocates a verified
// amount against ONE shipment. Multiple rows per shipment are allowed when a
// payout is split across days. Total allocated amount is enforced against the
// shipment's `codAmountSubmitted` in the controller to prevent double-counting.

export const SETTLEMENT_SOURCES = [
  "COURIER_PAYOUT", // reconciled from Steadfast /payments endpoint
  "MANUAL_RECONCILE", // admin recorded a verified bank/mobile transfer
  "ADJUSTMENT", // correction entry (positive or negative)
] as const;
export type SettlementSource = (typeof SETTLEMENT_SOURCES)[number];

export interface ICourierSettlement {
  shipmentId: Types.ObjectId;
  orderId: Types.ObjectId;
  // Steadfast payment identifier if the entry came from a payout API; null for
  // manual entries so admins can still see which rows need audit later.
  payoutId: string | null;
  source: SettlementSource;
  amount: number; // can be negative for adjustments
  // When the courier physically paid us — for payouts this is from the API,
  // for manual entries the admin picks a date.
  receivedAt: Date;
  recordedBy: Types.ObjectId | null;
  reference: string; // bank txn id / cheque number / payout batch
  notes: string;
  // Raw payout row from Steadfast if available — kept for audit.
  rawPayload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export type CourierSettlementDocument = HydratedDocument<ICourierSettlement>;

const courierSettlementSchema = new Schema<ICourierSettlement>(
  {
    shipmentId: { type: Schema.Types.ObjectId, ref: "CourierShipment", required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    payoutId: { type: String, default: null, index: true },
    source: { type: String, enum: SETTLEMENT_SOURCES, required: true },
    amount: { type: Number, required: true },
    receivedAt: { type: Date, required: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reference: { type: String, default: "", maxlength: 200 },
    notes: { type: String, default: "", maxlength: 1000 },
    rawPayload: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Idempotency: a given (payoutId, shipmentId) pair must only ever settle once
// so a webhook replay or admin double-click never double-counts cash received.
courierSettlementSchema.index(
  { payoutId: 1, shipmentId: 1 },
  { unique: true, partialFilterExpression: { payoutId: { $type: "string" } } }
);
courierSettlementSchema.index({ receivedAt: -1 });

const CourierSettlement = model<ICourierSettlement>("CourierSettlement", courierSettlementSchema);
export default CourierSettlement;
