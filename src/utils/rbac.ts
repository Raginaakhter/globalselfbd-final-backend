import type { Types } from "mongoose";
import Role, { type RoleDocument } from "../models/Role";
import Permission, { type PermissionDocument } from "../models/Permission";
import RolePermission from "../models/RolePermission";
import User from "../models/User";
import AppError from "./AppError";
import { ROLES } from "../config/permissions";
import type { Status } from "../types/common";

type RoleRef = Types.ObjectId | string;

// Permission names assigned to a role (regardless of role status)
export const getRolePermissionNames = async (roleId: RoleRef): Promise<string[]> => {
  const links = await RolePermission.find({ role: roleId })
    .populate<{ permission: PermissionDocument | null }>("permission", "name")
    .lean();
  return links
    .map((link) => link.permission?.name)
    .filter((name): name is string => Boolean(name))
    .sort();
};

// Permissions a user can actually use right now (empty if the role is missing or inactive)
export const getEffectivePermissions = async (
  role: { _id: Types.ObjectId; status: Status } | null | undefined
): Promise<Set<string>> => {
  if (!role || role.status !== "ACTIVE") return new Set();
  return new Set(await getRolePermissionNames(role._id));
};

// Validate permission names and return their Permission documents
export const findPermissionsByNames = async (names: unknown): Promise<PermissionDocument[]> => {
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
    throw new AppError("Permissions must be an array of permission names", 400);
  }
  const unique = [...new Set(names as string[])];
  const permissions = await Permission.find({ name: { $in: unique } });
  const found = new Set(permissions.map((p) => p.name));
  const unknown = unique.filter((name) => !found.has(name));
  if (unknown.length) {
    throw new AppError(`Unknown permissions: ${unknown.join(", ")}`, 400);
  }
  return permissions;
};

// Replace a role's permissions; returns what was added and removed
export const setRolePermissions = async (
  roleId: RoleRef,
  permissions: PermissionDocument[]
): Promise<{ added: string[]; removed: string[] }> => {
  const current = await RolePermission.find({ role: roleId }).populate<{ permission: PermissionDocument | null }>(
    "permission",
    "name"
  );
  const currentNames = new Set(current.map((link) => link.permission?.name));
  const nextNames = new Set(permissions.map((p) => p.name));

  const toAdd = permissions.filter((p) => !currentNames.has(p.name));
  const toRemove = current.filter((link) => !link.permission || !nextNames.has(link.permission.name));

  if (toRemove.length) {
    await RolePermission.deleteMany({ _id: { $in: toRemove.map((link) => link._id) } });
  }
  if (toAdd.length) {
    await RolePermission.insertMany(
      toAdd.map((p) => ({ role: roleId, permission: p._id })),
      { ordered: false }
    );
  }

  return {
    added: toAdd.map((p) => p.name).sort(),
    removed: toRemove
      .map((link) => link.permission?.name)
      .filter((name): name is string => Boolean(name))
      .sort(),
  };
};

// Privilege escalation guard: the actor may only grant or manage permissions they hold.
// Used both for "role being assigned" and "role the target currently has".
export const assertWithinActorPermissions = (
  actorPermissions: Set<string> | undefined,
  permissionNames: string[],
  message?: string
): void => {
  const missing = permissionNames.filter((name) => !actorPermissions?.has(name));
  if (missing.length) {
    throw new AppError(message || "You cannot grant or manage permissions you do not have", 403);
  }
};

export const getAdminRole = (): Promise<RoleDocument | null> => Role.findOne({ name: ROLES.ADMIN });

// Prevent locking everyone out: at least one active Admin user must remain
export const assertNotLastActiveAdmin = async (user: {
  role: Types.ObjectId | { _id: Types.ObjectId } | null;
  status: Status;
}): Promise<void> => {
  const adminRole = await getAdminRole();
  if (!adminRole || !user.role) return;
  const userRoleId = "_id" in user.role ? user.role._id : user.role;
  if (String(userRoleId) !== String(adminRole._id)) return;
  if (user.status !== "ACTIVE") return;

  const activeAdmins = await User.countDocuments({ role: adminRole._id, status: "ACTIVE" });
  if (activeAdmins <= 1) {
    throw new AppError("Cannot remove the last active Admin user", 409);
  }
};
