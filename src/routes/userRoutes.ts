import express from "express";
const router = express.Router();
import { getUsers, getUser, createUser, changeUserRole, updateUserStatus, deleteUser } from "../controllers/userController";
import { authenticate, requirePermission } from "../middleware/auth";

router.use(authenticate);

router.get("/", requirePermission("users.view"), getUsers);
router.post("/", requirePermission("users.create"), createUser);
router.get("/:id", requirePermission("users.view"), getUser);
router.patch("/:id/role", requirePermission("users.changeRole"), changeUserRole);
router.patch("/:id/status", requirePermission("users.update"), updateUserStatus);
router.delete("/:id", requirePermission("users.delete"), deleteUser);

export default router;
