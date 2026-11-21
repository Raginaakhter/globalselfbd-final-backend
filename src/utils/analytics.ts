import mongoose from "mongoose";
import type { Request } from "express";
import AppError from "./AppError";
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENT_CATEGORIES,
  type AnalyticsEventName,
  type AnalyticsEventCategory,
} from "../models/AnalyticsEvent";

// Shared helpers used by the analytics controllers. Kept out of the models
// and controllers so parsing/validation logic has one home. Every function
// in this file is intentionally defensive — the public ingestion endpoints
// are open to the internet and must not trust anything the client sends.

// Fields that must NEVER appear in a tracking event's metadata, even by
// accident. The ingestion endpoint drops any metadata that contains these
// keys (case-insensitive) rather than storing them.
const BLOCKED_METADATA_KEYS = new Set([
  "password", "pwd", "pass", "passwd",
  "otp", "code", "pin", "verificationcode",
  "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "jwt",
  "apikey", "apisecret", "secret", "secretkey", "privatekey",
  "cardnumber", "cardno", "cvv", "cvc", "ccv",
  "pan", "iban", "accountnumber", "accountno", "routing", "swift",
  "ssn", "nid", "passport", "licensenumber",
  "email", "phone", "phonenumber", "mobile", "address",
]);

// Values this big are almost certainly a mistake (a pasted log, a full HTML
// doc, etc.). We truncate loudly so the client sees it on dev test and
// quickly notice.
const MAX_METADATA_VALUE_LEN = 500;
const MAX_METADATA_ENTRIES = 25;

export const EVENT_NAME_TO_CATEGORY: Record<AnalyticsEventName, AnalyticsEventCategory> = {
  page_view: "navigation",
  button_click: "engagement",
  product_view: "ecommerce",
  product_click: "ecommerce",
  add_to_cart: "ecommerce",
  remove_from_cart: "ecommerce",
  wishlist_add: "ecommerce",
  wishlist_remove: "ecommerce",
  search: "search",
  category_click: "navigation",
  banner_click: "engagement",
  filter_click: "engagement",
  sort_click: "engagement",
  checkout_start: "checkout",
  payment_initiated: "checkout",
  payment_success: "checkout",
  payment_failed: "checkout",
  // purchase is NEVER accepted from the client — only the server-side
  // reconciler emits it. Kept in the category map for completeness.
  purchase: "ecommerce",
};

export const isAnalyticsEventName = (value: unknown): value is AnalyticsEventName =>
  typeof value === "string" && (ANALYTICS_EVENT_NAMES as readonly string[]).includes(value);

export const categoryFor = (name: AnalyticsEventName): AnalyticsEventCategory =>
  EVENT_NAME_TO_CATEGORY[name] || "other";

// ---------------------------------------------------------------------------
// Client-provided identifier normalization. Visitor/session ids are opaque
// strings chosen by the browser; we accept any url-safe character within a
// strict length cap. Anything else is rejected before touching the DB.
// ---------------------------------------------------------------------------

const ID_REGEX = /^[A-Za-z0-9._:-]{8,80}$/;

export const assertVisitorId = (value: unknown): string => {
  if (typeof value !== "string" || !ID_REGEX.test(value)) {
    throw new AppError("visitorId must be 8-80 chars of [A-Za-z0-9._:-]", 400);
  }
  return value;
};

export const assertSessionId = (value: unknown): string => {
  if (typeof value !== "string" || !ID_REGEX.test(value)) {
    throw new AppError("sessionId must be 8-80 chars of [A-Za-z0-9._:-]", 400);
  }
  return value;
};

export const optionalObjectId = (value: unknown): mongoose.Types.ObjectId | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !mongoose.isValidObjectId(value)) return null;
  return new mongoose.Types.ObjectId(value);
};

const str = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

// Derive a short path from a URL for indexing: /, /products, /cart. Querystring
// and fragment are stripped so `/products?p=2` and `/products?p=3` group as one.
export const extractPath = (urlOrPath: string): string => {
  if (!urlOrPath) return "";
  try {
    // If it's a full URL, parse it; if it's already a path, URL() with a
    // base makes it one.
    const u = new URL(urlOrPath, "https://placeholder.local");
    return u.pathname || "/";
  } catch {
    const noQuery = urlOrPath.split("?")[0];
    return noQuery.split("#")[0] || "/";
  }
};

