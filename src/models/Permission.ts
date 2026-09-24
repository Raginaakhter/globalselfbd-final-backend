import { Schema, model, type HydratedDocument } from "mongoose";

export interface IPermission {
  // Format: "<module>.<action>", e.g. "users.view"
  name: string;
  module: string;
  action: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PermissionDocument = HydratedDocument<IPermission>;

const permissionSchema = new Schema<IPermission>(
  {
    name: {
      type: String,
      required: [true, "Permission name is required"],
      unique: true,
      trim: true,
      match: [/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/, "Invalid permission name"],
    },
    module: {
      type: String,
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
    },
    description: String,
  },
  {
    timestamps: true,
  }
);

const Permission = model<IPermission>("Permission", permissionSchema);
export default Permission;
