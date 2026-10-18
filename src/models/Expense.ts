import { Schema, model, type HydratedDocument, type Types } from "mongoose";

// Business expenses outside sales/COGS: ad spend, delivery costs the business
// absorbs, damage write-offs, salaries, rent, utilities, packaging, misc.
// These feed the P&L calculator alongside revenue (orders) and COGS (lots).
export const EXPENSE_TYPES = [
  "AD_COST",
  "DELIVERY_COST",
  "DAMAGE_COST",
  "SALARY",
  "RENT",
  "UTILITY",
  "PACKAGING",
  "COMMISSION",
  "OTHER",
] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export interface IExpense {
  type: ExpenseType;
  amount: number;
  description: string;
  // When the expense actually happened (admin can backdate). Defaults to now.
  // All P&L period filters use this date, NOT createdAt.
  expenseDate: Date;
  // Free-text label for which account/wallet it came from ("BKASH", "CASH",
  // "BANK", "DBBL"). Not an enum — admins want flexibility.
  paidVia: string;
  // Optional links: a delivery cost may belong to one order; a damage cost
  // may belong to one product. Used by per-order profit breakdowns.
  orderId: Types.ObjectId | null;
  productId: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ExpenseDocument = HydratedDocument<IExpense>;

const expenseSchema = new Schema<IExpense>(
  {
    type: {
      type: String,
      enum: { values: EXPENSE_TYPES, message: "Expense type must be one of: {VALUES}" },
      required: [true, "Expense type is required"],
      index: true,
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [0.01, "Amount must be greater than 0"],
    },
    description: {
      type: String,
      required: [true, "Description is required"],
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    expenseDate: {
      type: Date,
      required: true,
      default: () => new Date(),
      index: true,
    },
    paidVia: { type: String, default: "", trim: true, maxlength: 60 },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Common dashboard query: all expenses in a date range grouped by type.
expenseSchema.index({ expenseDate: -1, type: 1 });

const Expense = model<IExpense>("Expense", expenseSchema);
export default Expense;

export const isExpenseType = (value: unknown): value is ExpenseType =>
  typeof value === "string" && (EXPENSE_TYPES as readonly string[]).includes(value);
