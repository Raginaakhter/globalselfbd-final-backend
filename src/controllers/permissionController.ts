import type { Request, Response } from "express";
import Permission, { type IPermission } from "../models/Permission";

// Permissions are defined in config/permissions.ts (the code checks them by name),
// so they are read-only through the API. Roles decide who gets which permission.

// @desc    List all permissions, grouped by module
// @route   GET /api/permissions
// @access  permissions.view
export const getPermissions = async (req: Request, res: Response) => {
  const permissions = await Permission.find().select("-__v").sort({ module: 1, name: 1 }).lean();

  const grouped: Record<string, IPermission[]> = {};
  for (const permission of permissions) {
    (grouped[permission.module] ||= []).push(permission);
  }

  res.status(200).json({
    success: true,
    message: "Permissions fetched successfully",
    data: { total: permissions.length, modules: grouped },
  });
};
