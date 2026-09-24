import { Schema, model, type HydratedDocument } from "mongoose";
import { STATUSES, type Status } from "../types/common";

export const ROLE_STATUS = STATUSES;

export interface IRole {
  name: string;
  description: string;
  status: Status;
  // Protected roles (Admin, Customer) cannot be deleted, renamed or deactivated
  isProtected: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type RoleDocument = HydratedDocument<IRole>;

const roleSchema = new Schema<IRole>(
  {
    name: {
      type: String,
      required: [true, "Role name is required"],
      trim: true,
      minlength: [2, "Role name must be at least 2 characters"],
      maxlength: [50, "Role name cannot exceed 50 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [255, "Description cannot exceed 255 characters"],
      default: "",
    },
    status: {
      type: String,
      enum: { values: ROLE_STATUS, message: "Status must be ACTIVE or INACTIVE" },
      default: "ACTIVE",
    },
    isProtected: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Case-insensitive unique name ("manager" and "Manager" are the same role)
roleSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

const Role = model<IRole>("Role", roleSchema);
export default Role;
