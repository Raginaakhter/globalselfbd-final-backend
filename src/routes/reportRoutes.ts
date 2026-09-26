import express from "express";
import { getSalesSummary, getPaymentsSummary, getSalesChart } from "../controllers/reportController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

router.get("/sales", requirePermission("sales.view"), getSalesSummary);
router.get("/sales/chart", requirePermission("sales.view"), getSalesChart);
router.get("/payments", requirePermission("payments.view"), getPaymentsSummary);

export default router;
