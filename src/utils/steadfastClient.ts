import AppError from "./AppError";
import {
  getSteadfastConfig,
  isSteadfastConfigured,
  isSteadfastDeliveryStatus,
  STEADFAST_LIMITS,
  type SteadfastConfig,
  type SteadfastDeliveryStatus,
} from "../config/steadfast";

// Reusable Steadfast Courier API client. All outbound requests go through
// `request()` which handles authentication, timeout, structured logging
// (with secrets redacted) and typed error raising. Callers never see raw
// headers or env values.
//
// IMPORTANT INVARIANTS
//  - Credentials are read from env on EVERY call. A hot swap of
//    STEADFAST_API_KEY works without a restart.
//  - A missing credential pair = AppError 503, never a silent anonymous call.
//  - A network timeout surfaces as `SteadfastTimeoutError` so the booking
//    controller can mark the shipment UNCERTAIN instead of blindly retrying.
//  - Secrets never appear in logs or thrown error messages.

export class SteadfastTimeoutError extends AppError {
  constructor(message = "Steadfast request timed out") {
    super(message, 504);
  }
}

export class SteadfastApiError extends AppError {
  statusCodeFromCourier: number;
  payload: unknown;
  constructor(message: string, statusCodeFromCourier: number, payload: unknown) {
    super(message, 502);
    this.statusCodeFromCourier = statusCodeFromCourier;
    this.payload = payload;
  }
}

export interface SteadfastRequestOptions {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  // Human-readable action for the structured log line
  action: string;
}

interface RequestResult {
  status: number;
  ok: boolean;
  data: unknown;
}

const redact = (header: string): string =>
  header && header.length > 4 ? `${header.slice(0, 2)}***${header.slice(-2)}` : "***";

const request = async (
  opts: SteadfastRequestOptions,
  config: SteadfastConfig = getSteadfastConfig()
): Promise<RequestResult> => {
  if (!config.apiKey || !config.secretKey) {
    throw new AppError("Steadfast integration is not configured on this server", 503);
  }
  const url = `${config.baseUrl}${opts.path}`;
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: opts.method,
      headers: {
        "Api-Key": config.apiKey,
        "Secret-Key": config.secretKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    // Structured log with secrets redacted
    const elapsedMs = Date.now() - started;
    console.log(
      `[steadfast] ${opts.method} ${opts.path} action=${opts.action} status=${response.status} elapsedMs=${elapsedMs} apiKey=${redact(
        config.apiKey
      )}`
    );

    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const err = error as Error & { name?: string };
    if (err.name === "TimeoutError" || /timeout/i.test(err.message)) {
      console.error(
        `[steadfast] ${opts.method} ${opts.path} action=${opts.action} TIMEOUT elapsedMs=${elapsedMs}`
      );
      throw new SteadfastTimeoutError(`Steadfast ${opts.action} timed out after ${config.requestTimeoutMs}ms`);
    }
    console.error(
      `[steadfast] ${opts.method} ${opts.path} action=${opts.action} ERROR elapsedMs=${elapsedMs} message=${err.message}`
    );
    throw new AppError(`Steadfast network error during ${opts.action}: ${err.message}`, 502);
  }
};

// ---- create_order --------------------------------------------------------
//
// Validates the request payload against documented constraints BEFORE sending
// so an obvious client-side bug never hits the courier API.

export interface CreateOrderPayload {
  invoice: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  cod_amount: number;
  note?: string;
  item_description?: string;
  total_lot?: number;
  alternative_phone?: string;
  recipient_email?: string;
  delivery_type?: number;
}

export interface CreateOrderResponse {
  status: number;
  message?: string;
  consignment?: {
    consignment_id: number | string;
    invoice: string;
    tracking_code: string;
    recipient_name?: string;
    recipient_address?: string;
    recipient_phone?: string;
    cod_amount?: number;
    note?: string;
    status?: string;
    created_at?: string;
    updated_at?: string;
  };
}

const assertString = (value: string | undefined, label: string, max: number, required = true): void => {
  if (required && (!value || !value.trim())) throw new AppError(`${label} is required`, 400);
  if (value && value.length > max) throw new AppError(`${label} cannot exceed ${max} characters`, 400);
};

