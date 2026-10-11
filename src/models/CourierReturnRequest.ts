import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// Return workflow has SIX distinct states (per spec); this model collapses
// request + courier response + physical receipt + inspection into one row so
// the dashboard can render the full chain in one query. Inventory restoration
// writes a `StockMovement` row — this document just records what was inspected
// and whether restoration already fired (to prevent duplicates).

export const RETURN_REQUEST_STATUSES = [
  "REQUESTED",
  "COURIER_ACCEPTED",
  "COURIER_REJECTED",
  "PARCEL_RECEIVED",
  "INSPECTED",
  "RESTOCKED",
  "CLOSED",
] as const;
export type ReturnRequestStatus = (typeof RETURN_REQUEST_STATUSES)[number];

// Per-item inspection numbers. Only `sellableQuantity` is added back to stock.
interface IInspectionItem {
  productId: Types.ObjectId | null;
  productTitle: string;
  expectedQuantity: number;
  receivedQuantity: number;
  sellableQuantity: number;
  damagedQuantity: number;
  missingQuantity: number;
  notes: string;
}

export interface ICourierReturnRequest {
  shipmentId: Types.ObjectId;
  orderId: Types.ObjectId;
  // Courier-side identifier (when the create_return_request API returns one)
  steadfastReturnId: string | null;
  status: ReturnRequestStatus;

  // Request step
  requestedAt: Date;
  requestedBy: Types.ObjectId | null;
  requestReason: string;
  rawRequestResponse: unknown;

  // Physical parcel receipt (admin confirms it physically arrived)
  parcelReceivedAt: Date | null;
  parcelReceivedBy: Types.ObjectId | null;

  // Inspection
  inspectedAt: Date | null;
  inspectedBy: Types.ObjectId | null;
  inspectionItems: IInspectionItem[];
  inspectionNotes: string;

  // Restoration (idempotency flag — once true, this row's inventory additions
  // never re-apply even if a later click reinspects/resaves).
  stockRestoredAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type CourierReturnRequestDocument = HydratedDocument<ICourierReturnRequest>;

const inspectionItemSchema = new Schema<IInspectionItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    productTitle: { type: String, required: true },
    expectedQuantity: { type: Number, required: true, min: 0 },
    receivedQuantity: { type: Number, required: true, min: 0 },
    sellableQuantity: { type: Number, required: true, min: 0 },
    damagedQuantity: { type: Number, required: true, min: 0 },
    missingQuantity: { type: Number, required: true, min: 0 },
    notes: { type: String, default: "", maxlength: 500 },
  },
  { _id: false }
);

const courierReturnRequestSchema = new Schema<ICourierReturnRequest>(
  {
    shipmentId: { type: Schema.Types.ObjectId, ref: "CourierShipment", required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    steadfastReturnId: { type: String, default: null, index: true },
    status: { type: String, enum: RETURN_REQUEST_STATUSES, default: "REQUESTED", index: true },

    requestedAt: { type: Date, required: true, default: Date.now },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    requestReason: { type: String, default: "", maxlength: 500 },
    rawRequestResponse: { type: Schema.Types.Mixed, default: null },

    parcelReceivedAt: { type: Date, default: null },
    parcelReceivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    inspectedAt: { type: Date, default: null },
    inspectedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    inspectionItems: { type: [inspectionItemSchema], default: [] },
    inspectionNotes: { type: String, default: "", maxlength: 1000 },

    stockRestoredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

courierReturnRequestSchema.index({ createdAt: -1 });

const CourierReturnRequest = model<ICourierReturnRequest>(
  "CourierReturnRequest",
  courierReturnRequestSchema
);
export default CourierReturnRequest;
