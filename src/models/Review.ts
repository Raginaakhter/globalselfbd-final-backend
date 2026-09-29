import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED", "HIDDEN"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_COMMENT_MAX = 1000;

// A verified-purchase review: one per customer + order + product.
// Only APPROVED reviews are public and count towards the product rating.
export interface IReview {
  customerId: Types.ObjectId;
  orderId: Types.ObjectId;
  productId: Types.ObjectId;
  // Copies taken when the review is written (shown even if the product/order changes later)
  orderNumber: string;
  customerName: string;
  productTitle: string;
  productImage: string;
  rating: number;
  comment: string;
  status: ReviewStatus;
  // Picked by an admin for the homepage carousel (only used while APPROVED)
  showOnHomepage: boolean;
  // Other products an admin attached this review to: it also shows (and counts) on their pages
  associatedProductIds: Types.ObjectId[];
  moderatedBy: Types.ObjectId | null;
  moderatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ReviewDocument = HydratedDocument<IReview>;

const reviewSchema = new Schema<IReview>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    orderNumber: { type: String, required: true },
    customerName: { type: String, required: true, trim: true },
    productTitle: { type: String, required: true },
    productImage: { type: String, default: "" },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true, maxlength: REVIEW_COMMENT_MAX, default: "" },
    status: { type: String, enum: REVIEW_STATUSES, default: "PENDING", index: true },
    showOnHomepage: { type: Boolean, default: false },
    associatedProductIds: { type: [{ type: Schema.Types.ObjectId, ref: "Product" }], default: [] },
    moderatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    moderatedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

// No duplicate review for the same product of the same order by the same customer
reviewSchema.index({ customerId: 1, orderId: 1, productId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ status: 1, showOnHomepage: 1, updatedAt: -1 });
reviewSchema.index({ associatedProductIds: 1, status: 1 });

export const MAX_ASSOCIATED_PRODUCTS = 20;

const Review = model<IReview>("Review", reviewSchema);
export default Review;
