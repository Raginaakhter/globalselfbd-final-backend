import express from "express";
const router = express.Router();
import {
  checkout,
  createOrder,
  getMyOrders,
  getMyOrder,
  cancelMyOrder,
  validateCheckoutStock,
  createGuestOrder,
  trackOrder,
} from "../controllers/orderController";
import { getMyOrderInvoice } from "../controllers/invoiceController";
import { authenticate, requirePermission } from "../middleware/auth";

// Public order endpoints: guests may place and track orders without an account.
// Mounted before the authenticate middleware so no token is required.
router.post("/guest", createGuestOrder);
router.get("/track", trackOrder);

// Everything below requires a logged-in customer (reviews, history, cancel).
router.use(authenticate);

router.post("/checkout", requirePermission("orders.create"), checkout);
router.post("/validate-stock", requirePermission("orders.create"), validateCheckoutStock);
router.post("/", requirePermission("orders.create"), createOrder);
router.get("/", requirePermission("orders.view"), getMyOrders);
router.get("/:id", requirePermission("orders.view"), getMyOrder);
router.get("/:id/invoice", requirePermission("orders.view"), getMyOrderInvoice);
router.patch("/:id/cancel", requirePermission("orders.create"), cancelMyOrder);

export default router;
