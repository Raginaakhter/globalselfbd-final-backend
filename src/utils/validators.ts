import mongoose from "mongoose";
import AppError from "./AppError";
import { STATUSES, type Status } from "../types/common";

export { STATUSES };

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function assertObjectId(id: unknown, label = "ID"): asserts id is string {
  if (typeof id !== "string" || !mongoose.isValidObjectId(id)) {
    throw new AppError(`Invalid ${label}`, 400);
  }
}

export function assertStatus(status: unknown): asserts status is Status {
  if (!(STATUSES as readonly unknown[]).includes(status)) {
    throw new AppError("Status must be ACTIVE or INACTIVE", 400);
  }
}

// Escape user input before using it inside a RegExp (search)
export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A query-string value as a plain string (ignores arrays/objects like ?a=1&a=2)
export const queryString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// page/limit query params with safe bounds
export const getPagination = (query: Record<string, unknown>, maxLimit = 100) => {
  const page = Math.max(parseInt(String(query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(query.limit), 10) || 20, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};
