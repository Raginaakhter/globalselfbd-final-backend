import express from "express";
import {
  getCombos,
  getCombo,
  createCombo,
  updateCombo,
  updateComboStatus,
  reorderCombos,
  deleteCombo,
  addComboGalleryImage,
  removeComboGalleryImage,
  updateComboThumbnail,
  bulkActivateCombos,
  bulkDeactivateCombos,
  bulkDeleteCombos,
  getComboStats,
  getCombosStatsSummary,
  comboProductPicker,
} from "../controllers/comboController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

// Analytics
router.get(
  "/stats/summary",
  authenticate,
  requirePermission("combos.view"),
  getCombosStatsSummary
);

// Product picker helper (admin only)
router.get(
  "/products/picker",
  authenticate,
  requirePermission("combos.view"),
  comboProductPicker
);

// Bulk ops (must be before "/:id" so they aren't captured as an ID)
router.post(
  "/bulk-activate",
  authenticate,
  requirePermission("combos.update"),
  bulkActivateCombos
);
router.post(
  "/bulk-deactivate",
  authenticate,
  requirePermission("combos.update"),
  bulkDeactivateCombos
);
router.post(
  "/bulk-delete",
  authenticate,
  requirePermission("combos.delete"),
  bulkDeleteCombos
);
router.patch("/reorder", authenticate, requirePermission("combos.update"), reorderCombos);

// Core CRUD
router.get("/", authenticate, requirePermission("combos.view"), getCombos);
router.post("/", authenticate, requirePermission("combos.create"), createCombo);

router.get("/:id", authenticate, requirePermission("combos.view"), getCombo);
router.get("/:id/stats", authenticate, requirePermission("combos.view"), getComboStats);
router.patch("/:id", authenticate, requirePermission("combos.update"), updateCombo);
router.patch(
  "/:id/status",
  authenticate,
  requirePermission("combos.update"),
  updateComboStatus
);
router.delete("/:id", authenticate, requirePermission("combos.delete"), deleteCombo);

// Image management
router.post(
  "/:id/image",
  authenticate,
  requirePermission("combos.update"),
  updateComboThumbnail
);
router.post(
  "/:id/gallery",
  authenticate,
  requirePermission("combos.update"),
  addComboGalleryImage
);
router.delete(
  "/:id/gallery",
  authenticate,
  requirePermission("combos.update"),
  removeComboGalleryImage
);

export default router;
