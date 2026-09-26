import express from "express";
const router = express.Router();
import { uploadImages, uploadAvatar } from "../controllers/uploadController";
import { authenticate, requireAnyPermission } from "../middleware/auth";
import { uploadImages as parseImages } from "../middleware/upload";

router.post(
  "/images",
  authenticate,
  requireAnyPermission(
    "products.create",
    "products.update",
    "categories.create",
    "categories.update",
    "banners.create",
    "banners.update",
    "brands.create",
    "brands.update",
    "settings.update"
  ),
  parseImages,
  uploadImages
);

// Any logged-in user can upload their own profile picture (one image)
router.post("/avatar", authenticate, parseImages, uploadAvatar);

export default router;
