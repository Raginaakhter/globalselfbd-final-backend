import type { ClientSession, Types } from "mongoose";
import Product from "../models/Product";
import AppError from "./AppError";

type ProductRef = Types.ObjectId | string;

// Take stock for an order inside a transaction. The filter only matches when enough
// stock is left, so simultaneous orders can never push stock below 0.
export const decrementStock = async (productId: ProductRef, quantity: number, session: ClientSession): Promise<void> => {
  const result = await Product.updateOne(
    { _id: productId, status: "ACTIVE", stock: { $gte: quantity } },
    { $inc: { stock: -quantity } },
    { session }
  );
  if (result.modifiedCount !== 1) {
    throw new AppError("Insufficient product stock", 409);
  }
};

// Return stock (order cancelled). A deleted product is simply skipped.
export const restoreStock = (productId: ProductRef, quantity: number, session: ClientSession) =>
  Product.updateOne({ _id: productId }, { $inc: { stock: quantity } }, { session });

// Sum quantities per product (the same product can be in the cart in several sizes)
export const quantitiesByProduct = (lines: { productId: ProductRef; quantity: number }[]): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const id = String(line.productId);
    totals.set(id, (totals.get(id) || 0) + line.quantity);
  }
  return totals;
};
