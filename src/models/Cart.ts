import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// One cart per customer; items live in CartItem
export interface ICart {
  customerId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type CartDocument = HydratedDocument<ICart>;

const cartSchema = new Schema<ICart>(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
  },
  {
    timestamps: true,
  }
);

const Cart = model<ICart>("Cart", cartSchema);
export default Cart;
