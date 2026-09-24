import { Schema, model, type Types } from "mongoose";

// Join table: which permissions each role has
export interface IRolePermission {
  role: Types.ObjectId;
  permission: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const rolePermissionSchema = new Schema<IRolePermission>(
  {
    role: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },
    permission: {
      type: Schema.Types.ObjectId,
      ref: "Permission",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

rolePermissionSchema.index({ role: 1, permission: 1 }, { unique: true });

const RolePermission = model<IRolePermission>("RolePermission", rolePermissionSchema);
export default RolePermission;
