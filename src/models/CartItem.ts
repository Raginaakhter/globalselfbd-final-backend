import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// Product info at the time it was added/refreshed (shown even if the product changes)
export interface ProductSnapshot {
  productTitle: string;
  slug: string;
  thumbnail: string;
  customerSellPrice: number;
  customerSpecialPrice: number | null;
}

export interface ICartItem {
  cartId: Types.ObjectId;
  productId: Types.ObjectId;
  quantity: number;
  selectedSize: string | null;
  selectedUnit: string | null;
  // Always calculated by the backend from the current product price
  unitPrice: number;
  subtotal: number;
  productSnapshot: ProductSnapshot;
  createdAt: Date;
  updatedAt: Date;
}

export type CartItemDocument = HydratedDocument<ICartItem>;

const cartItemSchema = new Schema<ICartItem>(
  {
    cartId: {
      type: Schema.Types.ObjectId,
      ref: "Cart",
      required: true,
      index: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    selectedSize: {
      type: String,
      default: null,
    },
    selectedUnit: {
      type: String,
      default: null,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    productSnapshot: {
      productTitle: String,
      slug: String,
      thumbnail: String,
      customerSellPrice: Number,
      customerSpecialPrice: Number,
    },
  },
  {
    timestamps: true,
  }
);

// Same product + size + unit is one line in the cart
cartItemSchema.index({ cartId: 1, productId: 1, selectedSize: 1, selectedUnit: 1 }, { unique: true });

const CartItem = model<ICartItem>("CartItem", cartItemSchema);
export default CartItem;
