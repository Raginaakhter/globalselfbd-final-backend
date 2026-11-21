import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// One row per browser session. Started on the first event of a visit, kept
// "active" while heartbeats keep arriving, closed after an inactivity window
// (ANALYTICS_SESSION_IDLE_MINUTES, default 30) or an explicit session/end call.
//
// isActive is derived from lastActivity — admins can filter the active list
// without a per-row expiry check by using a $gte query on lastActivity. We
// still store the flag so sessions that ended explicitly are flagged even
// when the idle window hasn't elapsed yet.

export interface IAnalyticsSession {
  sessionId: string;
  visitorId: string;
  userId: Types.ObjectId | null;
  entryPage: string;
  entryPagePath: string;
  exitPage: string;
  currentPage: string;
  pageViews: number;
  totalEvents: number;
  sessionStart: Date;
  lastActivity: Date;
  sessionEnd: Date | null;
  // Seconds; computed when session ends (explicit or idle timeout).
  duration: number;
  deviceType: string;
  browser: string;
  operatingSystem: string;
  country: string;
  city: string;
  trafficSource: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  referrer: string;
  // Set to true on sessionStart and flipped by sessionEnd. For queries,
  // prefer lastActivity >= idleCutoff rather than trusting this flag alone.
  isActive: boolean;
  // A session is a bounce when it had one page view and no engagement events.
  isBounce: boolean;
}

export type AnalyticsSessionDocument = HydratedDocument<IAnalyticsSession>;

const analyticsSessionSchema = new Schema<IAnalyticsSession>(
  {
    sessionId: { type: String, required: true, unique: true, index: true, trim: true, maxlength: 80 },
    visitorId: { type: String, required: true, index: true, trim: true, maxlength: 80 },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    entryPage: { type: String, default: "", trim: true, maxlength: 2048 },
    entryPagePath: { type: String, default: "", trim: true, maxlength: 512 },
    exitPage: { type: String, default: "", trim: true, maxlength: 2048 },
    currentPage: { type: String, default: "", trim: true, maxlength: 2048 },
    pageViews: { type: Number, default: 0, min: 0 },
    totalEvents: { type: Number, default: 0, min: 0 },
    sessionStart: { type: Date, required: true, index: true },
    lastActivity: { type: Date, required: true, index: true },
    sessionEnd: { type: Date, default: null },
    duration: { type: Number, default: 0, min: 0 },
    deviceType: { type: String, default: "", trim: true, maxlength: 20 },
    browser: { type: String, default: "", trim: true, maxlength: 60 },
    operatingSystem: { type: String, default: "", trim: true, maxlength: 60 },
    country: { type: String, default: "", trim: true, maxlength: 60 },
    city: { type: String, default: "", trim: true, maxlength: 100 },
    trafficSource: { type: String, default: "direct", trim: true, maxlength: 40, index: true },
    utmSource: { type: String, default: "", trim: true, maxlength: 100 },
    utmMedium: { type: String, default: "", trim: true, maxlength: 100 },
    utmCampaign: { type: String, default: "", trim: true, maxlength: 150 },
    referrer: { type: String, default: "", trim: true, maxlength: 2048 },
    isActive: { type: Boolean, default: true, index: true },
    isBounce: { type: Boolean, default: true },
  },
  { timestamps: true }
);

analyticsSessionSchema.index({ sessionStart: -1 });
analyticsSessionSchema.index({ visitorId: 1, sessionStart: -1 });
analyticsSessionSchema.index({ isActive: 1, lastActivity: -1 });

// Sessions TTL — a full 180 days of session-level detail is plenty; the
// daily summary carries longer horizons.
const ttlDays = Math.max(14, Number(process.env.ANALYTICS_SESSION_TTL_DAYS) || 180);
analyticsSessionSchema.index({ sessionStart: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 });

const AnalyticsSession = model<IAnalyticsSession>("AnalyticsSession", analyticsSessionSchema);
export default AnalyticsSession;
