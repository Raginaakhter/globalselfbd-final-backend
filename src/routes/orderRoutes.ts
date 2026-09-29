import express from "express";
const router = express.Router();
import { checkout, createOrder, getMyOrders, getMyOrder, cancelMyOrder } from "../controllers/orderController";
import { getMyOrderInvoice } from "../controllers/invoiceController";
import { authenticate, requirePermission } from "../middleware/auth";

// Customer order APIs: always limited to the logged-in user's own orders
router.use(authenticate);

router.post("/checkout", requirePermission("orders.create"), checkout);
router.post("/", requirePermission("orders.create"), createOrder);
router.get("/", requirePermission("orders.view"), getMyOrders);
router.get("/:id", requirePermission("orders.view"), getMyOrder);
router.get("/:id/invoice", requirePermission("orders.view"), getMyOrderInvoice);
router.patch("/:id/cancel", requirePermission("orders.create"), cancelMyOrder);

export default router;
