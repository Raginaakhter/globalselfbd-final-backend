import express from "express";
import rateLimit from "express-rate-limit";
import {
  ingestEvents,
  ingestPageView,
  heartbeat,
  startSession,
  endSession,
} from "../controllers/analyticsIngestController";
import {
  getOverview,
  getPages,
  getClicks,
  getTopElements,
  getProductAnalytics,
  getProductDetail,
  getVisitors,
  getVisitorDetail,
  getActiveVisitors,
  getSessions,
  getSessionDetail,
  getTrends,
  getFunnel,
  getJourneys,
  getSources,
  getDevices,
  getLocations,
  getSearches,
  getCartAnalytics,
  getCheckoutAnalytics,
  getCustomerAnalytics,
  exportEvents,
} from "../controllers/analyticsAdminController";
import { authenticate, requirePermission } from "../middleware/auth";

const publicRouter = express.Router();
const adminRouter = express.Router();

// -----------------------------------------------------------------------
// Public ingestion — unauthenticated by design (storefront visitors have no
// account). A tight rate limit stops a single IP from flooding the raw
// event collection. The limit is intentionally generous for normal users
// (a page with 3 tracked events on load + a heartbeat every 30s fits
// comfortably under 300/5min) but blocks abusive scripts.
// -----------------------------------------------------------------------
const ingestLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.ANALYTICS_INGEST_RATE_LIMIT) || 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many analytics events, slow down" },
});

const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.ANALYTICS_HEARTBEAT_RATE_LIMIT) || 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many heartbeats" },
});

publicRouter.post("/events", ingestLimiter, ingestEvents);
publicRouter.post("/page-view", ingestLimiter, ingestPageView);
publicRouter.post("/heartbeat", heartbeatLimiter, heartbeat);
publicRouter.post("/session/start", ingestLimiter, startSession);
publicRouter.post("/session/end", ingestLimiter, endSession);

// -----------------------------------------------------------------------
// Admin — every endpoint requires analytics.view; export requires the
// higher analytics.export (CSV of raw rows is a stronger disclosure).
// -----------------------------------------------------------------------
adminRouter.use(authenticate);

adminRouter.get("/overview", requirePermission("analytics.view"), getOverview);
adminRouter.get("/pages", requirePermission("analytics.view"), getPages);
adminRouter.get("/clicks", requirePermission("analytics.view"), getClicks);
adminRouter.get("/clicks/top-elements", requirePermission("analytics.view"), getTopElements);
adminRouter.get("/products", requirePermission("analytics.view"), getProductAnalytics);
adminRouter.get("/products/:productId", requirePermission("analytics.view"), getProductDetail);
adminRouter.get("/visitors", requirePermission("analytics.view"), getVisitors);
adminRouter.get("/active-visitors", requirePermission("analytics.view"), getActiveVisitors);
adminRouter.get("/visitors/:visitorId", requirePermission("analytics.view"), getVisitorDetail);
adminRouter.get("/sessions", requirePermission("analytics.view"), getSessions);
adminRouter.get("/sessions/:sessionId", requirePermission("analytics.view"), getSessionDetail);
adminRouter.get("/trends", requirePermission("analytics.view"), getTrends);
adminRouter.get("/funnel", requirePermission("analytics.view"), getFunnel);
adminRouter.get("/journeys", requirePermission("analytics.view"), getJourneys);
adminRouter.get("/sources", requirePermission("analytics.view"), getSources);
adminRouter.get("/devices", requirePermission("analytics.view"), getDevices);
adminRouter.get("/locations", requirePermission("analytics.view"), getLocations);
adminRouter.get("/searches", requirePermission("analytics.view"), getSearches);
adminRouter.get("/cart", requirePermission("analytics.view"), getCartAnalytics);
adminRouter.get("/checkout", requirePermission("analytics.view"), getCheckoutAnalytics);
adminRouter.get("/customers", requirePermission("analytics.view"), getCustomerAnalytics);
adminRouter.get("/export", requirePermission("analytics.export"), exportEvents);

export { publicRouter as analyticsPublicRouter, adminRouter as analyticsAdminRouter };
