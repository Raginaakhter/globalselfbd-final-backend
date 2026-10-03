import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import { PAYMENT_METHODS, type PaymentMethod } from "../config/orderOptions";

export interface InvoiceItem {
  productId: Types.ObjectId | null;
  comboId: Types.ObjectId | null;
  productTitle: string;
  selectedSize: string | null;
  selectedUnit: string | null;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

// One invoice per order. Customer, items and money are a copy taken when the invoice was issued;
// the order and payment status are always read live from the order.
export interface IInvoice {
  invoiceNumber: string;
  orderId: Types.ObjectId;
  orderNumber: string;
  customerId: Types.ObjectId;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  shippingArea: string;
  shippingCity: string;
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  couponCode: string | null;
  shippingCost: number;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  issuedAt: Date;
  // null when created automatically (order confirmed)
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InvoiceDocument = HydratedDocument<IInvoice>;

const invoiceItemSchema = new Schema<InvoiceItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    comboId: { type: Schema.Types.ObjectId, ref: "Combo", default: null },
    productTitle: { type: String, required: true },
    selectedSize: { type: String, default: null },
    selectedUnit: { type: String, default: null },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const invoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
    orderNumber: { type: String, required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    customerEmail: { type: String, default: null },
    shippingAddress: { type: String, required: true },
    shippingArea: { type: String, required: true },
    shippingCity: { type: String, required: true },
    items: { type: [invoiceItemSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    couponCode: { type: String, default: null },
    shippingCost: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    issuedAt: { type: Date, default: Date.now, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
  }
);

const Invoice = model<IInvoice>("Invoice", invoiceSchema);
export default Invoice;
