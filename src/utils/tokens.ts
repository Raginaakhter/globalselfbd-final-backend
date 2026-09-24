import crypto from "crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { CookieOptions, Request, Response } from "express";
import type { Types } from "mongoose";
import RefreshToken from "../models/RefreshToken";
import type { AuthUser } from "../models/User";
import { getEffectivePermissions } from "./rbac";
import { getDashboardMenu } from "../config/dashboardMenu";

type UserId = Types.ObjectId | string;
type Duration = NonNullable<SignOptions["expiresIn"]>;

export const hashToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

// Convert "15m", "7d", "12h", "30s" into milliseconds
const toMs = (value: string | undefined): number => {
  const match = /^(\d+)([smhd])$/.exec(value || "");
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Number(match[1]) * units[match[2]];
};

const secret = (name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET"): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export const generateAccessToken = (userId: UserId): string =>
  jwt.sign({ id: String(userId) }, secret("JWT_ACCESS_SECRET"), {
    expiresIn: process.env.JWT_ACCESS_EXPIRE as Duration,
  });

// Create a refresh token and store its hash in the database
export const generateRefreshToken = async (userId: UserId, req: Request): Promise<string> => {
  const token = jwt.sign({ id: String(userId), jti: crypto.randomUUID() }, secret("JWT_REFRESH_SECRET"), {
    expiresIn: process.env.JWT_REFRESH_EXPIRE as Duration,
  });

  await RefreshToken.create({
    user: userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + toMs(process.env.JWT_REFRESH_EXPIRE)),
    createdByIp: req.ip,
    userAgent: req.get("user-agent"),
  });

  return token;
};

export const refreshCookieOptions = (): CookieOptions & { maxAge: number } => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/api/auth",
  maxAge: toMs(process.env.JWT_REFRESH_EXPIRE),
});

// Public user info + permissions + dashboard menu (user.role must be populated)
export const buildUserSession = async (user: AuthUser) => {
  const permissions = await getEffectivePermissions(user.role);
  return {
    user: {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      status: user.status,
      role: user.role ? { _id: user.role._id, name: user.role.name, status: user.role.status } : null,
      createdAt: user.createdAt,
    },
    permissions: [...permissions].sort(),
    menu: getDashboardMenu(permissions),
  };
};

// Issue both tokens, set refresh token cookie, and send the response
export const sendTokenResponse = async (
  user: AuthUser,
  statusCode: number,
  message: string,
  req: Request,
  res: Response
): Promise<void> => {
  const accessToken = generateAccessToken(user._id);
  const refreshToken = await generateRefreshToken(user._id, req);
  const session = await buildUserSession(user);

  res
    .status(statusCode)
    .cookie("refreshToken", refreshToken, refreshCookieOptions())
    .json({
      success: true,
      message,
      data: { ...session, accessToken, refreshToken },
    });
};
