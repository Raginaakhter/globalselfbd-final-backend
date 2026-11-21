import { Schema, model, type HydratedDocument } from "mongoose";

// Pre-aggregated daily metrics. Populated incrementally by the public
// ingestion controller ($inc on the day's row) so the dashboard can render
// long date ranges without scanning millions of raw events.
//
// `day` is the UTC calendar date (midnight-aligned) — the admin overview
// endpoint maps date ranges to day buckets and sums these rows instead of
// touching AnalyticsEvent. Source-of-truth for live/recent numbers is still
// the raw collection; daily summaries are optimizations, not primaries.

export interface IAnalyticsDailySummary {
  day: Date;                       // UTC midnight of the day
  visitors: number;                // unique visitorIds that fired any event
  sessions: number;                // sessions started this day
  pageViews: number;
  events: number;
  productViews: number;
  productClicks: number;
  addToCart: number;
  removeFromCart: number;
  wishlistAdds: number;
  searches: number;
  checkoutStarts: number;
  paymentsInitiated: number;
  paymentsSuccess: number;
  paymentsFailed: number;
  purchases: number;
  revenue: number;                 // sum attributed to server-verified purchases
  // Light breakdowns kept inline so the dashboard needs one read per day.
  byDevice: Record<string, number>;
  bySource: Record<string, number>;
  byCountry: Record<string, number>;
  lastUpdatedAt: Date;
}

export type AnalyticsDailySummaryDocument = HydratedDocument<IAnalyticsDailySummary>;

const analyticsDailySummarySchema = new Schema<IAnalyticsDailySummary>(
  {
    day: { type: Date, required: true, unique: true, index: true },
    visitors: { type: Number, default: 0, min: 0 },
    sessions: { type: Number, default: 0, min: 0 },
    pageViews: { type: Number, default: 0, min: 0 },
    events: { type: Number, default: 0, min: 0 },
    productViews: { type: Number, default: 0, min: 0 },
    productClicks: { type: Number, default: 0, min: 0 },
    addToCart: { type: Number, default: 0, min: 0 },
    removeFromCart: { type: Number, default: 0, min: 0 },
    wishlistAdds: { type: Number, default: 0, min: 0 },
    searches: { type: Number, default: 0, min: 0 },
    checkoutStarts: { type: Number, default: 0, min: 0 },
    paymentsInitiated: { type: Number, default: 0, min: 0 },
    paymentsSuccess: { type: Number, default: 0, min: 0 },
    paymentsFailed: { type: Number, default: 0, min: 0 },
    purchases: { type: Number, default: 0, min: 0 },
    revenue: { type: Number, default: 0, min: 0 },
    byDevice: { type: Schema.Types.Mixed, default: {} },
    bySource: { type: Schema.Types.Mixed, default: {} },
    byCountry: { type: Schema.Types.Mixed, default: {} },
    lastUpdatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

analyticsDailySummarySchema.index({ day: -1 });

// Long-term retention: 2 years of daily rollups by default.
const ttlDays = Math.max(90, Number(process.env.ANALYTICS_SUMMARY_TTL_DAYS) || 730);
analyticsDailySummarySchema.index({ day: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 });

const AnalyticsDailySummary = model<IAnalyticsDailySummary>(
  "AnalyticsDailySummary",
  analyticsDailySummarySchema
);
export default AnalyticsDailySummary;
