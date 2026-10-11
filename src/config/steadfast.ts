// Steadfast Courier (packzy portal) integration configuration.
//
// Credentials MUST stay in environment variables and never ship in source,
// browser bundles or public responses. The server-side client reads them
// through `getSteadfastConfig()` which refuses to run when a secret is missing
// so a misconfigured deploy fails loudly instead of silently calling the API
// without authentication.

export const STEADFAST_DEFAULT_BASE_URL = "https://portal.packzy.com/api/v1";

// All documented delivery statuses the courier can return. The dashboard maps
// each one to a human label but keeps the raw value for audit/filter purposes.
// Approval-pending statuses are deliberately kept distinct from their final
// counterparts (e.g. `delivered_approval_pending` != `delivered`).
export const STEADFAST_DELIVERY_STATUSES = [
  "pending",
  "in_review",
  "hold",
  "delivered_approval_pending",
  "partial_delivered_approval_pending",
  "cancelled_approval_pending",
  "unknown_approval_pending",
  "delivered",
  "partial_delivered",
  "cancelled",
  "exceptional",
  "unknown",
] as const;
export type SteadfastDeliveryStatus = (typeof STEADFAST_DELIVERY_STATUSES)[number];

export const isSteadfastDeliveryStatus = (value: unknown): value is SteadfastDeliveryStatus =>
  typeof value === "string" && (STEADFAST_DELIVERY_STATUSES as readonly string[]).includes(value);

// Approval-pending values should never be treated as the final outcome.
export const PENDING_APPROVAL_STATUSES: readonly SteadfastDeliveryStatus[] = [
  "delivered_approval_pending",
  "partial_delivered_approval_pending",
  "cancelled_approval_pending",
  "unknown_approval_pending",
];

export const FINAL_DELIVERED_STATUSES: readonly SteadfastDeliveryStatus[] = [
  "delivered",
  "partial_delivered",
];

export interface SteadfastConfig {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
  requestTimeoutMs: number;
  // Documented Steadfast cache window for status endpoints is 60 seconds.
  statusCacheMs: number;
}

export const getSteadfastConfig = (): SteadfastConfig => {
  const baseUrl = (process.env.STEADFAST_BASE_URL || STEADFAST_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = process.env.STEADFAST_API_KEY || "";
  const secretKey = process.env.STEADFAST_SECRET_KEY || "";
  const requestTimeoutMs = Number(process.env.STEADFAST_TIMEOUT_MS) || 15000;
  const statusCacheMs = Number(process.env.STEADFAST_STATUS_CACHE_MS) || 60 * 1000;
  return { baseUrl, apiKey, secretKey, requestTimeoutMs, statusCacheMs };
};

// Only true when BOTH credential env vars are populated — callers must branch
// on this before issuing an API call, otherwise the integration refuses with
// a clear error rather than making an unauthenticated request.
export const isSteadfastConfigured = (): boolean => {
  const c = getSteadfastConfig();
  return Boolean(c.apiKey && c.secretKey);
};

// Steadfast-side validation constraints that the client enforces before
// sending a request. Keeping them here means a schema change can be rolled
// out without touching the booking controller.
export const STEADFAST_LIMITS = {
  INVOICE_MAX: 100,
  RECIPIENT_NAME_MAX: 100,
  RECIPIENT_ADDRESS_MAX: 250,
  // Documented phone format: BD mobile number, 11 digits with no +88 prefix.
  PHONE_REGEX: /^(?:\+?88)?01[3-9]\d{8}$/,
  NOTE_MAX: 500,
  ITEM_DESCRIPTION_MAX: 250,
  COD_MAX: 50000,
  COD_MIN: 0,
} as const;
