import express from "express";
import {
  createExpense,
  listExpenses,
  expensesSummary,
  getExpense,
  updateExpense,
  deleteExpense,
} from "../controllers/expenseController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

router.get("/", requirePermission("expenses.view"), listExpenses);
router.post("/", requirePermission("expenses.create"), createExpense);
router.get("/summary", requirePermission("expenses.view"), expensesSummary);
router.get("/:id", requirePermission("expenses.view"), getExpense);
router.put("/:id", requirePermission("expenses.update"), updateExpense);
router.delete("/:id", requirePermission("expenses.delete"), deleteExpense);

export default router;
