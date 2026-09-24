import express from "express";
const router = express.Router();
import { createRole, getRoles, getRole, updateRole, updateRoleStatus, deleteRole } from "../controllers/roleController";
import { authenticate, requirePermission } from "../middleware/auth";

router.use(authenticate);

router.post("/", requirePermission("roles.create"), createRole);
router.get("/", requirePermission("roles.view"), getRoles);
router.get("/:id", requirePermission("roles.view"), getRole);
router.put("/:id", requirePermission("roles.update"), updateRole);
router.patch("/:id/status", requirePermission("roles.status"), updateRoleStatus);
router.delete("/:id", requirePermission("roles.delete"), deleteRole);

export default router;
