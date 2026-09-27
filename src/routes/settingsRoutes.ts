import express from "express";
import { getFooter, updateFooter, getShipping, updateShipping } from "../controllers/settingsController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

router.get("/footer", requirePermission("settings.view"), getFooter);
router.put("/footer", requirePermission("settings.update"), updateFooter);
router.get("/shipping", requirePermission("settings.view"), getShipping);
router.put("/shipping", requirePermission("settings.update"), updateShipping);

export default router;