// Sanitize the free-form metadata bag. Returns a safe {} on any issue;
// never throws.
export const sanitizeMetadata = (raw: unknown): Record<string, string | number | boolean> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_METADATA_ENTRIES) break;
    const key = String(rawKey).slice(0, 60);
    if (BLOCKED_METADATA_KEYS.has(key.toLowerCase())) continue;
    if (rawValue === undefined || rawValue === null) continue;
    if (typeof rawValue === "boolean") {
      out[key] = rawValue;
      count += 1;
    } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      out[key] = rawValue;
      count += 1;
    } else if (typeof rawValue === "string") {
      out[key] = rawValue.slice(0, MAX_METADATA_VALUE_LEN);
      count += 1;
    }
    // objects/arrays/functions silently dropped — metadata is flat by contract.
  }
  return out;
};

// ---------------------------------------------------------------------------
// UA + source inference. The frontend may send its own deviceType/browser,
// but we fall back to the User-Agent header if they're missing so server-side
// ingestion works even for curl/test clients.
// ---------------------------------------------------------------------------

export const inferDeviceType = (uaHeader: string): string => {
  const ua = uaHeader.toLowerCase();
  if (/mobile|iphone|android.*mobile|phone/.test(ua)) return "mobile";
  if (/ipad|tablet|android(?!.*mobile)/.test(ua)) return "tablet";
  if (/bot|crawler|spider|crawling/.test(ua)) return "bot";
  if (ua) return "desktop";
  return "";
};

