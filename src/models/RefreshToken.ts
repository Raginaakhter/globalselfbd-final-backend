import { Schema, model, type Types } from "mongoose";

export interface IRefreshToken {
  user: Types.ObjectId;
  // SHA-256 hash of the refresh token (raw token is never stored)
  tokenHash: string;
  expiresAt: Date;
  createdByIp?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    createdByIp: String,
    userAgent: String,
  },
  {
    timestamps: true,
  }
);

// MongoDB automatically deletes expired refresh tokens
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RefreshToken = model<IRefreshToken>("RefreshToken", refreshTokenSchema);
export default RefreshToken;
