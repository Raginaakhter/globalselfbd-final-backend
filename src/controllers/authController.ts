import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Request, Response } from "express";
import User from "../models/User";
import Role, { type RoleDocument } from "../models/Role";
import RefreshToken from "../models/RefreshToken";
import AppError from "../utils/AppError";
import {
  hashToken,
  generateAccessToken,
  generateRefreshToken,
  refreshCookieOptions,
  buildUserSession,
  sendTokenResponse,
} from "../utils/tokens";
import { isNonEmptyString, normalizeBdPhone } from "../utils/validators";
import { isValidImageUrl } from "../utils/imageValidation";
import { isEmailConfigured, sendPasswordResetOtpEmail } from "../utils/sendEmail";
import { getAuthUser } from "../middleware/auth";
import { ROLES } from "../config/permissions";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;

// Validate password + confirm password
function validatePasswords(password: unknown, confirmPassword: unknown): asserts password is string {
  if (typeof password !== "string" || typeof confirmPassword !== "string" || !password || !confirmPassword) {
    throw new AppError("Please provide password and confirm password", 400);
  }
  if (password.length < 6) {
    throw new AppError("Password must be at least 6 characters", 400);
  }
  if (password !== confirmPassword) {
    throw new AppError("Password and confirm password do not match", 400);
  }
}

function assertEmail(email: unknown): asserts email is string {
  if (!isNonEmptyString(email) || !EMAIL_REGEX.test(email)) {
    throw new AppError("Please provide a valid email", 400);
  }
}

// Read the refresh token from the cookie or the request body
const getRefreshTokenFromRequest = (req: Request): string | null => {
  const token = req.cookies?.refreshToken || (req.body as Body | undefined)?.refreshToken;
  return typeof token === "string" ? token : null;
};

// @desc    Register a new user (always gets the Customer role)
// @route   POST /api/auth/register
// @access  Public
export const register = async (req: Request, res: Response) => {
  // Only these fields are read; any "role" sent by the client is ignored
  const { fullName, email, password, confirmPassword } = (req.body || {}) as Body;

  if (!isNonEmptyString(fullName)) {
    throw new AppError("Please provide full name", 400);
  }
  assertEmail(email);
  validatePasswords(password, confirmPassword);

  if (await User.exists({ email: email.toLowerCase() })) {
    throw new AppError("User already exists with this email", 409);
  }

  const customerRole = await Role.findOne({ name: ROLES.CUSTOMER, status: "ACTIVE" });
  if (!customerRole) {
    throw new AppError("Registration is temporarily unavailable", 503);
  }

  const created = await User.create({ fullName, email, password, role: customerRole._id });
  const user = await created.populate<{ role: RoleDocument | null }>("role");

  await sendTokenResponse(user, 201, "User registered successfully", req, res);
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
export const login = async (req: Request, res: Response) => {
  const { email, password } = (req.body || {}) as Body;

  if (!isNonEmptyString(email) || typeof password !== "string" || !password) {
    throw new AppError("Please provide email and password", 400);
  }

  // Find user and include password field
  const user = await User.findOne({ email: email.toLowerCase() })
    .select("+password")
    .populate<{ role: RoleDocument | null }>("role");
  if (!user || !(await user.matchPassword(password))) {
    throw new AppError("Invalid email or password", 401);
  }
  if (user.status !== "ACTIVE") {
    throw new AppError("Your account is inactive. Please contact support", 403);
  }

  await sendTokenResponse(user, 200, "Login successful", req, res);
};

// @desc    Get a new access token using a refresh token (rotates the refresh token)
// @route   POST /api/auth/refresh-token
// @access  Public (requires refresh token)
export const refreshToken = async (req: Request, res: Response) => {
  const token = getRefreshTokenFromRequest(req);
  if (!token) {
    throw new AppError("Refresh token not provided", 401);
  }

  let decoded: JwtPayload & { id: string };
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET || "") as JwtPayload & { id: string };
  } catch {
    throw new AppError("Refresh token invalid or expired", 401);
  }

  const storedToken = await RefreshToken.findOneAndDelete({ tokenHash: hashToken(token) });

  // Valid signature but not in DB => token was already used or revoked.
  // Treat as possible theft and log the user out of every device.
  if (!storedToken) {
    await RefreshToken.deleteMany({ user: decoded.id });
    throw new AppError("Refresh token reuse detected, please login again", 401);
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    throw new AppError("User no longer exists", 401);
  }
  if (user.status !== "ACTIVE") {
    throw new AppError("Your account is inactive", 403);
  }

  const accessToken = generateAccessToken(user._id);
  const newRefreshToken = await generateRefreshToken(user._id, req);

  res
    .status(200)
    .cookie("refreshToken", newRefreshToken, refreshCookieOptions())
    .json({
      success: true,
      message: "Token refreshed successfully",
      data: { accessToken, refreshToken: newRefreshToken },
    });
};