export const inferBrowser = (uaHeader: string): string => {
  const ua = uaHeader.toLowerCase();
  if (/edg\//.test(ua)) return "Edge";
  if (/opr\/|opera/.test(ua)) return "Opera";
  if (/chrome\//.test(ua) && !/edg\//.test(ua)) return "Chrome";
  if (/firefox\//.test(ua)) return "Firefox";
  if (/safari\//.test(ua) && !/chrome\//.test(ua)) return "Safari";
  return "";
};

export const inferOs = (uaHeader: string): string => {
  const ua = uaHeader.toLowerCase();
  if (/windows nt/.test(ua)) return "Windows";
  if (/iphone|ipad|ipod/.test(ua)) return "iOS";
  if (/mac os x|macintosh/.test(ua)) return "macOS";
  if (/android/.test(ua)) return "Android";
  if (/linux/.test(ua)) return "Linux";
  return "";
};

// Rough traffic source classification from a referrer URL. If nothing is
// given the visit is Direct.
const SOURCE_PATTERNS: Array<{ source: string; hosts: RegExp }> = [
  { source: "google", hosts: /(^|\.)google\./ },
  { source: "facebook", hosts: /(^|\.)(facebook|fb)\./ },
  { source: "instagram", hosts: /(^|\.)instagram\./ },
  { source: "youtube", hosts: /(^|\.)youtube\./ },
  { source: "tiktok", hosts: /(^|\.)tiktok\./ },
  { source: "twitter", hosts: /(^|\.)(twitter|x)\./ },
  { source: "linkedin", hosts: /(^|\.)linkedin\./ },
  { source: "pinterest", hosts: /(^|\.)pinterest\./ },
  { source: "whatsapp", hosts: /(^|\.)(whatsapp|wa)\./ },
];

export const inferTrafficSource = (
  utmSource: string,
  referrer: string,
  siteHost: string
): string => {
  if (utmSource) {
    const normalized = utmSource.toLowerCase();
    if (normalized === "email" || normalized === "newsletter") return "email";
    if (normalized.includes("facebook") || normalized === "fb") return "facebook";
    if (normalized.includes("google")) return "google";
    if (normalized.includes("instagram")) return "instagram";
    if (normalized.includes("youtube")) return "youtube";
    if (normalized.includes("tiktok")) return "tiktok";
    return normalized.slice(0, 40);
  }
  if (!referrer) return "direct";
  try {
    const u = new URL(referrer);
    if (siteHost && u.host === siteHost) return "direct"; // internal nav
    for (const rule of SOURCE_PATTERNS) {
      if (rule.hosts.test(u.host)) return rule.source;
    }
    return "referral";
  } catch {
    return "direct";
  }
};

// ---------------------------------------------------------------------------
// Request → inferred context merging. The admin can trust these fields in
// aggregations because they always carry something meaningful (UA fallback)
// even when the client omits them.
// ---------------------------------------------------------------------------

export interface IngestedContext {
  deviceType: string;
  browser: string;
  operatingSystem: string;
  country: string;
  city: string;
  trafficSource: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  referrer: string;
  pageUrl: string;
  pagePath: string;
  pageTitle: string;
}

export const buildContextFromBody = (req: Request, body: Record<string, unknown>): IngestedContext => {
  const ua = String(req.headers["user-agent"] || "");
  const pageUrl = str(body.pageUrl, 2048);
  const referrer = str(body.referrer, 2048);
  const siteHost = (() => {
    try {
      return pageUrl ? new URL(pageUrl).host : "";
    } catch {
      return "";
    }
  })();
  const utmSource = str(body.utmSource, 100);
  const trafficSource = inferTrafficSource(utmSource, referrer, siteHost);

  return {
    deviceType: str(body.deviceType, 20) || inferDeviceType(ua),
    browser: str(body.browser, 60) || inferBrowser(ua),
    operatingSystem: str(body.operatingSystem, 60) || inferOs(ua),
    country: str(body.country, 60),
    city: str(body.city, 100),
    trafficSource: trafficSource || "direct",
    utmSource,
    utmMedium: str(body.utmMedium, 100),
    utmCampaign: str(body.utmCampaign, 150),
    utmTerm: str(body.utmTerm, 150),
    utmContent: str(body.utmContent, 150),
    referrer,
    pageUrl,
    pagePath: extractPath(pageUrl || str(body.pagePath, 512)),
    pageTitle: str(body.pageTitle, 300),
  };
};

// Date range helper used by overview + trends. Accepts a preset keyword
// ("today", "last7d", etc.) OR explicit from/to ISO strings.
export const PRESETS = {
  today: 1,
  yesterday: -1,
  last7d: 7,
  last30d: 30,
  last90d: 90,
  thisMonth: -2,
  lastMonth: -3,
} as const;
export type DatePreset = keyof typeof PRESETS;

export const isDatePreset = (value: unknown): value is DatePreset =>
  typeof value === "string" && value in PRESETS;

export const resolveDateRange = (query: Record<string, unknown>): { from: Date; to: Date } => {
  const now = new Date();
  const preset = typeof query.preset === "string" ? query.preset : "";
  if (isDatePreset(preset)) {
    const to = endOfDay(now);
    if (preset === "today") return { from: startOfDay(now), to };
    if (preset === "yesterday") {
      const y = addDays(now, -1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    if (preset === "thisMonth") {
      return { from: startOfMonth(now), to };
    }
    if (preset === "lastMonth") {
      const lastMonthEnd = new Date(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999);
      const lastMonthStart = new Date(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1);
      return { from: lastMonthStart, to: lastMonthEnd };
    }
    const days = PRESETS[preset];
    return { from: startOfDay(addDays(now, -(days - 1))), to };
  }
  const from = parseDate(query.from) || addDays(now, -29);
  const to = parseDate(query.to) || now;
  if (from > to) throw new AppError("'from' must be earlier than 'to'", 400);
  const maxSpanDays = Number(process.env.ANALYTICS_MAX_RANGE_DAYS) || 366;
  if ((to.getTime() - from.getTime()) / 86400000 > maxSpanDays) {
    throw new AppError(`Date range cannot exceed ${maxSpanDays} days`, 400);
  }
  return { from: startOfDay(from), to: endOfDay(to) };
};

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export const utcDayKey = (d: Date): Date => startOfDay(d);

// ---------------------------------------------------------------------------
// Short-window dedupe. The browser can fire the same click twice (double
// click, react StrictMode, retry queue) — we fingerprint and drop repeats
// within DEDUPE_WINDOW_MS.
// ---------------------------------------------------------------------------

export const DEDUPE_WINDOW_MS = 5_000;

export const buildDedupeKey = (
  eventName: string,
  visitorId: string,
  anchor: string
): string => `${eventName}:${visitorId}:${anchor}`;

export { ANALYTICS_EVENT_CATEGORIES, ANALYTICS_EVENT_NAMES };
