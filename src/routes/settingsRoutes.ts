import express from "express";
import {
  getFooter,
  updateFooter,
  getShipping,
  updateShipping,
  getNotificationSettings,
  updateNotificationSettings,
} from "../controllers/settingsController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

router.get("/footer", requirePermission("settings.view"), getFooter);
router.put("/footer", requirePermission("settings.update"), updateFooter);
router.get("/shipping", requirePermission("settings.view"), getShipping);
router.put("/shipping", requirePermission("settings.update"), updateShipping);
router.get("/notifications", requirePermission("settings.view"), getNotificationSettings);
router.put("/notifications", requirePermission("settings.update"), updateNotificationSettings);

export default router;
