import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import { STATUSES, LIMITS } from "../config/productOptions";
import type { Status } from "../types/common";

export interface ICategory {
  name: string;
  slug: string;
  // null = root category
  parentCategoryId: Types.ObjectId | null;
  imageUrl: string | null;
  description: string;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
}

export type CategoryDocument = HydratedDocument<ICategory>;

const categorySchema = new Schema<ICategory>(
  {
    name: {
      type: String,
      required: [true, "Category name is required"],
      trim: true,
      maxlength: [LIMITS.CATEGORY_NAME_MAX, `Category name cannot exceed ${LIMITS.CATEGORY_NAME_MAX} characters`],
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: LIMITS.SLUG_MAX,
    },
    parentCategoryId: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      default: null,
      index: true,
    },
    imageUrl: {
      type: String,
      trim: true,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [LIMITS.CATEGORY_DESCRIPTION_MAX, `Description cannot exceed ${LIMITS.CATEGORY_DESCRIPTION_MAX} characters`],
      default: "",
    },
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

// Case-insensitive unique name ("Fashion" and "fashion" are the same category)
categorySchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

const Category = model<ICategory>("Category", categorySchema);
export default Category;
