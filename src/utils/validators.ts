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

// A link used on the site: a relative path ("/shop") or an absolute http(s) URL.
// Anything else (javascript:, data:, //evil.com) is rejected.
export const isValidLink = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return false;
  const v = value.trim();
  if (v.startsWith("/") && !v.startsWith("//")) return true;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

// Optional text field: undefined = not sent, "" / null = clear it, otherwise a trimmed string
export const optionalText = (value: unknown, label: string, max: number): string | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return "";
  if (typeof value !== "string") throw new AppError(`${label} must be text`, 400);
  if (value.trim().length > max) throw new AppError(`${label} cannot exceed ${max} characters`, 400);
  return value.trim();
};

// Optional link field: same rules as optionalText, and must be a valid link when present
export const optionalLink = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return "";
  if (!isValidLink(value)) throw new AppError(`${label} must be a path like "/shop" or a full http(s) URL`, 400);
  return value.trim();
};

// Whole number in a range (used for display order)
export const optionalInteger = (value: unknown, label: string, min: number, max: number): number | undefined => {
  if (value === undefined) return undefined;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new AppError(`${label} must be a whole number between ${min} and ${max}`, 400);
  }
  return n;
};

// Bangladeshi mobile number ("01712-345678", "+8801712345678") -> "01712345678", or null if invalid
const BD_PHONE = /^(?:\+?88)?01[3-9]\d{8}$/;
export const normalizeBdPhone = (value: string): string | null => {
  const raw = value.replace(/[\s-]/g, "");
  return BD_PHONE.test(raw) ? raw.slice(-11) : null;
};

// A query-string value as a plain string (ignores arrays/objects like ?a=1&a=2)
export const queryString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// page/limit query params with safe bounds
export const getPagination = (query: Record<string, unknown>, maxLimit = 100) => {
  const page = Math.max(parseInt(String(query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(query.limit), 10) || 20, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};
