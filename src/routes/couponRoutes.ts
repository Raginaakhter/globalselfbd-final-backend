import express from "express";
import {
  getCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  updateCouponStatus,
  deleteCoupon,
  applyCoupon,
} from "../controllers/couponController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

// Customer: check a code against the cart (before /:id so "apply" is not read as an ID)
router.post("/apply", requirePermission("cart.manage"), applyCoupon);

// Admin panel
router.get("/", requirePermission("coupons.view"), getCoupons);
router.post("/", requirePermission("coupons.create"), createCoupon);
router.get("/:id", requirePermission("coupons.view"), getCoupon);
router.put("/:id", requirePermission("coupons.update"), updateCoupon);
router.patch("/:id/status", requirePermission("coupons.update"), updateCouponStatus);
router.delete("/:id", requirePermission("coupons.delete"), deleteCoupon);

export default router;
