import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import { SIZES, UNITS, STATUSES, LIMITS, type Size, type Unit } from "../config/productOptions";
import { PRE_ORDER } from "../config/orderOptions";
import type { Status } from "../types/common";

export interface IProduct {
  productTitle: string;
  slug: string;
  productDescription: string;
  categoryId: Types.ObjectId;
  // Real quantity; never sent to customers (they only see availability)
  stock: number;
  // Purchase cost; only visible to users who can update products
  productCost: number;
  customerSellPrice: number;
  customerSpecialPrice: number | null;
  isFabric: boolean;
  sizes: Size[];
  unit: Unit | null;
  quantity: number | null;
  thumbnail: string;
  gallery: string[];
  status: Status;
  // From APPROVED reviews only; kept up to date when a review is approved/hidden/deleted
  ratingAverage: number;
  ratingCount: number;
  // Pre-order: when true, this product takes orders even without stock; the admin
  // promises delivery in at least `preOrderMinDays` days (floor: PRE_ORDER.MIN_DELIVERY_DAYS).
  isPreOrder: boolean;
  preOrderMinDays: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ProductDocument = HydratedDocument<IProduct>;

const productSchema = new Schema<IProduct>(
  {
    productTitle: {
      type: String,
      required: [true, "Product title is required"],
      trim: true,
      maxlength: [LIMITS.TITLE_MAX, `Product title cannot exceed ${LIMITS.TITLE_MAX} characters`],
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: LIMITS.SLUG_MAX,
    },
    productDescription: {
      type: String,
      trim: true,
      maxlength: [LIMITS.DESCRIPTION_MAX, `Product description cannot exceed ${LIMITS.DESCRIPTION_MAX} characters`],
      default: "",
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      required: [true, "Category is required"],
      index: true,
    },
    stock: {
      type: Number,
      required: [true, "Stock is required"],
      min: [0, "Stock cannot be negative"],
      validate: { validator: Number.isInteger, message: "Stock must be a whole number" },
    },
    productCost: {
      type: Number,
      required: [true, "Product cost is required"],
      min: [0, "Product cost cannot be negative"],
    },
    customerSellPrice: {
      type: Number,
      required: [true, "Customer sell price is required"],
      min: [0.01, "Customer sell price must be greater than 0"],
    },
    customerSpecialPrice: {
      type: Number,
      default: null,
      min: [0.01, "Customer special price must be greater than 0"],
    },
    isFabric: {
      type: Boolean,
      default: false,
    },
    sizes: {
      type: [{ type: String, enum: { values: SIZES, message: "Invalid size: {VALUE}" } }],
      default: [],
    },
    unit: {
      type: String,
      enum: { values: [...UNITS, null], message: "Invalid unit: {VALUE}" },
      default: null,
    },
    quantity: {
      type: Number,
      default: null,
      min: [0, "Quantity cannot be negative"],
    },
    thumbnail: {
      type: String,
      required: [true, "Thumbnail is required"],
      trim: true,
    },
    gallery: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: { values: STATUSES, message: "Status must be ACTIVE or INACTIVE" },
      default: "ACTIVE",
      index: true,
    },
    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    isPreOrder: { type: Boolean, default: false, index: true },
    preOrderMinDays: {
      type: Number,
      default: 0,
      min: [0, "Pre-order days cannot be negative"],
      max: [PRE_ORDER.MAX_DELIVERY_DAYS, `Pre-order days cannot exceed ${PRE_ORDER.MAX_DELIVERY_DAYS}`],
      validate: {
        validator: Number.isInteger,
        message: "Pre-order days must be a whole number",
      },
    },
  },
  {
    timestamps: true,
  }
);

// Enforce the business floor: when pre-order is ON, days must be >= MIN_DELIVERY_DAYS.
// (Validated in the controller too; this is the model-level safety net.)
productSchema.path("preOrderMinDays").validate(function (value: number) {
  return !this.isPreOrder || value >= PRE_ORDER.MIN_DELIVERY_DAYS;
}, `Pre-order minimum delivery days must be at least ${PRE_ORDER.MIN_DELIVERY_DAYS}`);

productSchema.index({ status: 1, categoryId: 1, createdAt: -1 });
productSchema.index({ customerSellPrice: 1 });

const Product = model<IProduct>("Product", productSchema);
export default Product;
