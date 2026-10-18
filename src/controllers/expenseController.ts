import type { Request, Response } from "express";
import mongoose from "mongoose";
import Expense, { EXPENSE_TYPES, isExpenseType, type IExpense } from "../models/Expense";
import Order from "../models/Order";
import Product from "../models/Product";
import AppError from "../utils/AppError";
import { assertObjectId, queryString, getPagination } from "../utils/validators";
import { logActivity } from "../utils/activityLog";
import { getAuthUser } from "../middleware/auth";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const round = (n: number): number => Math.round(n * 100) / 100;

const parseAmount = (value: unknown): number => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw new AppError("amount must be a positive number", 400);
  }
  return round(n);
};

const parseDate = (value: unknown, label: string): Date => {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(`${label} must be an ISO date string`, 400);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError(`${label} is not a valid date`, 400);
  return d;
};

const assertOrderExists = async (id: string) => {
  const exists = await Order.exists({ _id: id });
  if (!exists) throw new AppError("orderId does not reference an existing order", 400);
};

const assertProductExists = async (id: string) => {
  const exists = await Product.exists({ _id: id });
  if (!exists) throw new AppError("productId does not reference an existing product", 400);
};

const toResponse = (e: IExpense & { _id: unknown }) => ({
  _id: e._id,
  type: e.type,
  amount: e.amount,
  description: e.description,
  expenseDate: e.expenseDate,
  paidVia: e.paidVia || "",
  orderId: e.orderId,
  productId: e.productId,
  createdBy: e.createdBy,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

// @desc    Create an expense entry
// @route   POST /api/admin/expenses
// @access  expenses.create
export const createExpense = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  if (!isExpenseType(body.type)) {
    throw new AppError(`type must be one of: ${EXPENSE_TYPES.join(", ")}`, 400);
  }
  const amount = parseAmount(body.amount);
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) throw new AppError("description is required", 400);
  if (description.length > 500) throw new AppError("description cannot exceed 500 characters", 400);

  const expenseDate = body.expenseDate !== undefined ? parseDate(body.expenseDate, "expenseDate") : new Date();
  const paidVia = typeof body.paidVia === "string" ? body.paidVia.trim().slice(0, 60) : "";

  let orderId: mongoose.Types.ObjectId | null = null;
  if (body.orderId !== undefined && body.orderId !== null && body.orderId !== "") {
    assertObjectId(body.orderId, "orderId");
    await assertOrderExists(String(body.orderId));
    orderId = new mongoose.Types.ObjectId(String(body.orderId));
  }

  let productId: mongoose.Types.ObjectId | null = null;
  if (body.productId !== undefined && body.productId !== null && body.productId !== "") {
    assertObjectId(body.productId, "productId");
    await assertProductExists(String(body.productId));
    productId = new mongoose.Types.ObjectId(String(body.productId));
  }

  const created = await Expense.create({
    type: body.type,
    amount,
    description,
    expenseDate,
    paidVia,
    orderId,
    productId,
    createdBy: getAuthUser(req)._id,
  });

  await logActivity(req, {
    action: "EXPENSE_CREATED",
    newValue: { expenseId: created._id, type: created.type, amount: created.amount },
  });

  res.status(201).json({
    success: true,
    message: "Expense recorded",
    data: toResponse(created.toObject() as IExpense & { _id: unknown }),
  });
};

