import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import { STATUSES } from "../config/productOptions";
import type { Status } from "../types/common";

// A combo is a bundle of several products sold together at a single bundle price.
// Member products' prices at the time of creation are used to compute savings; the
// bundle price itself is set by the admin, not derived.
export interface IComboItem {
  productId: Types.ObjectId;
  quantity: number;
}

export interface ICombo {
  comboTitle: string;
  slug: string;
  description: string;
  // Admin-set bundle price; what the customer actually pays for the combo
  comboPrice: number;
  thumbnail: string;
  gallery: string[];
  // Optional category tag (for filtering combos in the storefront)
  categoryId: Types.ObjectId | null;
  items: IComboItem[];
  // Optional campaign window
  startsAt: Date | null;
  endsAt: Date | null;
  status: Status;
  // Admin display order (ascending)
  displayOrder: number;
  // Sold count: number of combos sold (incremented when an order is placed)
  soldCount: number;
  // Revenue earned from this combo
  revenue: number;
  // Views for analytics (optional, not critical)
  views: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ComboDocument = HydratedDocument<ICombo>;

export const COMBO_LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 5000,
  SLUG_MAX: 120,
  GALLERY_MAX: 10,
  // A combo must have at least this many products
  MIN_ITEMS: 2,
  // A combo cannot have more than this many products
  MAX_ITEMS: 20,
  MAX_ITEM_QUANTITY: 50,
} as const;

const comboItemSchema = new Schema<IComboItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    quantity: {
      type: Number,
      required: true,
      min: [1, "Combo item quantity must be at least 1"],
      max: [COMBO_LIMITS.MAX_ITEM_QUANTITY, `Combo item quantity cannot exceed ${COMBO_LIMITS.MAX_ITEM_QUANTITY}`],
      validate: { validator: Number.isInteger, message: "Combo item quantity must be a whole number" },
    },
  },
  { _id: false }
);

const comboSchema = new Schema<ICombo>(
  {
    comboTitle: {
      type: String,
      required: [true, "Combo title is required"],
      trim: true,
      maxlength: [COMBO_LIMITS.TITLE_MAX, `Combo title cannot exceed ${COMBO_LIMITS.TITLE_MAX} characters`],
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: COMBO_LIMITS.SLUG_MAX,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [COMBO_LIMITS.DESCRIPTION_MAX, `Description cannot exceed ${COMBO_LIMITS.DESCRIPTION_MAX} characters`],
      default: "",
    },
    comboPrice: {
      type: Number,
      required: [true, "Combo price is required"],
      min: [0.01, "Combo price must be greater than 0"],
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
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      default: null,
      index: true,
    },
    items: {
      type: [comboItemSchema],
      validate: {
        validator: (items: IComboItem[]) =>
          Array.isArray(items) && items.length >= COMBO_LIMITS.MIN_ITEMS && items.length <= COMBO_LIMITS.MAX_ITEMS,
        message: `A combo must have between ${COMBO_LIMITS.MIN_ITEMS} and ${COMBO_LIMITS.MAX_ITEMS} items`,
      },
    },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null, index: true },
    status: {
      type: String,
      enum: { values: STATUSES, message: "Status must be ACTIVE or INACTIVE" },
      default: "ACTIVE",
      index: true,
    },
    displayOrder: { type: Number, default: 0, index: true },
    soldCount: { type: Number, default: 0, min: 0 },
    revenue: { type: Number, default: 0, min: 0 },
    views: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
  }
);

comboSchema.index({ status: 1, displayOrder: 1, createdAt: -1 });

const Combo = model<ICombo>("Combo", comboSchema);
export default Combo;
