import express from "express";
import {
  getBrands,
  getBrand,
  createBrand,
  updateBrand,
  updateBrandStatus,
  deleteBrand,
} from "../controllers/brandController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

router.get("/", requirePermission("brands.view"), getBrands);
router.post("/", requirePermission("brands.create"), createBrand);
router.get("/:id", requirePermission("brands.view"), getBrand);
router.put("/:id", requirePermission("brands.update"), updateBrand);
router.patch("/:id/status", requirePermission("brands.update"), updateBrandStatus);
router.delete("/:id", requirePermission("brands.delete"), deleteBrand);

export default router;
