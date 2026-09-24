import type { Request, Response } from "express";
import Role, { type RoleDocument } from "../models/Role";
import User from "../models/User";
import RolePermission from "../models/RolePermission";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import {
  getRolePermissionNames,
  findPermissionsByNames,
  setRolePermissions,
  assertWithinActorPermissions,
} from "../utils/rbac";
import { isNonEmptyString, assertObjectId, assertStatus, queryString } from "../utils/validators";
import { getAuthUser } from "../middleware/auth";
import { ROLES } from "../config/permissions";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const roleSummary = (role: RoleDocument) => ({
  name: role.name,
  description: role.description,
  status: role.status,
});

const findRoleOr404 = async (id: unknown): Promise<RoleDocument> => {
  assertObjectId(id, "role ID");
  const role = await Role.findById(id);
  if (!role) throw new AppError("Role not found", 404);
  return role;
};

// The actor must hold every permission of a role before managing it,
// and nobody may modify the role they are using themselves.
const assertCanManageRole = async (req: Request, role: RoleDocument): Promise<string[]> => {
  const actor = getAuthUser(req);
  if (actor.role && String(actor.role._id) === String(role._id)) {
    throw new AppError("You cannot modify your own role", 403);
  }
  const rolePermissions = await getRolePermissionNames(role._id);
  assertWithinActorPermissions(
    req.permissions,
    rolePermissions,
    "You cannot manage a role that has permissions you do not have"
  );
  return rolePermissions;
};

const validateRoleInput = ({ name, description }: Body, { requireName }: { requireName: boolean }): void => {
  if (requireName || name !== undefined) {
    if (!isNonEmptyString(name)) throw new AppError("Role name is required", 400);
    if (name.trim().length < 2 || name.trim().length > 50) {
      throw new AppError("Role name must be 2-50 characters", 400);
    }
  }
  if (description !== undefined && typeof description !== "string") {
    throw new AppError("Description must be a string", 400);
  }
};

// @desc    Create a role
// @route   POST /api/roles
// @access  roles.create
export const createRole = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const { name, description = "", permissions = [], status = "ACTIVE" } = body;
  validateRoleInput({ name, description }, { requireName: true });
  assertStatus(status);

  const permissionDocs = await findPermissionsByNames(permissions);
  assertWithinActorPermissions(req.permissions, permissionDocs.map((p) => p.name));

  // Role.create throws a duplicate key error (409) if the name exists (case-insensitive)
  const role = await Role.create({ name: (name as string).trim(), description: description as string, status });
  const { added } = await setRolePermissions(role._id, permissionDocs);

  await logActivity(req, { action: "ROLE_CREATED", targetRoleId: role._id, newValue: roleSummary(role) });
  if (added.length) {
    await logActivity(req, { action: "PERMISSION_ASSIGNED", targetRoleId: role._id, newValue: added });
  }

  res.status(201).json({
    success: true,
    message: "Role created successfully",
    data: { ...role.toObject(), permissions: added, userCount: 0 },
  });
};

// @desc    List all roles with user and permission counts
// @route   GET /api/roles
// @access  roles.view
export const getRoles = async (req: Request, res: Response) => {
  const filter: Record<string, unknown> = {};
  const status = queryString(req.query.status);
  if (status) {
    assertStatus(status);
    filter.status = status;
  }

  const roles = await Role.find(filter).sort({ createdAt: 1 }).lean();
  const roleIds = roles.map((r) => r._id);

  const [userCounts, permissionCounts] = await Promise.all([
    User.aggregate<{ _id: unknown; count: number }>([
      { $match: { role: { $in: roleIds } } },
      { $group: { _id: "$role", count: { $sum: 1 } } },
    ]),
    RolePermission.aggregate<{ _id: unknown; count: number }>([
      { $match: { role: { $in: roleIds } } },
      { $group: { _id: "$role", count: { $sum: 1 } } },
    ]),
  ]);
  const toMap = (rows: { _id: unknown; count: number }[]) => new Map(rows.map((row) => [String(row._id), row.count]));
  const users = toMap(userCounts);
  const perms = toMap(permissionCounts);

  res.status(200).json({
    success: true,
    message: "Roles fetched successfully",
    data: roles.map((role) => ({
      ...role,
      userCount: users.get(String(role._id)) || 0,
      permissionCount: perms.get(String(role._id)) || 0,
    })),
  });
};