export const validateCreateOrderPayload = (payload: CreateOrderPayload): void => {
  assertString(payload.invoice, "invoice", STEADFAST_LIMITS.INVOICE_MAX);
  assertString(payload.recipient_name, "recipient_name", STEADFAST_LIMITS.RECIPIENT_NAME_MAX);
  assertString(payload.recipient_address, "recipient_address", STEADFAST_LIMITS.RECIPIENT_ADDRESS_MAX);
  if (!STEADFAST_LIMITS.PHONE_REGEX.test(payload.recipient_phone)) {
    throw new AppError("recipient_phone must be a valid Bangladeshi mobile number", 400);
  }
  if (payload.alternative_phone && !STEADFAST_LIMITS.PHONE_REGEX.test(payload.alternative_phone)) {
    throw new AppError("alternative_phone must be a valid Bangladeshi mobile number", 400);
  }
  if (!Number.isFinite(payload.cod_amount) || payload.cod_amount < STEADFAST_LIMITS.COD_MIN) {
    throw new AppError("cod_amount must be a non-negative number", 400);
  }
  if (payload.cod_amount > STEADFAST_LIMITS.COD_MAX) {
    throw new AppError(`cod_amount cannot exceed ${STEADFAST_LIMITS.COD_MAX}`, 400);
  }
  assertString(payload.note, "note", STEADFAST_LIMITS.NOTE_MAX, false);
  assertString(payload.item_description, "item_description", STEADFAST_LIMITS.ITEM_DESCRIPTION_MAX, false);
};

export const createOrder = async (payload: CreateOrderPayload): Promise<CreateOrderResponse> => {
  validateCreateOrderPayload(payload);
  const { status, ok, data } = await request({
    method: "POST",
    path: "/create_order",
    body: payload as unknown as Record<string, unknown>,
    action: "create_order",
  });
  if (!ok) {
    const message = typeof (data as { message?: unknown })?.message === "string"
      ? ((data as { message: string }).message)
      : `Steadfast rejected the booking (HTTP ${status})`;
    throw new SteadfastApiError(message, status, data);
  }
  return data as CreateOrderResponse;
};

// ---- Status lookups ------------------------------------------------------

export interface StatusLookupResponse {
  status: number;
  delivery_status: SteadfastDeliveryStatus | string;
  message?: string;
}

const normaliseStatus = (raw: unknown): SteadfastDeliveryStatus => {
  if (isSteadfastDeliveryStatus(raw)) return raw;
  return "unknown";
};

export const statusByConsignmentId = async (consignmentId: string): Promise<SteadfastDeliveryStatus> => {
  if (!consignmentId) throw new AppError("consignmentId is required", 400);
  const { status, ok, data } = await request({
    method: "GET",
    path: `/status_by_cid/${encodeURIComponent(consignmentId)}`,
    action: "status_by_cid",
  });
  if (!ok) throw new SteadfastApiError(`status_by_cid failed (HTTP ${status})`, status, data);
  return normaliseStatus((data as { delivery_status?: unknown }).delivery_status);
};

export const statusByInvoice = async (invoice: string): Promise<SteadfastDeliveryStatus> => {
  if (!invoice) throw new AppError("invoice is required", 400);
  const { status, ok, data } = await request({
    method: "GET",
    path: `/status_by_invoice/${encodeURIComponent(invoice)}`,
    action: "status_by_invoice",
  });
  if (!ok) throw new SteadfastApiError(`status_by_invoice failed (HTTP ${status})`, status, data);
  return normaliseStatus((data as { delivery_status?: unknown }).delivery_status);
};

export const statusByTrackingCode = async (trackingCode: string): Promise<SteadfastDeliveryStatus> => {
  if (!trackingCode) throw new AppError("trackingCode is required", 400);
  const { status, ok, data } = await request({
    method: "GET",
    path: `/status_by_trackingcode/${encodeURIComponent(trackingCode)}`,
    action: "status_by_trackingcode",
  });
  if (!ok) throw new SteadfastApiError(`status_by_trackingcode failed (HTTP ${status})`, status, data);
  return normaliseStatus((data as { delivery_status?: unknown }).delivery_status);
};

// ---- Account balance / payouts -------------------------------------------

export interface BalanceResponse {
  status: number;
  current_balance?: number;
}

export const getBalance = async (): Promise<number> => {
  const { status, ok, data } = await request({
    method: "GET",
    path: "/get_balance",
    action: "get_balance",
  });
  if (!ok) throw new SteadfastApiError(`get_balance failed (HTTP ${status})`, status, data);
  const balance = (data as BalanceResponse).current_balance;
  return Number.isFinite(balance) ? Number(balance) : 0;
};

// Guard — kept here so routes/controllers can test connectivity without
// instantiating a fake config.
export { isSteadfastConfigured };
