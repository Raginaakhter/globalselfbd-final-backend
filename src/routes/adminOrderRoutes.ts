import express from "express";
const router = express.Router();
import { getAllOrders, getOrderDetails, updateOrderStatus, updatePaymentStatus } from "../controllers/adminOrderController";
import { authenticate, requirePermission } from "../middleware/auth";

// Admin panel: every customer's orders
router.use(authenticate);

router.get("/", requirePermission("orders.viewAll"), getAllOrders);
router.get("/:id", requirePermission("orders.viewAll"), getOrderDetails);
router.patch("/:id/status", requirePermission("orders.status"), updateOrderStatus);
router.patch("/:id/payment-status", requirePermission("orders.paymentStatus"), updatePaymentStatus);

export default router;
