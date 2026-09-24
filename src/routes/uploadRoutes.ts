import express from "express";
const router = express.Router();
import { uploadImages } from "../controllers/uploadController";
import { authenticate, requireAnyPermission } from "../middleware/auth";
import { uploadImages as parseImages } from "../middleware/upload";

router.post(
  "/images",
  authenticate,
  requireAnyPermission("products.create", "products.update", "categories.create", "categories.update"),
  parseImages,
  uploadImages
);

export default router;
