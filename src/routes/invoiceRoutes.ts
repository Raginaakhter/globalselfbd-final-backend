import express from "express";
import { getInvoices, getInvoice, createInvoice, generateMissingInvoices } from "../controllers/invoiceController";
import { authenticate, requirePermission } from "../middleware/auth";

// Admin panel invoices. Customers use GET /api/orders/:id/invoice.
const router = express.Router();

router.use(authenticate);

router.get("/", requirePermission("invoices.view"), getInvoices);
router.post("/", requirePermission("invoices.create"), createInvoice);
router.post("/generate-missing", requirePermission("invoices.create"), generateMissingInvoices);
router.get("/:id", requirePermission("invoices.view"), getInvoice);

export default router;
