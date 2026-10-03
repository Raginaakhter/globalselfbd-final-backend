import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// Product info at the time it was added/refreshed (shown even if the product changes)
export interface ProductSnapshot {
  productTitle: string;
  slug: string;
  thumbnail: string;
  customerSellPrice: number;
  customerSpecialPrice: number | null;
}

// Combo info at the time it was added/refreshed
export interface ComboSnapshot {
  comboTitle: string;
  slug: string;
  thumbnail: string;
  comboPrice: number;
  items: {
    productId: Types.ObjectId;
    productTitle: string;
    quantity: number;
    unitPrice: number;
  }[];
}

export interface ICartItem {
  cartId: Types.ObjectId;
  // Exactly one of productId / comboId is set
  productId: Types.ObjectId | null;
  comboId: Types.ObjectId | null;
  quantity: number;
  // Size/unit are only used for product lines, not combos
  selectedSize: string | null;
  selectedUnit: string | null;
  // Always calculated by the backend from the current product / combo price
  unitPrice: number;
  subtotal: number;
  productSnapshot: ProductSnapshot | null;
  comboSnapshot: ComboSnapshot | null;
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
      default: null,
    },
    comboId: {
      type: Schema.Types.ObjectId,
      ref: "Combo",
      default: null,
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
    comboSnapshot: {
      comboTitle: String,
      slug: String,
      thumbnail: String,
      comboPrice: Number,
      items: [
        {
          _id: false,
          productId: { type: Schema.Types.ObjectId, ref: "Product" },
          productTitle: String,
          quantity: Number,
          unitPrice: Number,
        },
      ],
    },
  },
  {
    timestamps: true,
  }
);

// Exactly one of productId / comboId must be set per cart entry
cartItemSchema.pre("validate", function () {
  const hasProduct = !!this.productId;
  const hasCombo = !!this.comboId;
  if (hasProduct === hasCombo) {
    throw new Error("Cart item must reference either a product or a combo, not both");
  }
});

// Same product + size + unit is one line in the cart (product lines only)
cartItemSchema.index(
  { cartId: 1, productId: 1, selectedSize: 1, selectedUnit: 1 },
  { unique: true, partialFilterExpression: { productId: { $type: "objectId" } } }
);
// Same combo appears at most once in the cart
cartItemSchema.index(
  { cartId: 1, comboId: 1 },
  { unique: true, partialFilterExpression: { comboId: { $type: "objectId" } } }
);

const CartItem = model<ICartItem>("CartItem", cartItemSchema);
export default CartItem;
