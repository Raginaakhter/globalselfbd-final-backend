import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// Append-only tracking of every user action on the storefront. Everything the
// admin dashboard reports on (clicks, page-views, funnel, sources) rolls up
// from this collection with aggregation pipelines — no duplicate copies of
// user or product data live here, only references.
//
// TTL: raw events live for ANALYTICS_EVENT_TTL_DAYS (default 90). Aggregated
// daily summaries (see AnalyticsDailySummary) keep long-horizon reporting
// cheap after the raw rows roll off.

export const ANALYTICS_EVENT_NAMES = [
  "page_view",
  "button_click",
  "product_view",
  "product_click",
  "add_to_cart",
  "remove_from_cart",
  "wishlist_add",
  "wishlist_remove",
  "search",
  "category_click",
  "banner_click",
  "filter_click",
  "sort_click",
  "checkout_start",
  "payment_initiated",
  "payment_success",
  "payment_failed",
  "purchase",
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export const ANALYTICS_EVENT_CATEGORIES = [
  "navigation",
  "engagement",
  "ecommerce",
  "search",
  "checkout",
  "other",
] as const;
export type AnalyticsEventCategory = (typeof ANALYTICS_EVENT_CATEGORIES)[number];

export interface IAnalyticsEvent {
  eventName: AnalyticsEventName;
  eventCategory: AnalyticsEventCategory;
  visitorId: string;
  sessionId: string;
  userId: Types.ObjectId | null;
  pageUrl: string;
  pagePath: string;
  pageTitle: string;
  referrer: string;
  elementId: string;
  elementName: string;
  buttonLabel: string;
  productId: Types.ObjectId | null;
  categoryId: Types.ObjectId | null;
  // Order ref is set ONLY by the server-side purchase reconciler, never by
  // client events — those are not trusted as proof of payment.
  orderId: Types.ObjectId | null;
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
  // Small, whitelisted bag for event-specific numeric/string fields
  // (search query, quantity, revenue, filter value). Validated upstream so
  // no PII / secret ever reaches here.
  metadata: Record<string, string | number | boolean>;
  // Internal dedupe key — same (visitor + event + anchor) within a short
  // window is collapsed to a single row. See analyticsEvents.ts.
  dedupeKey: string | null;
  createdAt: Date;
}

export type AnalyticsEventDocument = HydratedDocument<IAnalyticsEvent>;

const analyticsEventSchema = new Schema<IAnalyticsEvent>(
  {
    eventName: { type: String, enum: ANALYTICS_EVENT_NAMES, required: true, index: true },
    eventCategory: { type: String, enum: ANALYTICS_EVENT_CATEGORIES, required: true, index: true },
    visitorId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    pageUrl: { type: String, default: "", trim: true, maxlength: 2048 },
    pagePath: { type: String, default: "", trim: true, maxlength: 512, index: true },
    pageTitle: { type: String, default: "", trim: true, maxlength: 300 },
    referrer: { type: String, default: "", trim: true, maxlength: 2048 },
    elementId: { type: String, default: "", trim: true, maxlength: 200 },
    elementName: { type: String, default: "", trim: true, maxlength: 200 },
    buttonLabel: { type: String, default: "", trim: true, maxlength: 200 },
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null, index: true },
    deviceType: { type: String, default: "", trim: true, maxlength: 20 },
    browser: { type: String, default: "", trim: true, maxlength: 60 },
    operatingSystem: { type: String, default: "", trim: true, maxlength: 60 },
    country: { type: String, default: "", trim: true, maxlength: 60 },
    city: { type: String, default: "", trim: true, maxlength: 100 },
    trafficSource: { type: String, default: "direct", trim: true, maxlength: 40, index: true },
    utmSource: { type: String, default: "", trim: true, maxlength: 100 },
    utmMedium: { type: String, default: "", trim: true, maxlength: 100 },
    utmCampaign: { type: String, default: "", trim: true, maxlength: 150 },
    utmTerm: { type: String, default: "", trim: true, maxlength: 150 },
    utmContent: { type: String, default: "", trim: true, maxlength: 150 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, default: null, index: true, sparse: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound indexes that match the report-heavy aggregations: date-bucket
// then event / product / page / visitor.
analyticsEventSchema.index({ createdAt: -1, eventName: 1 });
analyticsEventSchema.index({ createdAt: -1, pagePath: 1 });
analyticsEventSchema.index({ createdAt: -1, productId: 1 });
analyticsEventSchema.index({ createdAt: -1, visitorId: 1 });
analyticsEventSchema.index({ sessionId: 1, createdAt: 1 });

// Raw events TTL — days * seconds. Tweak via env without a migration.
const ttlDays = Math.max(7, Number(process.env.ANALYTICS_EVENT_TTL_DAYS) || 90);
analyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 });

const AnalyticsEvent = model<IAnalyticsEvent>("AnalyticsEvent", analyticsEventSchema);
export default AnalyticsEvent;
