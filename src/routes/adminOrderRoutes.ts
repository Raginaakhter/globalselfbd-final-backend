import express from "express";
const router = express.Router();
import {
  getAllOrders,
  getOrderDetails,
  getOrderProfit,
  updateOrderStatus,
  updatePaymentStatus,
  updatePreOrderFields,
  addAdminNote,
  deleteOrder,
} from "../controllers/adminOrderController";
import { authenticate, requirePermission } from "../middleware/auth";

// Admin panel: every customer's orders
router.use(authenticate);

router.get("/", requirePermission("orders.viewAll"), getAllOrders);
// Per-order profit — defined BEFORE /:id so it isn't swallowed by the dynamic route.
router.get("/:id/profit", requirePermission("reports.view"), getOrderProfit);
router.get("/:id", requirePermission("orders.viewAll"), getOrderDetails);
router.patch("/:id/status", requirePermission("orders.status"), updateOrderStatus);
router.patch("/:id/payment-status", requirePermission("orders.paymentStatus"), updatePaymentStatus);
// Pre-order management
router.patch("/:id/pre-order", requirePermission("orders.update"), updatePreOrderFields);
router.post("/:id/notes", requirePermission("orders.update"), addAdminNote);
router.delete("/:id", requirePermission("orders.delete"), deleteOrder);

export default router;
