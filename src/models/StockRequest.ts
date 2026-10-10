import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const STOCK_REQUEST_STATUSES = ["NEW", "NOTIFIED", "RESOLVED", "CANCELLED"] as const;
export type StockRequestStatus = (typeof STOCK_REQUEST_STATUSES)[number];

export const isStockRequestStatus = (value: unknown): value is StockRequestStatus =>
  typeof value === "string" && (STOCK_REQUEST_STATUSES as readonly string[]).includes(value);

// Record of a customer asking for more stock than is currently available. The admin
// gets an email alert (rate-limited per product + customer), and these rows power
// the "Stock Request" report in the admin dashboard.
export interface IStockRequest {
  productId: Types.ObjectId;
  // When the request came from an authenticated user. Guests still get recorded
  // but customerId is null; snapshot fields keep the contact info usable either way.
  customerId: Types.ObjectId | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  productTitleSnapshot: string;
  skuSnapshot: string;
  requestedQuantity: number;
  availableQuantity: number;
  shortageQuantity: number;
  status: StockRequestStatus;
  // When the admin notification email was last sent for this request (dedup/rate-limit).
  notifiedAt: Date | null;
  adminNote: string;
  createdAt: Date;
  updatedAt: Date;
}

export type StockRequestDocument = HydratedDocument<IStockRequest>;

const stockRequestSchema = new Schema<IStockRequest>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    customerName: { type: String, default: "", trim: true, maxlength: 160 },
    customerPhone: { type: String, default: "", trim: true, maxlength: 30 },
    customerEmail: { type: String, default: "", trim: true, lowercase: true, maxlength: 160 },
    productTitleSnapshot: { type: String, required: true },
    skuSnapshot: { type: String, default: "" },
    requestedQuantity: { type: Number, required: true, min: 1 },
    availableQuantity: { type: Number, required: true, min: 0 },
    shortageQuantity: { type: Number, required: true, min: 1 },
    status: { type: String, enum: STOCK_REQUEST_STATUSES, default: "NEW", index: true },
    notifiedAt: { type: Date, default: null },
    adminNote: { type: String, default: "", trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

stockRequestSchema.index({ createdAt: -1 });
stockRequestSchema.index({ productId: 1, customerId: 1, createdAt: -1 });

const StockRequest = model<IStockRequest>("StockRequest", stockRequestSchema);
export default StockRequest;
