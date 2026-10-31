import express from "express";
import rateLimit from "express-rate-limit";
import {
  bookShipment,
  listShipments,
  getShipment,
  syncShipmentStatus,
  syncPendingShipments,
  requestCancellation,
  createReturnRequest,
  markReturnReceived,
  inspectReturn,
  recordSettlement,
  recordActualFee,
  getCourierSummary,
  getCourierSettingsEndpoint,
  updateCourierSettingsEndpoint,
} from "../controllers/steadfastController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

// Bulk sync fans out to the Steadfast API (up to 50 calls per invocation),
// so we cap how often an authenticated caller can trigger it. The IP-based
// limit is intentional: a shared office IP will still get many legitimate
// calls per hour, but it stops a buggy scheduler from hammering the courier.
const bulkSyncLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.COURIER_BULK_SYNC_RATE_LIMIT) || 6,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many bulk sync requests, please wait a few minutes" },
});

router.use(authenticate);

// Dashboard
router.get("/summary", requirePermission("courier.view"), getCourierSummary);

// Settings
router.get("/settings", requirePermission("courier.view"), getCourierSettingsEndpoint);
router.put("/settings", requirePermission("courier.settings"), updateCourierSettingsEndpoint);

// Shipments
router.get("/shipments", requirePermission("courier.view"), listShipments);
router.post("/shipments", requirePermission("courier.book"), bookShipment);
// Bulk sync must be registered BEFORE the dynamic ":id/sync" route so Express
// does not interpret "sync-pending" as an id.
router.post(
  "/shipments/sync-pending",
  bulkSyncLimiter,
  requirePermission("courier.sync"),
  syncPendingShipments
);
router.get("/shipments/:id", requirePermission("courier.view"), getShipment);
router.post("/shipments/:id/sync", requirePermission("courier.sync"), syncShipmentStatus);
router.post("/shipments/:id/cancel-request", requirePermission("courier.cancel"), requestCancellation);
router.post("/shipments/:id/return-request", requirePermission("courier.returnRequest"), createReturnRequest);
router.post("/shipments/:id/settlement", requirePermission("courier.settlement"), recordSettlement);
router.post("/shipments/:id/actual-fee", requirePermission("courier.actualFee"), recordActualFee);

// Return requests (physical receipt + inspection)
router.post("/return-requests/:id/receive", requirePermission("courier.returnReceive"), markReturnReceived);
router.post("/return-requests/:id/inspect", requirePermission("courier.returnReceive"), inspectReturn);

export default router;
