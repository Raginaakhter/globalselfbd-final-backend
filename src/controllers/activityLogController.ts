import type { Request, Response } from "express";
import ActivityLog, { ACTIVITY_ACTIONS, type ActivityAction } from "../models/ActivityLog";
import AppError from "../utils/AppError";
import { assertObjectId, getPagination, queryString } from "../utils/validators";

// @desc    List activity logs (filter by action, actor, target user/role/order)
// @route   GET /api/activity-logs
// @access  activityLogs.view
export const getActivityLogs = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter: Record<string, unknown> = {};

  const action = queryString(req.query.action);
  if (action) {
    if (!ACTIVITY_ACTIONS.includes(action as ActivityAction)) {
      throw new AppError(`Invalid action. Allowed: ${ACTIVITY_ACTIONS.join(", ")}`, 400);
    }
    filter.action = action;
  }
  for (const field of ["actorUserId", "targetUserId", "targetRoleId", "targetOrderId"] as const) {
    const value = req.query[field];
    if (value) {
      assertObjectId(value, field);
      filter[field] = value;
    }
  }

  const [logs, total] = await Promise.all([
    ActivityLog.find(filter)
      .populate("actorUserId", "fullName email")
      .populate("targetUserId", "fullName email")
      .populate("targetRoleId", "name")
      .populate("targetOrderId", "orderNumber")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    ActivityLog.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Activity logs fetched successfully",
    data: logs,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};
