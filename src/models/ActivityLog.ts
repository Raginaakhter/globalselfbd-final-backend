import { Schema, model, type Types } from "mongoose";

export const ACTIVITY_ACTIONS = [
  "ROLE_CREATED",
  "ROLE_UPDATED",
  "ROLE_DELETED",
  "ROLE_STATUS_CHANGED",
  "USER_ROLE_CHANGED",
  "USER_CREATED",
  "USER_DELETED",
  "USER_STATUS_CHANGED",
  "USER_UPDATED",
  "PERMISSION_ASSIGNED",
  "PERMISSION_REMOVED",
  "ORDER_CREATED",
  "ORDER_CONFIRMED",
  "ORDER_PROCESSING",
  "ORDER_READY_TO_SHIP",
  "ORDER_SHIPPED",
  "ORDER_OUT_FOR_DELIVERY",
  "ORDER_DELIVERED",
  "ORDER_CANCELLED",
  "ORDER_DELETED",
  "ORDER_PRE_ORDER_UPDATED",
  "ORDER_ADMIN_NOTE_ADDED",
  "PRODUCT_PRE_ORDER_UPDATED",
  "PAYMENT_STATUS_CHANGED",
  "REVIEW_CREATED",
  "REVIEW_APPROVED",
  "REVIEW_REJECTED",
  "REVIEW_HIDDEN",
  "REVIEW_PENDING",
  "REVIEW_DELETED",
  "REVIEW_HOMEPAGE_ENABLED",
  "REVIEW_HOMEPAGE_DISABLED",
  "REVIEW_PRODUCTS_UPDATED",
  "COMBO_CREATED",
  "COMBO_UPDATED",
  "COMBO_DELETED",
  "COMBO_STATUS_CHANGED",
  "COMBO_REORDERED",
  "OFFER_CREATED",
  "OFFER_UPDATED",
  "OFFER_DELETED",
  "OFFER_STATUS_CHANGED",
  "OFFER_PRODUCTS_UPDATED",
  "PRODUCT_BULK_DISCOUNT_APPLIED",
  "PRODUCT_BULK_DISCOUNT_REMOVED",
  "INVENTORY_STOCK_ADJUSTED",
  "INVENTORY_THRESHOLD_UPDATED",
  "INVENTORY_DAMAGE_RECORDED",
  "INVENTORY_RETURN_RECORDED",
  "SUPPLIER_CREATED",
  "SUPPLIER_UPDATED",
  "SUPPLIER_DELETED",
  "SHIPMENT_CREATED",
  "SHIPMENT_UPDATED",
  "SHIPMENT_DELETED",
  "SHIPMENT_RECEIVED",
  "SHIPMENT_ITEM_UPDATED",
  "STOCK_REQUEST_CREATED",
  "STOCK_REQUEST_UPDATED",
  "STOCK_REQUEST_DELETED",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface IActivityLog {
  actorUserId?: Types.ObjectId;
  action: ActivityAction;
  targetUserId?: Types.ObjectId;
  targetRoleId?: Types.ObjectId;
  targetOrderId?: Types.ObjectId;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    action: {
      type: String,
      enum: ACTIVITY_ACTIONS,
      required: true,
      index: true,
    },
    targetUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    targetRoleId: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      index: true,
    },
    targetOrderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      index: true,
    },
    oldValue: Schema.Types.Mixed,
    newValue: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
  },
  {
    // Logs are never edited, so only createdAt is needed
    timestamps: { createdAt: true, updatedAt: false },
  }
);

activityLogSchema.index({ createdAt: -1 });

const ActivityLog = model<IActivityLog>("ActivityLog", activityLogSchema);
export default ActivityLog;
