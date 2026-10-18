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
  // Quantity reserved by in-flight orders (not yet shipped). Decrements come from
  // reservations rather than straight from `stock`, so simultaneous customers can
  // never oversell. Available = max(0, stock - reserved).
  reserved: number;
  // Running totals: lifetime sold units + sold revenue (gross before shipping/COGS),
  // units returned, and units marked as damaged/lost. All admin-adjustable via
  // dedicated routes so audit history stays intact.
  soldQuantity: number;
  soldRevenue: number;
  returnedQuantity: number;
  damagedQuantity: number;
  // Per-product low-stock threshold. When available stock crosses from above to
  // at-or-below this value the admin gets ONE email (lastLowStockAlertAt handles
  // dedup). 0 keeps the alert silent for products the admin doesn't want to track.
  lowStockThreshold: number;
  lastLowStockAlertAt: Date | null;
  // Purchase cost; only visible to users who can update products. Treated as the
  // *current* average purchase cost — FIFO lots carry per-lot cost separately.
  productCost: number;
  // Stock-keeping unit. Optional (auto-generated on create when blank). Unique.
  sku: string;
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
  // How isPreOrder was set:
  //   "MANUAL" — admin flipped it from the product editor; never clobbered automatically.
  //   "AUTO"   — the system turned it on when stock dropped to 0; auto-cleared on restock.
  //   null     — not a pre-order product.
  preOrderSource: "MANUAL" | "AUTO" | null;
  // Admin override: ship this product for free (waive the per-city delivery
  // charge in checkout when the whole cart is free-delivery). System rule:
  // discounted products — customerSpecialPrice set below customerSellPrice —
  // always ship at the normal charge; validateProductRules silently clamps
  // freeDelivery=true back to false in that case.
  freeDelivery: boolean;
  // Set the first time stock reaches 0 after being positive; cleared when stock is
  // replenished. Prevents the admin stock-out alert from firing more than once
  // per out-of-stock cycle.
  lastStockOutAlertAt: Date | null;
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
    reserved: {
      type: Number,
      default: 0,
      min: [0, "Reserved cannot be negative"],
      validate: { validator: Number.isInteger, message: "Reserved must be a whole number" },
    },
    soldQuantity: { type: Number, default: 0, min: 0 },
    soldRevenue: { type: Number, default: 0, min: 0 },
    returnedQuantity: { type: Number, default: 0, min: 0 },
    damagedQuantity: { type: Number, default: 0, min: 0 },
    lowStockThreshold: {
      type: Number,
      default: 0,
      min: [0, "Low-stock threshold cannot be negative"],
      validate: { validator: Number.isInteger, message: "Low-stock threshold must be a whole number" },
    },
    lastLowStockAlertAt: { type: Date, default: null },
    productCost: {
      type: Number,
      required: [true, "Product cost is required"],
      min: [0, "Product cost cannot be negative"],
    },
    sku: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      maxlength: 60,
      index: { unique: true, sparse: true, partialFilterExpression: { sku: { $type: "string", $ne: "" } } },
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
    lastStockOutAlertAt: { type: Date, default: null },
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
    preOrderSource: {
      type: String,
      enum: { values: ["MANUAL", "AUTO", null], message: "preOrderSource must be MANUAL or AUTO" },
      default: null,
    },
    freeDelivery: { type: Boolean, default: false, index: true },
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
