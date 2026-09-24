import { Schema, model, type Types } from "mongoose";

// Snapshot of what was bought; never changes when the product is edited or deleted
export interface IOrderItem {
  orderId: Types.ObjectId;
  productId: Types.ObjectId;
  productTitleSnapshot: string;
  thumbnailSnapshot: string | null;
  quantity: number;
  selectedSize: string | null;
  selectedUnit: string | null;
  unitPrice: number;
  subtotal: number;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    productTitleSnapshot: { type: String, required: true },
    thumbnailSnapshot: { type: String, default: null },
    quantity: { type: Number, required: true, min: 1 },
    selectedSize: { type: String, default: null },
    selectedUnit: { type: String, default: null },
    unitPrice: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
  },
  {
    timestamps: true,
  }
);

const OrderItem = model<IOrderItem>("OrderItem", orderItemSchema);
export default OrderItem;
