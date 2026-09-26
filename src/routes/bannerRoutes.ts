import express from "express";
import {
  getBanners,
  getBanner,
  createBanner,
  updateBanner,
  updateBannerStatus,
  reorderBanners,
  deleteBanner,
} from "../controllers/bannerController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

router.get("/", requirePermission("banners.view"), getBanners);
router.post("/", requirePermission("banners.create"), createBanner);
// Must be before "/:id"
router.patch("/reorder", requirePermission("banners.update"), reorderBanners);
router.get("/:id", requirePermission("banners.view"), getBanner);
router.put("/:id", requirePermission("banners.update"), updateBanner);
router.patch("/:id/status", requirePermission("banners.update"), updateBannerStatus);
router.delete("/:id", requirePermission("banners.delete"), deleteBanner);

export default router;
