import express from "express";
const router = express.Router();
import { getActivityLogs } from "../controllers/activityLogController";
import { authenticate, requirePermission } from "../middleware/auth";

router.get("/", authenticate, requirePermission("activityLogs.view"), getActivityLogs);

export default router;