// @desc    List expenses with filters + pagination
// @route   GET /api/admin/expenses?type=AD_COST&fromDate=...&toDate=...&page=1&limit=20
// @access  expenses.view
export const listExpenses = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const type = queryString(req.query.type);
  const orderId = queryString(req.query.orderId);
  const productId = queryString(req.query.productId);
  const fromDate = queryString(req.query.fromDate);
  const toDate = queryString(req.query.toDate);

  const filter: Record<string, unknown> = {};
  if (type) {
    if (!isExpenseType(type)) throw new AppError(`type must be one of: ${EXPENSE_TYPES.join(", ")}`, 400);
    filter.type = type;
  }
  if (orderId) {
    assertObjectId(orderId, "orderId");
    filter.orderId = new mongoose.Types.ObjectId(orderId);
  }
  if (productId) {
    assertObjectId(productId, "productId");
    filter.productId = new mongoose.Types.ObjectId(productId);
  }
  if (fromDate || toDate) {
    const range: Record<string, Date> = {};
    if (fromDate) range.$gte = parseDate(fromDate, "fromDate");
    if (toDate) range.$lte = parseDate(toDate, "toDate");
    filter.expenseDate = range;
  }

  const [items, total] = await Promise.all([
    Expense.find(filter)
      .sort({ expenseDate: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("createdBy", "fullName email")
      .populate("orderId", "orderNumber totalAmount")
      .populate("productId", "productTitle sku")
      .lean(),
    Expense.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Expenses fetched",
    data: {
      items: items.map((e) => toResponse(e as IExpense & { _id: unknown })),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

// @desc    Expenses summary — totals by type for a date range (defaults to this month)
// @route   GET /api/admin/expenses/summary?fromDate=...&toDate=...
// @access  expenses.view
export const expensesSummary = async (req: Request, res: Response) => {
  const fromDate = queryString(req.query.fromDate);
  const toDate = queryString(req.query.toDate);

  const now = new Date();
  const from = fromDate ? parseDate(fromDate, "fromDate") : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = toDate ? parseDate(toDate, "toDate") : now;

  const rows = await Expense.aggregate<{ _id: string; amount: number; count: number }>([
    { $match: { expenseDate: { $gte: from, $lte: to } } },
    { $group: { _id: "$type", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    { $sort: { amount: -1 } },
  ]);

  const byType = EXPENSE_TYPES.map((t) => {
    const row = rows.find((r) => r._id === t);
    return { type: t, amount: round(row?.amount || 0), count: row?.count || 0 };
  });
  const total = round(rows.reduce((sum, r) => sum + r.amount, 0));
  const count = rows.reduce((sum, r) => sum + r.count, 0);

  res.status(200).json({
    success: true,
    message: "Expenses summary fetched",
    data: {
      currency: "BDT",
      from,
      to,
      total,
      count,
      byType,
    },
  });
};

// @desc    Get one expense
// @route   GET /api/admin/expenses/:id
// @access  expenses.view
export const getExpense = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "expense ID");
  const expense = await Expense.findById(req.params.id)
    .populate("createdBy", "fullName email")
    .populate("orderId", "orderNumber totalAmount")
    .populate("productId", "productTitle sku")
    .lean();
  if (!expense) throw new AppError("Expense not found", 404);
  res.status(200).json({
    success: true,
    message: "Expense fetched",
    data: toResponse(expense as IExpense & { _id: unknown }),
  });
};

// @desc    Update an expense (send only the fields to change)
// @route   PUT /api/admin/expenses/:id
// @access  expenses.update
export const updateExpense = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "expense ID");
  const expense = await Expense.findById(req.params.id);
  if (!expense) throw new AppError("Expense not found", 404);
  const body = (req.body || {}) as Body;

  if (body.type !== undefined) {
    if (!isExpenseType(body.type)) {
      throw new AppError(`type must be one of: ${EXPENSE_TYPES.join(", ")}`, 400);
    }
    expense.type = body.type;
  }
  if (body.amount !== undefined) expense.amount = parseAmount(body.amount);
  if (body.description !== undefined) {
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!description) throw new AppError("description cannot be empty", 400);
    if (description.length > 500) throw new AppError("description cannot exceed 500 characters", 400);
    expense.description = description;
  }
  if (body.expenseDate !== undefined) expense.expenseDate = parseDate(body.expenseDate, "expenseDate");
  if (body.paidVia !== undefined) {
    expense.paidVia = typeof body.paidVia === "string" ? body.paidVia.trim().slice(0, 60) : "";
  }
  if (body.orderId !== undefined) {
    if (body.orderId === null || body.orderId === "") {
      expense.orderId = null;
    } else {
      assertObjectId(body.orderId, "orderId");
      await assertOrderExists(String(body.orderId));
      expense.orderId = new mongoose.Types.ObjectId(String(body.orderId));
    }
  }
  if (body.productId !== undefined) {
    if (body.productId === null || body.productId === "") {
      expense.productId = null;
    } else {
      assertObjectId(body.productId, "productId");
      await assertProductExists(String(body.productId));
      expense.productId = new mongoose.Types.ObjectId(String(body.productId));
    }
  }

  await expense.save();

  await logActivity(req, {
    action: "EXPENSE_UPDATED",
    newValue: { expenseId: expense._id, type: expense.type, amount: expense.amount },
  });

  res.status(200).json({
    success: true,
    message: "Expense updated",
    data: toResponse(expense.toObject() as IExpense & { _id: unknown }),
  });
};

// @desc    Delete an expense
// @route   DELETE /api/admin/expenses/:id
// @access  expenses.delete
export const deleteExpense = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "expense ID");
  const deleted = await Expense.findByIdAndDelete(req.params.id);
  if (!deleted) throw new AppError("Expense not found", 404);
  await logActivity(req, {
    action: "EXPENSE_DELETED",
    oldValue: { expenseId: deleted._id, type: deleted.type, amount: deleted.amount },
  });
  res.status(200).json({ success: true, message: "Expense deleted", data: null });
};

// Exposed so the P&L report can call it directly without duplicating date logic.
export const sumExpensesInRange = async (from: Date, to: Date): Promise<{ total: number; byType: Record<string, number> }> => {
  const rows = await Expense.aggregate<{ _id: string; amount: number }>([
    { $match: { expenseDate: { $gte: from, $lte: to } } },
    { $group: { _id: "$type", amount: { $sum: "$amount" } } },
  ]);
  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byType[row._id] = round(row.amount);
    total += row.amount;
  }
  return { total: round(total), byType };
};
