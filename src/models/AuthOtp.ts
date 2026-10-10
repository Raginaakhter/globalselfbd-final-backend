import crypto from "crypto";
import { Schema, model, type HydratedDocument } from "mongoose";

// Staging table for the passwordless login/register OTP flow.
// One document per identifier (phone number OR email). A new OTP overwrites the
// previous one, so the earlier code becomes invalid immediately.
//
// Only the keyed hash of the OTP is stored. A 6-digit OTP has only 1_000_000
// values and a plain hash would be brute-forceable from a leaked database.
export interface IAuthOtp {
  identifier: string;          // normalized phone (01…) or lowercased email
  channel: "sms" | "email";
  otpHash: string;             // HMAC-SHA256 of the 6-digit code
  expiresAt: Date;             // mongo TTL also prunes expired docs
  attempts: number;            // bumped on every verify attempt (max 5)
  sentAt: Date;                // used for the resend cooldown
}

export type AuthOtpDocument = HydratedDocument<IAuthOtp>;

const authOtpSchema = new Schema<IAuthOtp>(
  {
    identifier: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    channel: { type: String, enum: ["sms", "email"], required: true },
    otpHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, required: true },
  },
  { timestamps: true }
);

export const hashOtpWithSecret = (otp: string): string =>
  crypto
    .createHmac("sha256", process.env.OTP_SECRET || process.env.JWT_ACCESS_SECRET || "")
    .update(String(otp))
    .digest("hex");

const AuthOtp = model<IAuthOtp>("AuthOtp", authOtpSchema);
export default AuthOtp;
