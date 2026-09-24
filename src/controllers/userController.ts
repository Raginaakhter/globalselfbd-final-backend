import type { Request, Response } from "express";
import User from "../models/User";
import Role, { type RoleDocument } from "../models/Role";
import RefreshToken from "../models/RefreshToken";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import { getRolePermissionNames, assertWithinActorPermissions, assertNotLastActiveAdmin } from "../utils/rbac";
import {
  isNonEmptyString,
  assertObjectId,
  assertStatus,
  escapeRegex,
  getPagination,
  queryString,
} from "../utils/validators";
import { getAuthUser } from "../middleware/auth";
import { ROLES } from "../config/permissions";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const ROLE_FIELDS = "name status isProtected";

const findUserOr404 = async (id: unknown) => {
  assertObjectId(id, "user ID");
  const user = await User.findById(id).populate<{ role: RoleDocument | null }>("role", ROLE_FIELDS);
  if (!user) throw new AppError("User not found", 404);
  return user;
};
type LoadedUser = Awaited<ReturnType<typeof findUserOr404>>;

// Actor may not act on themselves or on a user whose role has permissions the actor lacks
// (e.g. a Manager cannot touch an Admin).
const assertCanManageUser = async (req: Request, target: LoadedUser): Promise<void> => {
  if (String(target._id) === String(getAuthUser(req)._id)) {
    throw new AppError("You cannot perform this action on your own account", 403);
  }
  if (target.role) {
    const targetPermissions = await getRolePermissionNames(target.role._id);
    assertWithinActorPermissions(
      req.permissions,
      targetPermissions,
      "You cannot manage a user who has permissions you do not have"
    );
  }
};

// The role being assigned must exist, be ACTIVE and not exceed the actor's permissions
const findAssignableRole = async (req: Request, roleId: unknown): Promise<RoleDocument> => {
  assertObjectId(roleId, "role ID");
  const role = await Role.findById(roleId);
  if (!role) throw new AppError("Role not found", 404);
  if (role.status !== "ACTIVE") {
    throw new AppError("Cannot assign an inactive role", 400);
  }
  const rolePermissions = await getRolePermissionNames(role._id);
  assertWithinActorPermissions(
    req.permissions,
    rolePermissions,
    "You cannot assign a role that has permissions you do not have"
  );
  return role;
};

const roleRef = (role: RoleDocument | null) => (role ? { _id: role._id, name: role.name } : null);

// @desc    List users (search, filter by role/status, paginated)
// @route   GET /api/users
// @access  users.view
export const getUsers = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter: Record<string, unknown> = {};

  const role = queryString(req.query.role);
  if (role) {
    assertObjectId(role, "role ID");
    filter.role = role;
  }
  const status = queryString(req.query.status);
  if (status) {
    assertStatus(status);
    filter.status = status;
  }
  const search = queryString(req.query.search);
  if (isNonEmptyString(search)) {
    const pattern = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ fullName: pattern }, { email: pattern }];
  }

  const [users, total] = await Promise.all([
    User.find(filter).populate("role", ROLE_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Users fetched successfully",
    data: users,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    Get one user
// @route   GET /api/users/:id
// @access  users.view
export const getUser = async (req: Request, res: Response) => {
  const user = await findUserOr404(req.params.id);
  res.status(200).json({
    success: true,
    message: "User fetched successfully",
    data: user,
  });
};

// @desc    Create a user with a role (e.g. staff accounts)
// @route   POST /api/users
// @access  users.create
export const createUser = async (req: Request, res: Response) => {
  const { fullName, email, password, roleId } = (req.body || {}) as Body;

  if (!isNonEmptyString(fullName) || !isNonEmptyString(email)) {
    throw new AppError("Please provide full name and email", 400);
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new AppError("Please provide a valid email", 400);
  }
  if (typeof password !== "string" || password.length < 6) {
    throw new AppError("Password must be at least 6 characters", 400);
  }

  let role: RoleDocument | null;
  if (roleId !== undefined) {
    role = await findAssignableRole(req, roleId);
  } else {
    role = await Role.findOne({ name: ROLES.CUSTOMER, status: "ACTIVE" });
    if (!role) throw new AppError("Default Customer role is not available", 500);
  }

  if (await User.exists({ email: email.toLowerCase() })) {
    throw new AppError("User already exists with this email", 409);
  }

  const user = await User.create({ fullName, email, password, role: role._id });

  await logActivity(req, {
    action: "USER_CREATED",
    targetUserId: user._id,
    targetRoleId: role._id,
    newValue: { fullName: user.fullName, email: user.email, role: role.name },
  });

  const { password: _password, ...data } = user.toObject();

  res.status(201).json({
    success: true,
    message: "User created successfully",
    data: { ...data, role: roleRef(role) },
  });
};

// @desc    Change a user's role
// @route   PATCH /api/users/:id/role
// @access  users.changeRole
export const changeUserRole = async (req: Request, res: Response) => {
  const { roleId } = (req.body || {}) as Body;
  if (!roleId) throw new AppError("roleId is required", 400);

  const user = await findUserOr404(req.params.id);
  await assertCanManageUser(req, user);
  const newRole = await findAssignableRole(req, roleId);

  if (user.role && String(user.role._id) === String(newRole._id)) {
    throw new AppError(`User already has the ${newRole.name} role`, 400);
  }
  await assertNotLastActiveAdmin(user);

  const oldRole = user.role;
  await User.updateOne({ _id: user._id }, { $set: { role: newRole._id } });

  await logActivity(req, {
    action: "USER_ROLE_CHANGED",
    targetUserId: user._id,
    targetRoleId: newRole._id,
    oldValue: roleRef(oldRole),
    newValue: roleRef(newRole),
  });

  user.role = newRole;
  res.status(200).json({
    success: true,
    message: "User role updated successfully",
    data: user,
  });
};

// @desc    Activate or deactivate a user
// @route   PATCH /api/users/:id/status
// @access  users.update
export const updateUserStatus = async (req: Request, res: Response) => {
  const { status } = (req.body || {}) as Body;
  assertStatus(status);

  const user = await findUserOr404(req.params.id);
  await assertCanManageUser(req, user);

  if (user.status === status) {
    throw new AppError(`User is already ${status}`, 400);
  }
  if (status === "INACTIVE") {
    await assertNotLastActiveAdmin(user);
  }

  const oldStatus = user.status;
  user.status = status;
  await user.save({ validateBeforeSave: false });

  // Deactivated users are logged out everywhere
  if (status === "INACTIVE") {
    await RefreshToken.deleteMany({ user: user._id });
  }

  await logActivity(req, {
    action: "USER_STATUS_CHANGED",
    targetUserId: user._id,
    oldValue: { status: oldStatus },
    newValue: { status },
  });

  res.status(200).json({
    success: true,
    message: `User ${status === "ACTIVE" ? "activated" : "deactivated"} successfully`,
    data: user,
  });
};

// @desc    Delete a user
// @route   DELETE /api/users/:id
// @access  users.delete
export const deleteUser = async (req: Request, res: Response) => {
  const user = await findUserOr404(req.params.id);
  await assertCanManageUser(req, user);
  await assertNotLastActiveAdmin(user);

  await RefreshToken.deleteMany({ user: user._id });
  await user.deleteOne();

  await logActivity(req, {
    action: "USER_DELETED",
    targetUserId: user._id,
    targetRoleId: user.role?._id,
    oldValue: {
      fullName: user.fullName,
      email: user.email,
      role: user.role?.name,
      status: user.status,
    },
  });

  res.status(200).json({
    success: true,
    message: "User deleted successfully",
    data: { _id: user._id },
  });
};
