import jwt, { type JwtPayload } from "jsonwebtoken";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import User, { type AuthUser } from "../models/User";
import type { RoleDocument } from "../models/Role";
import AppError from "../utils/AppError";
import { getEffectivePermissions } from "../utils/rbac";

interface AccessTokenPayload extends JwtPayload {
  id: string;
}

// Authentication: valid access token -> user exists -> user active -> password not changed since
export const authenticate: RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  const token = header && header.startsWith("Bearer ") ? header.split(" ")[1] : null;

  if (!token) {
    return next(new AppError("Not authorized, no token provided", 401));
  }

  let decoded: AccessTokenPayload;
  try {
    decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET || "") as AccessTokenPayload;
  } catch (error) {
    return next(
      new AppError(
        (error as Error).name === "TokenExpiredError" ? "Access token expired" : "Not authorized, token invalid",
        401
      )
    );
  }

  const user = await User.findById(decoded.id).populate<{ role: RoleDocument | null }>("role");
  if (!user) {
    return next(new AppError("User no longer exists", 401));
  }
  if (user.status !== "ACTIVE") {
    return next(new AppError("Your account is inactive", 403));
  }
  if (user.changedPasswordAfter(decoded.iat ?? 0)) {
    return next(new AppError("Password was changed recently, please login again", 401));
  }

  req.user = user;
  next();
};

// Like authenticate, but guests (no Authorization header) continue without req.user.
// A token that IS sent must still be valid.
export const optionalAuthenticate: RequestHandler = (req, res, next) => {
  if (!req.headers.authorization) return next();
  return authenticate(req, res, next);
};

// The logged-in user in a handler behind authenticate (throws 401 if the route forgot it)
export const getAuthUser = (req: Request): AuthUser => {
  if (!req.user) throw new AppError("Not authorized", 401);
  return req.user;
};

// Load the user's role + permissions once per request (req.permissions is a Set)
export const loadPermissions = async (req: Request): Promise<Set<string>> => {
  if (!req.permissions) {
    req.permissions = await getEffectivePermissions(req.user?.role);
  }
  return req.permissions;
};

// Authorization: user has a role and that role is ACTIVE; attaches req.permissions
export const authorize: RequestHandler = async (req, res, next) => {
  if (!req.user) {
    return next(new AppError("Not authorized", 401));
  }
  const role = req.user.role;
  if (!role) {
    return next(new AppError("You do not have a role assigned", 403));
  }
  if (role.status !== "ACTIVE") {
    return next(new AppError("Your role is inactive", 403));
  }
  await loadPermissions(req);
  next();
};

// Shared by requirePermission / requireAnyPermission
const checkPermissions =
  (mode: "all" | "any", required: string[]) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      return next(new AppError("Not authorized", 401));
    }
    const role = req.user.role;
    if (!role || role.status !== "ACTIVE") {
      return next(new AppError("Your role is inactive or missing", 403));
    }

    const permissions = await loadPermissions(req);
    const allowed =
      mode === "all" ? required.every((name) => permissions.has(name)) : required.some((name) => permissions.has(name));
    if (!allowed) {
      return next(new AppError("You do not have permission to perform this action", 403));
    }
    next();
  };

// Allow only if the user has ALL of the given permissions
export const requirePermission = (...required: string[]): RequestHandler => checkPermissions("all", required);

// Allow if the user has AT LEAST ONE of the given permissions
export const requireAnyPermission = (...required: string[]): RequestHandler => checkPermissions("any", required);
