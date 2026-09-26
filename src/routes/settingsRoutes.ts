import express from "express";
import { getFooter, updateFooter } from "../controllers/settingsController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

router.get("/footer", requirePermission("settings.view"), getFooter);
router.put("/footer", requirePermission("settings.update"), updateFooter);

export default router;
