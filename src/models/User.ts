import crypto from "crypto";
import bcrypt from "bcryptjs";
import { Schema, model, type HydratedDocument, type Model, type Types } from "mongoose";
import type { RoleDocument } from "./Role";
import { STATUSES, type Status } from "../types/common";

export interface IUser {
  fullName: string;
  // Primary customer login identifier (canonical BD format, e.g. "01712345678").
  // Required for new accounts; historical users with no phone may still have "".
  phoneNumber: string;
  // Optional. Kept for historical orders and admin accounts; not required to register.
  email: string;
  // Passwordless-by-default: customers now log in with OTP, so a user may have no
  // password at all. Admin accounts seeded with a password still work.
  password: string;
  // Always set by the backend (never from client input)
  role: Types.ObjectId;
  status: Status;
  avatarUrl: string;
  passwordChangedAt?: Date;
  // Password reset OTP (only a keyed hash is stored)
  passwordResetOtp: string | null;
  passwordResetExpires: Date | null;
  passwordResetAttempts: number;
  passwordResetSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserMethods {
  matchPassword(enteredPassword: string): Promise<boolean>;
  changedPasswordAfter(tokenIssuedAt: number): boolean;
  createPasswordResetOtp(): string;
  clearPasswordResetOtp(): void;
  matchPasswordResetOtp(otp: string): boolean;
}

export type UserModel = Model<IUser, object, IUserMethods>;
export type UserDocument = HydratedDocument<IUser, IUserMethods>;

// A user loaded with populate("role") — what req.user holds
export type AuthUser = Omit<UserDocument, "role"> & { role: RoleDocument | null };

// Stripped from every JSON response
export const PRIVATE_FIELDS = [
  "password",
  "passwordChangedAt",
  "passwordResetOtp",
  "passwordResetExpires",
  "passwordResetAttempts",
  "passwordResetSentAt",
] as const;

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    fullName: {
      type: String,
      required: [true, "Full name is required"],
      trim: true,
      maxlength: [100, "Full name cannot exceed 100 characters"],
    },
    // Sparse+unique so historical users without a phone are allowed, but any two
    // accounts that DO have a phone cannot share one.
    phoneNumber: {
      type: String,
      trim: true,
      default: "",
      index: { unique: true, sparse: true, partialFilterExpression: { phoneNumber: { $type: "string", $ne: "" } } },
    },
    // Sparse+unique for the same reason: email is optional for customers now.
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: "",
      match: [/^$|^\S+@\S+\.\S+$/, "Please provide a valid email"],
      index: { unique: true, sparse: true, partialFilterExpression: { email: { $type: "string", $ne: "" } } },
    },
    password: {
      type: String,
      // Not required: passwordless OTP accounts never set one.
      minlength: [6, "Password must be at least 6 characters"],
      select: false, // Don't return password by default
    },
    role: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: [true, "Role is required"],
      index: true,
    },
    status: {
      type: String,
      enum: { values: STATUSES, message: "Status must be ACTIVE or INACTIVE" },
      default: "ACTIVE",
      index: true,
    },
    avatarUrl: { type: String, trim: true, default: "" },
    passwordChangedAt: Date,
    passwordResetOtp: { type: String, select: false, default: null },
    passwordResetExpires: { type: Date, select: false, default: null },
    passwordResetAttempts: { type: Number, select: false, default: 0 },
    passwordResetSentAt: { type: Date, select: false, default: null },
  },
  {
    timestamps: true,
    // Never send secrets or internal fields in API responses, even if a handler forgets to remove them
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        for (const field of PRIVATE_FIELDS) delete ret[field];
        return ret;
      },
    },
  }
);

// Hash password before saving
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  if (!this.isNew) this.passwordChangedAt = new Date();
});

// Compare entered password with hashed password. Passwordless accounts (OTP-only)
// have no password, so any password login attempt against them must fail.
userSchema.methods.matchPassword = async function (enteredPassword: string) {
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

// True if the password was changed after the token was issued
userSchema.methods.changedPasswordAfter = function (tokenIssuedAt: number) {
  if (!this.passwordChangedAt) return false;
  return Math.floor(this.passwordChangedAt.getTime() / 1000) > tokenIssuedAt;
};

// A 6-digit OTP has only 1,000,000 values, so a plain hash could be brute-forced
// from a leaked database. A keyed hash (HMAC with a server secret) prevents that.
const hashOtp = (otp: string): string =>
  crypto
    .createHmac("sha256", process.env.OTP_SECRET || process.env.JWT_ACCESS_SECRET || "")
    .update(String(otp))
    .digest("hex");

// Create a new 6-digit reset OTP; returns the plain code (to email) and stores its hash
userSchema.methods.createPasswordResetOtp = function () {
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  this.passwordResetOtp = hashOtp(otp);
  this.passwordResetExpires = new Date(
    Date.now() + (Number(process.env.RESET_OTP_EXPIRE_MINUTES) || 10) * 60 * 1000
  );
  this.passwordResetAttempts = 0;
  this.passwordResetSentAt = new Date();
  return otp;
};

userSchema.methods.clearPasswordResetOtp = function () {
  this.passwordResetOtp = null;
  this.passwordResetExpires = null;
  this.passwordResetAttempts = 0;
};

// Constant-time comparison of an entered OTP with the stored hash
userSchema.methods.matchPasswordResetOtp = function (otp: string) {
  if (!this.passwordResetOtp || typeof otp !== "string") return false;
  const a = Buffer.from(hashOtp(otp));
  const b = Buffer.from(this.passwordResetOtp);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const User = model<IUser, UserModel>("User", userSchema);
export default User;
