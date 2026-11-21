import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// One row per unique anonymous visitor (keyed by client-supplied visitorId —
// a browser-local UUID the frontend generates and persists in localStorage).
//
// The row stores lifetime totals that would otherwise require aggregating
// over millions of events for every dashboard render, plus first-touch
// attribution so "where did this visitor originally come from" survives
// later sessions that have no referrer.

export interface IAnalyticsVisitor {
  visitorId: string;
  firstVisit: Date;
  lastVisit: Date;
  totalSessions: number;
  totalPageViews: number;
  totalEvents: number;
  // First-touch attribution — set on the FIRST ever session and never
  // overwritten, so a returning visitor's reports always credit their
  // original acquisition channel.
  firstTrafficSource: string;
  firstUtmSource: string;
  firstUtmMedium: string;
  firstUtmCampaign: string;
  firstReferrer: string;
  // Last-touch snapshot, refreshed on every session so the admin can see
  // the most recent device / location the visitor used.
  deviceType: string;
  browser: string;
  operatingSystem: string;
  country: string;
  city: string;
  // If the visitor logs in, we pin their account here. One visitor → one
  // user mapping (shared devices create new visitorIds in the browser).
  userId: Types.ObjectId | null;
}

export type AnalyticsVisitorDocument = HydratedDocument<IAnalyticsVisitor>;

const analyticsVisitorSchema = new Schema<IAnalyticsVisitor>(
  {
    visitorId: { type: String, required: true, unique: true, index: true, trim: true, maxlength: 80 },
    firstVisit: { type: Date, required: true },
    lastVisit: { type: Date, required: true, index: true },
    totalSessions: { type: Number, default: 0, min: 0 },
    totalPageViews: { type: Number, default: 0, min: 0 },
    totalEvents: { type: Number, default: 0, min: 0 },
    firstTrafficSource: { type: String, default: "direct", trim: true, maxlength: 40 },
    firstUtmSource: { type: String, default: "", trim: true, maxlength: 100 },
    firstUtmMedium: { type: String, default: "", trim: true, maxlength: 100 },
    firstUtmCampaign: { type: String, default: "", trim: true, maxlength: 150 },
    firstReferrer: { type: String, default: "", trim: true, maxlength: 2048 },
    deviceType: { type: String, default: "", trim: true, maxlength: 20 },
    browser: { type: String, default: "", trim: true, maxlength: 60 },
    operatingSystem: { type: String, default: "", trim: true, maxlength: 60 },
    country: { type: String, default: "", trim: true, maxlength: 60 },
    city: { type: String, default: "", trim: true, maxlength: 100 },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
  },
  { timestamps: true }
);

analyticsVisitorSchema.index({ lastVisit: -1 });
analyticsVisitorSchema.index({ firstTrafficSource: 1, firstVisit: -1 });

const AnalyticsVisitor = model<IAnalyticsVisitor>("AnalyticsVisitor", analyticsVisitorSchema);
export default AnalyticsVisitor;
