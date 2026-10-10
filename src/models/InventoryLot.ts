import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const LOT_STATUSES = ["ACTIVE", "DEPLETED", "VOID"] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

// A received batch of one product from one shipment. FIFO consumption draws from the
// oldest-receivedDate active lot first; each sale records which lot(s) it drew from so
// COGS stays accurate even when per-batch costs differ.
export interface IInventoryLot {
  productId: Types.ObjectId;
  shipmentId: Types.ObjectId;
  supplierId: Types.ObjectId;
  // Human-readable lot code (e.g. SHIP-1001-ITEM1); unique within the DB.
  lotNumber: string;
  receivedQuantity: number;
  // Remaining units in this lot. Reaches 0 when fully consumed, then status flips to DEPLETED.
  remainingQuantity: number;
  // Per-unit purchase cost (what the supplier charged).
  unitCost: number;
  // Per-unit landed cost = unitCost + allocated shipping+customs+tax+other. Used for COGS.
  landedUnitCost: number;
  // Snapshotted at receive time; the lot keeps its own sell price for profit reports.
  sellingPrice: number;
  receivedDate: Date;
  expiryDate: Date | null;
  status: LotStatus;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

export type InventoryLotDocument = HydratedDocument<IInventoryLot>;

const inventoryLotSchema = new Schema<IInventoryLot>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    shipmentId: { type: Schema.Types.ObjectId, ref: "Shipment", required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
    lotNumber: { type: String, required: true, unique: true, index: true },
    receivedQuantity: {
      type: Number,
      required: true,
      min: [0, "Received quantity cannot be negative"],
      validate: { validator: Number.isInteger, message: "Received quantity must be a whole number" },
    },
    remainingQuantity: {
      type: Number,
      required: true,
      min: [0, "Remaining quantity cannot be negative"],
      validate: { validator: Number.isInteger, message: "Remaining quantity must be a whole number" },
    },
    unitCost: { type: Number, required: true, min: 0 },
    landedUnitCost: { type: Number, required: true, min: 0 },
    sellingPrice: { type: Number, default: 0, min: 0 },
    receivedDate: { type: Date, required: true, default: Date.now, index: true },
    expiryDate: { type: Date, default: null },
    status: { type: String, enum: LOT_STATUSES, default: "ACTIVE", index: true },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// FIFO consumption index: oldest active lots with remaining stock come first.
inventoryLotSchema.index({ productId: 1, status: 1, receivedDate: 1 });

const InventoryLot = model<IInventoryLot>("InventoryLot", inventoryLotSchema);
export default InventoryLot;
