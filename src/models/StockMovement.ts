import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const MOVEMENT_TYPES = [
  "PURCHASE", // Shipment received: stock in from a lot
  "SALE", // Delivered order line consumed a lot
  "RESERVATION", // Order placed: stock earmarked (reserved++)
  "RELEASE", // Order cancelled before fulfilment: reserved--
  "RETURN", // Customer return accepted into stock
  "DAMAGE", // Admin logged damaged units (stock--, damaged++)
  "LOSS", // Admin logged lost units (stock--)
  "ADJUSTMENT_IN", // Admin manual positive adjustment
  "ADJUSTMENT_OUT", // Admin manual negative adjustment
  "MANUAL_STOCK_UPDATE", // Admin set an exact stock number from the product page
  "EXPIRY", // Expired/withdrawn
  "INTERNAL_USE", // Internal use / sample
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

// Append-only audit log of every stock change. Used for the stock-movement report
// and to prove how a current stock number was arrived at.
export interface IStockMovement {
  productId: Types.ObjectId;
  // Optional lot/shipment context (set on PURCHASE/SALE/RETURN that came from a lot).
  lotId: Types.ObjectId | null;
  shipmentId: Types.ObjectId | null;
  orderId: Types.ObjectId | null;
  type: MovementType;
  // Positive for IN movements, negative for OUT movements, 0 for pure reservations/releases
  // of in-flight orders that touch `reserved` but not `stock`.
  quantity: number;
  // Stock BEFORE and AFTER this movement — handy for the UI.
  previousStock: number;
  newStock: number;
  // Unit cost at the time of the movement (lot landed cost on SALE, purchase cost on PURCHASE).
  unitCost: number;
  reason: string;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
}

export type StockMovementDocument = HydratedDocument<IStockMovement>;

const stockMovementSchema = new Schema<IStockMovement>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    lotId: { type: Schema.Types.ObjectId, ref: "InventoryLot", default: null, index: true },
    shipmentId: { type: Schema.Types.ObjectId, ref: "Shipment", default: null, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null, index: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true, index: true },
    quantity: { type: Number, required: true },
    previousStock: { type: Number, required: true, min: 0 },
    newStock: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    reason: { type: String, default: "", trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

stockMovementSchema.index({ productId: 1, createdAt: -1 });
stockMovementSchema.index({ createdAt: -1 });

const StockMovement = model<IStockMovement>("StockMovement", stockMovementSchema);
export default StockMovement;
