import { Schema, model, type HydratedDocument } from "mongoose";
import { STATUSES, type Status } from "../types/common";

// Where the banner shows on the landing page:
//  HERO  = the big banner (several = slider)
//  PROMO = the small promo cards next to it (at most MAX_ACTIVE_PROMO active at once)
export const BANNER_PLACEMENTS = ["HERO", "PROMO"] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];
export const MAX_ACTIVE_PROMO = 2;

// Landing page banner or promo card. Only the image is required; all text is optional.
export interface IBanner {
  placement: BannerPlacement;
  imageUrl: string;
  // Optional separate image for phones (falls back to imageUrl)
  mobileImageUrl: string;
  title: string;
  subtitle: string;
  description: string;
  buttonText: string;
  // "/shop" or "https://..."
  buttonLink: string;
  // Alternative text for screen readers / SEO
  altText: string;
  // Lower numbers show first
  sortOrder: number;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
}

export type BannerDocument = HydratedDocument<IBanner>;

export const BANNER_LIMITS = {
  TITLE_MAX: 120,
  SUBTITLE_MAX: 200,
  DESCRIPTION_MAX: 500,
  BUTTON_TEXT_MAX: 40,
  ALT_TEXT_MAX: 150,
} as const;

const bannerSchema = new Schema<IBanner>(
  {
    placement: {
      type: String,
      enum: { values: BANNER_PLACEMENTS, message: "Placement must be HERO or PROMO" },
      default: "HERO",
      index: true,
    },
    imageUrl: { type: String, required: [true, "Banner image is required"], trim: true },
    mobileImageUrl: { type: String, trim: true, default: "" },
    title: { type: String, trim: true, maxlength: BANNER_LIMITS.TITLE_MAX, default: "" },
    subtitle: { type: String, trim: true, maxlength: BANNER_LIMITS.SUBTITLE_MAX, default: "" },
    description: { type: String, trim: true, maxlength: BANNER_LIMITS.DESCRIPTION_MAX, default: "" },
    buttonText: { type: String, trim: true, maxlength: BANNER_LIMITS.BUTTON_TEXT_MAX, default: "" },
    buttonLink: { type: String, trim: true, default: "" },
    altText: { type: String, trim: true, maxlength: BANNER_LIMITS.ALT_TEXT_MAX, default: "" },
    sortOrder: { type: Number, default: 0, index: true },
    status: {
      type: String,
      enum: { values: STATUSES, message: "Status must be ACTIVE or INACTIVE" },
      default: "ACTIVE",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const Banner = model<IBanner>("Banner", bannerSchema);
export default Banner;
