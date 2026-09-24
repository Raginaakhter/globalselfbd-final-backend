import express from "express";
const router = express.Router();
import { getPermissions } from "../controllers/permissionController";
import { authenticate, requirePermission } from "../middleware/auth";

router.get("/", authenticate, requirePermission("permissions.view"), getPermissions);

export default router;
