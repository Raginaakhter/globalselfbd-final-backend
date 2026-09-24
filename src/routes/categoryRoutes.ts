import express from "express";
const router = express.Router();
import { createCategory, getCategories, getCategory, updateCategory, updateCategoryStatus, deleteCategory } from "../controllers/categoryController";
import { authenticate, requirePermission } from "../middleware/auth";

router.use(authenticate);

router.post("/", requirePermission("categories.create"), createCategory);
router.get("/", requirePermission("categories.view"), getCategories);
router.get("/:id", requirePermission("categories.view"), getCategory);
router.put("/:id", requirePermission("categories.update"), updateCategory);
router.patch("/:id/status", requirePermission("categories.update"), updateCategoryStatus);
router.delete("/:id", requirePermission("categories.delete"), deleteCategory);

export default router;
