import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const SHIPMENT_STATUSES = [
  "PENDING",
  "IN_TRANSIT",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const isShipmentStatus = (value: unknown): value is ShipmentStatus =>
  typeof value === "string" && (SHIPMENT_STATUSES as readonly string[]).includes(value);

export interface IShipmentItem {
  _id?: Types.ObjectId;
  productId: Types.ObjectId;
  // Snapshotted at creation so historical shipments stay readable even if the
  // product is later renamed or has its SKU changed.
  productTitleSnapshot: string;
  skuSnapshot: string;
  purchaseQuantity: number;
  receivedQuantity: number;
  // Per-unit purchase cost BEFORE landed-cost allocation.
  unitCost: number;
  // Per-unit landed cost: unitCost + allocated extras (shipping/customs/tax/other).
  // Populated when the shipment is received; FIFO lots are created with this.
  landedUnitCost: number;
  // Chosen sell price for this lot/receipt, snapshotted so profit math is deterministic.
  sellingPrice: number;
  notes: string;
}

// A purchase order from a supplier. Multiple shipments per product build up FIFO lots.
export interface IShipment {
  shipmentNumber: string;
  supplierId: Types.ObjectId;
  shipmentDate: Date;
  expectedDate: Date | null;
  receivedDate: Date | null;
  status: ShipmentStatus;
  items: IShipmentItem[];
  // Totals re-derived on save so the admin table never needs to aggregate.
  subtotal: number;
  shippingCost: number;
  customsCost: number;
  tax: number;
  otherCost: number;
  totalCost: number;
  notes: string;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ShipmentDocument = HydratedDocument<IShipment>;

const shipmentItemSchema = new Schema<IShipmentItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    productTitleSnapshot: { type: String, required: true },
    skuSnapshot: { type: String, default: "" },
    purchaseQuantity: {
      type: Number,
      required: true,
      min: [1, "Purchase quantity must be at least 1"],
      validate: { validator: Number.isInteger, message: "Purchase quantity must be a whole number" },
    },
    receivedQuantity: {
      type: Number,
      default: 0,
      min: [0, "Received quantity cannot be negative"],
      validate: { validator: Number.isInteger, message: "Received quantity must be a whole number" },
    },
    unitCost: { type: Number, required: true, min: 0 },
    landedUnitCost: { type: Number, default: 0, min: 0 },
    sellingPrice: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { _id: true }
);

const shipmentSchema = new Schema<IShipment>(
  {
    shipmentNumber: { type: String, required: true, unique: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
    shipmentDate: { type: Date, required: true, default: Date.now },
    expectedDate: { type: Date, default: null },
    receivedDate: { type: Date, default: null, index: true },
    status: { type: String, enum: SHIPMENT_STATUSES, default: "PENDING", index: true },
    items: { type: [shipmentItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    shippingCost: { type: Number, default: 0, min: 0 },
    customsCost: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    otherCost: { type: Number, default: 0, min: 0 },
    totalCost: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "", trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

shipmentSchema.index({ createdAt: -1 });
shipmentSchema.index({ status: 1, createdAt: -1 });

const Shipment = model<IShipment>("Shipment", shipmentSchema);
export default Shipment;
