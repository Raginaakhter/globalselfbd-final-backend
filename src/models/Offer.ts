import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// Offer campaign — a named promotion that applies a discount to one or more
// products (or whole categories) for a window of time, with a badge/banner.
export const OFFER_DISCOUNT_TYPES = ["PERCENTAGE", "FIXED"] as const;
export type OfferDiscountType = (typeof OFFER_DISCOUNT_TYPES)[number];

// Saved status + computed timeline make the five visible states
export const OFFER_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_STATES = ["ACTIVE", "INACTIVE", "SCHEDULED", "ENDED"] as const;
export type OfferState = (typeof OFFER_STATES)[number];

export const OFFER_LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 5000,
  SLUG_MAX: 120,
  BADGE_LABEL_MAX: 60,
  MAX_PRODUCTS: 500,
  MAX_CATEGORIES: 100,
} as const;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && HEX_COLOR.test(value.trim());

export interface IOffer {
  title: string;
  slug: string;
  description: string;
  bannerImage: string | null;
  // UI accent for the storefront badge (e.g. "#ff0040")
  badgeColor: string | null;
  // Short word shown on the badge (e.g. "SALE")
  badgeLabel: string;
  discountType: OfferDiscountType;
  // Percent (1-100) or taka amount
  discountValue: number;
  startsAt: Date;
  endsAt: Date;
  productIds: Types.ObjectId[];
  categoryIds: Types.ObjectId[];
  minOrderValue: number | null;
  status: OfferStatus;
  // Sort order in the storefront offer list
  displayOrder: number;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OfferDocument = HydratedDocument<IOffer>;

const offerSchema = new Schema<IOffer>(
  {
    title: {
      type: String,
      required: [true, "Offer title is required"],
      trim: true,
      maxlength: [OFFER_LIMITS.TITLE_MAX, `Title cannot exceed ${OFFER_LIMITS.TITLE_MAX} characters`],
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: OFFER_LIMITS.SLUG_MAX,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [OFFER_LIMITS.DESCRIPTION_MAX, `Description cannot exceed ${OFFER_LIMITS.DESCRIPTION_MAX} characters`],
      default: "",
    },
    bannerImage: { type: String, trim: true, default: null },
    badgeColor: { type: String, trim: true, default: null },
    badgeLabel: {
      type: String,
      trim: true,
      default: "",
      maxlength: [OFFER_LIMITS.BADGE_LABEL_MAX, `Badge label cannot exceed ${OFFER_LIMITS.BADGE_LABEL_MAX} characters`],
    },
    discountType: { type: String, enum: OFFER_DISCOUNT_TYPES, required: true },
    discountValue: { type: Number, required: true, min: 0.01 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true, index: true },
    productIds: [{ type: Schema.Types.ObjectId, ref: "Product" }],
    categoryIds: [{ type: Schema.Types.ObjectId, ref: "Category" }],
    minOrderValue: { type: Number, min: 0, default: null },
    status: { type: String, enum: OFFER_STATUSES, default: "ACTIVE", index: true },
    displayOrder: { type: Number, default: 0, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
  }
);

offerSchema.index({ status: 1, displayOrder: 1, createdAt: -1 });

export const offerState = (
  o: Pick<IOffer, "status" | "startsAt" | "endsAt">,
  now = new Date()
): OfferState => {
  if (o.status === "INACTIVE") return "INACTIVE";
  if (o.endsAt <= now) return "ENDED";
  if (o.startsAt > now) return "SCHEDULED";
  return "ACTIVE";
};

const Offer = model<IOffer>("Offer", offerSchema);
export default Offer;