// @desc    Get one role with its permissions and user count
// @route   GET /api/roles/:id
// @access  roles.view
export const getRole = async (req: Request, res: Response) => {
  const role = await findRoleOr404(req.params.id);
  const [permissions, userCount] = await Promise.all([
    getRolePermissionNames(role._id),
    User.countDocuments({ role: role._id }),
  ]);

  res.status(200).json({
    success: true,
    message: "Role fetched successfully",
    data: { ...role.toObject(), permissions, userCount },
  });
};

// @desc    Update role name, description and/or permissions
// @route   PUT /api/roles/:id
// @access  roles.update
export const updateRole = async (req: Request, res: Response) => {
  const role = await findRoleOr404(req.params.id);
  const { name, description, permissions } = (req.body || {}) as Body;
  validateRoleInput({ name, description }, { requireName: false });

  const oldPermissions = await assertCanManageRole(req, role);

  if (role.isProtected && typeof name === "string" && name.trim() !== role.name) {
    throw new AppError(`The ${role.name} role cannot be renamed`, 400);
  }
  if (role.name === ROLES.ADMIN && permissions !== undefined) {
    throw new AppError("Admin role always has every permission and cannot be changed", 400);
  }

  const before = roleSummary(role);
  if (typeof name === "string") role.name = name.trim();
  if (typeof description === "string") role.description = description;
  await role.save();

  let changes: { added: string[]; removed: string[] } = { added: [], removed: [] };
  if (permissions !== undefined) {
    const permissionDocs = await findPermissionsByNames(permissions);
    assertWithinActorPermissions(req.permissions, permissionDocs.map((p) => p.name));
    changes = await setRolePermissions(role._id, permissionDocs);
  }

  const after = roleSummary(role);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await logActivity(req, { action: "ROLE_UPDATED", targetRoleId: role._id, oldValue: before, newValue: after });
  }
  if (changes.added.length) {
    await logActivity(req, { action: "PERMISSION_ASSIGNED", targetRoleId: role._id, newValue: changes.added });
  }
  if (changes.removed.length) {
    await logActivity(req, { action: "PERMISSION_REMOVED", targetRoleId: role._id, oldValue: changes.removed });
  }

  const [currentPermissions, userCount] = await Promise.all([
    permissions !== undefined ? getRolePermissionNames(role._id) : Promise.resolve(oldPermissions),
    User.countDocuments({ role: role._id }),
  ]);

  res.status(200).json({
    success: true,
    message: "Role updated successfully",
    data: { ...role.toObject(), permissions: currentPermissions, userCount },
  });
};

// @desc    Activate or deactivate a role
// @route   PATCH /api/roles/:id/status
// @access  roles.status
export const updateRoleStatus = async (req: Request, res: Response) => {
  const role = await findRoleOr404(req.params.id);
  const { status } = (req.body || {}) as Body;
  assertStatus(status);

  await assertCanManageRole(req, role);

  // Admin inactive = nobody can manage the system; Customer inactive = registration breaks
  if (role.isProtected && status === "INACTIVE") {
    throw new AppError(`The ${role.name} role cannot be deactivated`, 400);
  }
  if (role.status === status) {
    throw new AppError(`Role is already ${status}`, 400);
  }

  const oldStatus = role.status;
  role.status = status;
  await role.save();

  await logActivity(req, {
    action: "ROLE_STATUS_CHANGED",
    targetRoleId: role._id,
    oldValue: { status: oldStatus },
    newValue: { status },
  });

  res.status(200).json({
    success: true,
    message: `Role ${status === "ACTIVE" ? "activated" : "deactivated"} successfully`,
    data: role,
  });
};

// @desc    Delete a role (only if no users have it and it is not protected)
// @route   DELETE /api/roles/:id
// @access  roles.delete
export const deleteRole = async (req: Request, res: Response) => {
  const role = await findRoleOr404(req.params.id);

  if (role.isProtected) {
    throw new AppError(`The ${role.name} role is protected and cannot be deleted`, 400);
  }
  const permissions = await assertCanManageRole(req, role);

  const userCount = await User.countDocuments({ role: role._id });
  if (userCount > 0) {
    throw new AppError(
      `Cannot delete role: ${userCount} user(s) still have this role. Assign them to another active role first`,
      409
    );
  }

  await RolePermission.deleteMany({ role: role._id });
  await role.deleteOne();

  await logActivity(req, {
    action: "ROLE_DELETED",
    targetRoleId: role._id,
    oldValue: { ...roleSummary(role), permissions },
  });

  res.status(200).json({
    success: true,
    message: "Role deleted successfully",
    data: { _id: role._id, name: role.name },
  });
};
