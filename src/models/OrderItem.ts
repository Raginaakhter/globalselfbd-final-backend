import { Schema, model, type Types } from "mongoose";

// A combo's member products at the time of purchase. Kept for order history / refunds.
export interface ComboItemSnapshotEntry {
  productId: Types.ObjectId;
  productTitle: string;
  quantity: number;
  unitPrice: number;
}

// Snapshot of what was bought; never changes when the product or combo is edited or deleted.
// Each order line is either a product (productId set) or a combo (comboId set), never both.
export interface IOrderItem {
  orderId: Types.ObjectId;
  productId: Types.ObjectId | null;
  comboId: Types.ObjectId | null;
  productTitleSnapshot: string;
  thumbnailSnapshot: string | null;
  quantity: number;
  selectedSize: string | null;
  selectedUnit: string | null;
  unitPrice: number;
  subtotal: number;
  // For combo lines only: the member products at purchase time
  comboItemsSnapshot: ComboItemSnapshotEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null, index: true },
    comboId: { type: Schema.Types.ObjectId, ref: "Combo", default: null, index: true },
    productTitleSnapshot: { type: String, required: true },
    thumbnailSnapshot: { type: String, default: null },
    quantity: { type: Number, required: true, min: 1 },
    selectedSize: { type: String, default: null },
    selectedUnit: { type: String, default: null },
    unitPrice: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
    comboItemsSnapshot: {
      type: [
        {
          _id: false,
          productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
          productTitle: { type: String, required: true },
          quantity: { type: Number, required: true, min: 1 },
          unitPrice: { type: Number, required: true, min: 0 },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

orderItemSchema.pre("validate", function () {
  const hasProduct = !!this.productId;
  const hasCombo = !!this.comboId;
  if (hasProduct === hasCombo) {
    throw new Error("Order item must reference either a product or a combo, not both");
  }
});

const OrderItem = model<IOrderItem>("OrderItem", orderItemSchema);
export default OrderItem;
