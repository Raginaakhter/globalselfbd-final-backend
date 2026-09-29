import { Types } from "mongoose";
import Review, { REVIEW_COMMENT_MAX } from "../models/Review";
import Product from "../models/Product";
import Order from "../models/Order";
import OrderItem from "../models/OrderItem";
import AppError from "./AppError";

// Reviews that show on a product's page: its own, plus ones an admin attached to it
export const reviewsOfProduct = (productId: Types.ObjectId | string) => {
  const id = new Types.ObjectId(String(productId));
  return { $or: [{ productId: id }, { associatedProductIds: id }] };
};

// Recalculate a product's rating from its APPROVED reviews (PENDING / REJECTED / HIDDEN are ignored)
export const refreshProductRating = async (productId: Types.ObjectId | string): Promise<void> => {
  const [row] = await Review.aggregate<{ avg: number; count: number }>([
    { $match: { ...reviewsOfProduct(productId), status: "APPROVED" } },
    { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  await Product.updateOne(
    { _id: productId },
    { $set: { ratingAverage: row ? Math.round(row.avg * 10) / 10 : 0, ratingCount: row ? row.count : 0 } }
  );
};

// A review changes the rating of its own product and every product it is attached to
export const refreshRatingsOf = async (review: { productId: Types.ObjectId; associatedProductIds?: Types.ObjectId[] }): Promise<void> => {
  const ids = new Set([String(review.productId), ...(review.associatedProductIds || []).map(String)]);
  for (const id of ids) await refreshProductRating(id);
};

// Only whole stars 1-5
export const parseRating = (value: unknown): number => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 5) {
    throw new AppError("Rating must be a whole number from 1 to 5", 400);
  }
  return n;
};

// Plain text only: no HTML, no control characters, sensible length
export const parseComment = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new AppError("Comment must be text", 400);
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\r\n/g, "\n").trim();
  if (/<\s*\/?\s*[a-z!][^>]*>/i.test(text)) throw new AppError("Comment cannot contain HTML", 400);
  if (text.length > REVIEW_COMMENT_MAX) throw new AppError(`Comment cannot exceed ${REVIEW_COMMENT_MAX} characters`, 400);
  if (text && text.length < 2) throw new AppError("Comment is too short", 400);
  return text;
};

// Delivered orders of this customer that contain the product, with whether each was already reviewed
export const reviewableOrders = async (customerId: Types.ObjectId, productId: Types.ObjectId) => {
  const orderIds = await OrderItem.distinct("orderId", { productId });
  const orders = await Order.find({ _id: { $in: orderIds }, customerId, orderStatus: "DELIVERED" })
    .select("orderNumber deliveredAt")
    .sort({ deliveredAt: -1 })
    .lean();
  const reviewed = new Set(
    (await Review.find({ customerId, productId, orderId: { $in: orders.map((o) => o._id) } }).select("orderId").lean()).map((r) =>
      String(r.orderId)
    )
  );
  return orders.map((o) => ({ orderId: o._id, orderNumber: o.orderNumber, deliveredAt: o.deliveredAt, reviewed: reviewed.has(String(o._id)) }));
};
