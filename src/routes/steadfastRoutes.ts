import express from "express";
import {
  bookShipment,
  listShipments,
  getShipment,
  syncShipmentStatus,
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

router.use(authenticate);

// Dashboard
router.get("/summary", requirePermission("courier.view"), getCourierSummary);

// Settings
router.get("/settings", requirePermission("courier.view"), getCourierSettingsEndpoint);
router.put("/settings", requirePermission("courier.settings"), updateCourierSettingsEndpoint);

// Shipments
router.get("/shipments", requirePermission("courier.view"), listShipments);
router.post("/shipments", requirePermission("courier.book"), bookShipment);
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
