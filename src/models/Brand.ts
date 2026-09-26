import { Schema, model, type HydratedDocument } from "mongoose";
import { STATUSES, type Status } from "../types/common";

// Brands for the "Shop Top Brands" section
export interface IBrand {
  name: string;
  slug: string;
  logoUrl: string;
  description: string;
  // Optional link when the logo is clicked ("/brands/nike" or "https://...")
  link: string;
  // Shown in the landing page "Top Brands" section
  isFeatured: boolean;
  // Lower numbers show first
  sortOrder: number;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
}

export type BrandDocument = HydratedDocument<IBrand>;

export const BRAND_LIMITS = {
  NAME_MAX: 80,
  DESCRIPTION_MAX: 500,
} as const;

const brandSchema = new Schema<IBrand>(
  {
    name: {
      type: String,
      required: [true, "Brand name is required"],
      trim: true,
      maxlength: BRAND_LIMITS.NAME_MAX,
    },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 120 },
    logoUrl: { type: String, required: [true, "Brand logo is required"], trim: true },
    description: { type: String, trim: true, maxlength: BRAND_LIMITS.DESCRIPTION_MAX, default: "" },
    link: { type: String, trim: true, default: "" },
    isFeatured: { type: Boolean, default: true, index: true },
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

// Case-insensitive unique name ("Nike" and "nike" are the same brand)
brandSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

const Brand = model<IBrand>("Brand", brandSchema);
export default Brand;