// @desc    Logout user (revoke refresh token)
// @route   POST /api/auth/logout
// @access  Public
export const logout = async (req: Request, res: Response) => {
  const token = getRefreshTokenFromRequest(req);
  if (token) {
    await RefreshToken.deleteOne({ tokenHash: hashToken(token) });
  }

  const { maxAge: _maxAge, ...cookieOptions } = refreshCookieOptions();
  res.clearCookie("refreshToken", cookieOptions).status(200).json({
    success: true,
    message: "Logged out successfully",
    data: null,
  });
};

// @desc    Get logged-in user profile, permissions and dashboard menu
// @route   GET /api/auth/me
// @access  Private (any logged-in user)
export const getMe = async (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Profile fetched successfully",
    data: await buildUserSession(getAuthUser(req)),
  });
};

// @desc    Edit my profile: full name, phone, avatar, email (email needs the current password).
//          The password is never changed here: use forgot-password (email OTP) instead.
// @route   PUT /api/auth/me
// @access  Private (any logged-in user, own account only)
export const updateMe = async (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  const body = (req.body || {}) as Body;
  const { fullName, phone, avatarUrl, email, currentPassword } = body;

  // Role, status and password are never changed here
  if (fullName === undefined && phone === undefined && avatarUrl === undefined && email === undefined) {
    throw new AppError("Send at least one field to update: fullName, phone, avatarUrl or email", 400);
  }

  const user = await User.findById(authUser._id).select("+password");
  if (!user) throw new AppError("User no longer exists", 401);

  if (fullName !== undefined) {
    if (!isNonEmptyString(fullName)) throw new AppError("Full name cannot be empty", 400);
    if (fullName.trim().length > 100) throw new AppError("Full name cannot exceed 100 characters", 400);
    user.fullName = fullName.trim();
  }

  if (phone !== undefined) {
    if (phone === null || phone === "") {
      user.phone = "";
    } else {
      const normalized = typeof phone === "string" ? normalizeBdPhone(phone) : null;
      if (!normalized) throw new AppError("Please provide a valid Bangladeshi phone number (e.g. 01712345678)", 400);
      user.phone = normalized;
    }
  }

  if (avatarUrl !== undefined) {
    if (avatarUrl === null || avatarUrl === "") user.avatarUrl = "";
    else if (!isValidImageUrl(avatarUrl)) throw new AppError("Avatar must be a valid image URL", 400);
    else user.avatarUrl = avatarUrl.trim();
  }

  if (email !== undefined) {
    assertEmail(email);
    const newEmail = email.trim().toLowerCase();
    if (newEmail !== user.email) {
      // Changing the login email is sensitive: confirm with the current password
      if (typeof currentPassword !== "string" || !currentPassword) {
        throw new AppError("Enter your current password to change your email", 400);
      }
      if (!(await user.matchPassword(currentPassword))) {
        throw new AppError("Current password is incorrect", 401);
      }
      if (await User.exists({ email: newEmail, _id: { $ne: user._id } })) {
        throw new AppError("This email is already used by another account", 409);
      }
      user.email = newEmail;
    }
  }

  await user.save();

  const updated = await User.findById(user._id).populate<{ role: RoleDocument | null }>("role");
  if (!updated) throw new AppError("User no longer exists", 401);
  res.status(200).json({
    success: true,
    message: "Profile updated successfully",
    data: await buildUserSession(updated),
  });
};

const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;
const OTP_FIELDS = "+passwordResetOtp +passwordResetExpires +passwordResetAttempts +passwordResetSentAt";
const OTP_INVALID = "OTP is invalid or has expired. Please request a new one";

function assertOtpFormat(otp: unknown): asserts otp is string {
  if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    throw new AppError("OTP must be a 6-digit code", 400);
  }
}

