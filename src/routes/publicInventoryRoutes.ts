import express from "express";
import rateLimit from "express-rate-limit";
import { createStockRequestPublic, validateProductStock } from "../controllers/inventoryController";
import { optionalAuthenticate } from "../middleware/auth";

const router = express.Router();

// Guard customer-facing writes so they can't spam the admin inbox even without
// the duplicate-prevention window from notifyStockRequest.
const stockRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/stock-request", optionalAuthenticate, stockRequestLimiter, createStockRequestPublic);
router.post("/validate", optionalAuthenticate, validateProductStock);

export default router;
