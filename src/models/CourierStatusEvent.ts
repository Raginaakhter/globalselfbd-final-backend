import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import {
  STEADFAST_DELIVERY_STATUSES,
  type SteadfastDeliveryStatus,
} from "../config/steadfast";

// Append-only log of courier delivery-status transitions AND failed sync
// attempts. Keeps the shipment detail page honest about what the courier
// reported vs. what we tried but couldn't verify.

export const COURIER_EVENT_SOURCES = ["API_POLL", "WEBHOOK", "MANUAL"] as const;
export type CourierEventSource = (typeof COURIER_EVENT_SOURCES)[number];

export interface ICourierStatusEvent {
  shipmentId: Types.ObjectId;
  consignmentId: string | null;
  // Only set when the event actually represents a status transition; a
  // sync attempt that returned the same status writes a lightweight row
  // with `isTransition: false` so the sync count is auditable.
  previousStatus: SteadfastDeliveryStatus | null;
  newStatus: SteadfastDeliveryStatus;
  isTransition: boolean;
  source: CourierEventSource;
  note: string;
  syncError: string | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
}

export type CourierStatusEventDocument = HydratedDocument<ICourierStatusEvent>;

const courierStatusEventSchema = new Schema<ICourierStatusEvent>(
  {
    shipmentId: { type: Schema.Types.ObjectId, ref: "CourierShipment", required: true, index: true },
    consignmentId: { type: String, default: null },
    previousStatus: { type: String, enum: [...STEADFAST_DELIVERY_STATUSES, null], default: null },
    newStatus: { type: String, enum: STEADFAST_DELIVERY_STATUSES, required: true },
    isTransition: { type: Boolean, default: true },
    source: { type: String, enum: COURIER_EVENT_SOURCES, required: true },
    note: { type: String, default: "", maxlength: 500 },
    syncError: { type: String, default: null, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

courierStatusEventSchema.index({ shipmentId: 1, createdAt: -1 });

const CourierStatusEvent = model<ICourierStatusEvent>("CourierStatusEvent", courierStatusEventSchema);
export default CourierStatusEvent;