// Check an OTP. Each check uses up one attempt atomically, so sending many
// guesses at the same time cannot get around the 5-attempt limit.
const checkResetOtp = async (email: string, otp: string) => {
  const user = await User.findOneAndUpdate(
    {
      email: email.toLowerCase(),
      passwordResetOtp: { $ne: null },
      passwordResetExpires: { $gt: new Date() },
      passwordResetAttempts: { $lt: OTP_MAX_ATTEMPTS },
    },
    { $inc: { passwordResetAttempts: 1 } },
    { returnDocument: "after" }
  ).select(OTP_FIELDS);

  if (!user) throw new AppError(OTP_INVALID, 400);

  if (!user.matchPasswordResetOtp(otp)) {
    const left = OTP_MAX_ATTEMPTS - user.passwordResetAttempts;
    if (left <= 0) {
      user.clearPasswordResetOtp();
      await user.save({ validateBeforeSave: false });
      throw new AppError("Too many wrong attempts. Please request a new OTP", 400);
    }
    throw new AppError(`Invalid OTP. ${left} attempt(s) left`, 400);
  }
  return user;
};

// @desc    Email a 6-digit password reset OTP
// @route   POST /api/auth/forgot-password
// @access  Public
export const forgotPassword = async (req: Request, res: Response) => {
  const genericMessage = "If an account exists with this email, an OTP has been sent";
  const isDev = process.env.NODE_ENV === "development";

  const { email } = (req.body || {}) as Body;
  assertEmail(email);

  const user = await User.findOne({ email: email.toLowerCase() }).select(OTP_FIELDS);

  // Same response whether or not the email exists (prevents email enumeration)
  if (!user) {
    return res.status(200).json({ success: true, message: genericMessage, data: null });
  }

  // Without an email service the OTP can only be shown in development
  if (!isEmailConfigured() && !isDev) {
    throw new AppError("Password reset is not available yet", 503);
  }

  // Resend cooldown: the previous code stays valid, no new email is sent
  const secondsSinceLast = user.passwordResetSentAt
    ? (Date.now() - user.passwordResetSentAt.getTime()) / 1000
    : Infinity;
  if (secondsSinceLast < OTP_RESEND_SECONDS) {
    const wait = Math.ceil(OTP_RESEND_SECONDS - secondsSinceLast);
    throw new AppError(`Please wait ${wait} seconds before requesting a new OTP`, 429);
  }

  const otp = user.createPasswordResetOtp();
  await user.save({ validateBeforeSave: false });

  const minutes = Number(process.env.RESET_OTP_EXPIRE_MINUTES) || 10;
  let emailSent = false;

  if (isEmailConfigured()) {
    try {
      await sendPasswordResetOtpEmail(user, otp, minutes);
      emailSent = true;
    } catch (error) {
      // In production a failed email must not leave a usable code behind
      if (!isDev) {
        user.clearPasswordResetOtp();
        user.passwordResetSentAt = null;
        await user.save({ validateBeforeSave: false });
        throw error;
      }
    }
  }

  if (isDev) console.log(`🔑 Password reset OTP for ${user.email}: ${otp}`);

  return res.status(200).json({
    success: true,
    message: genericMessage,
    // The OTP is never returned in production (anyone could reset any account)
    data: {
      expiresInMinutes: minutes,
      resendAfterSeconds: OTP_RESEND_SECONDS,
      ...(isDev ? { devOnly: { emailSent, otp } } : {}),
    },
  });
};

// @desc    Check the OTP (first screen); the same OTP is then sent with the new password
// @route   POST /api/auth/verify-reset-otp
// @access  Public
export const verifyResetOtp = async (req: Request, res: Response) => {
  const { email, otp } = (req.body || {}) as Body;
  assertEmail(email);
  assertOtpFormat(otp);

  await checkResetOtp(email, otp);

  res.status(200).json({
    success: true,
    message: "OTP verified. You can now set a new password",
    data: null,
  });
};

// @desc    Set a new password with the email + OTP
// @route   POST /api/auth/reset-password
// @access  Public
export const resetPassword = async (req: Request, res: Response) => {
  const { email, otp, password, confirmPassword } = (req.body || {}) as Body;
  assertEmail(email);
  assertOtpFormat(otp);
  validatePasswords(password, confirmPassword);

  const user = await checkResetOtp(email, otp);

  user.password = password;
  user.clearPasswordResetOtp();
  await user.save();

  // Log out from every device after a password reset
  await RefreshToken.deleteMany({ user: user._id });

  res.status(200).json({
    success: true,
    message: "Password reset successful, please login with your new password",
    data: null,
  });
};
