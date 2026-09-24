import type { Request } from "express";
import type { Types } from "mongoose";
import ActivityLog, { type ActivityAction } from "../models/ActivityLog";

interface ActivityInput {
  action: ActivityAction;
  targetUserId?: Types.ObjectId;
  targetRoleId?: Types.ObjectId;
  targetOrderId?: Types.ObjectId;
  oldValue?: unknown;
  newValue?: unknown;
}

// Record an admin action. Logging must never break the request, so errors are only printed.
export const logActivity = async (
  req: Request,
  { action, targetUserId, targetRoleId, targetOrderId, oldValue, newValue }: ActivityInput
): Promise<void> => {
  try {
    await ActivityLog.create({
      actorUserId: req.user?._id,
      action,
      targetUserId,
      targetRoleId,
      targetOrderId,
      oldValue,
      newValue,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
  } catch (error) {
    console.error(`❌ Activity log failed (${action}):`, (error as Error).message);
  }
};
