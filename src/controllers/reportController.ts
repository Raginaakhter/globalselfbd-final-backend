import type { Request, Response } from "express";
import type { PipelineStage } from "mongoose";
import Order from "../models/Order";
import StockMovement from "../models/StockMovement";
import AppError from "../utils/AppError";
import { queryString } from "../utils/validators";
import { ORDER_STATUSES } from "../config/orderOptions";
import { sumExpensesInRange } from "./expenseController";

// Note: Express 5 forwards errors thrown in async handlers to the error handler
// All reports use Bangladesh time (UTC+6): "today" starts at 12:00 AM in Dhaka.

const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BD_TIMEZONE = "+06:00";

// 12:00 AM Bangladesh time, `daysAgo` days before today
const startOfBdDay = (daysAgo = 0): Date => {
  const bdNow = new Date(Date.now() + BD_OFFSET_MS);
  const bdMidnight = Date.UTC(bdNow.getUTCFullYear(), bdNow.getUTCMonth(), bdNow.getUTCDate());
  return new Date(bdMidnight - BD_OFFSET_MS - daysAgo * DAY_MS);
};

interface Period {
  key: string;
  label: string;
  from: Date;
  to: Date;
}

// Rolling windows that include today (e.g. last 7 days = today + 6 days before)
const buildPeriods = (): Period[] => {
  const now = new Date();
  const today = startOfBdDay(0);
  const since = (days: number) => startOfBdDay(days - 1);
  return [
    { key: "today", label: "Today", from: today, to: now },
    { key: "yesterday", label: "Yesterday", from: startOfBdDay(1), to: today },
    { key: "last7Days", label: "Last 7 days", from: since(7), to: now },
    { key: "last14Days", label: "Last 14 days", from: since(14), to: now },
    { key: "last30Days", label: "Last 1 month (30 days)", from: since(30), to: now },
    { key: "last6Months", label: "Last 6 months (180 days)", from: since(180), to: now },
    { key: "last1Year", label: "Last 1 year (365 days)", from: since(365), to: now },
  ];
};

interface Totals {
  amount: number;
  orders: number;
  subtotal: number;
  shippingCost: number;
  discount: number;
  keptSubtotal: number;
  keptDiscount: number;
  refundedOrders: number;
}
const EMPTY: Totals = { amount: 0, orders: 0, subtotal: 0, shippingCost: 0, discount: 0, keptSubtotal: 0, keptDiscount: 0, refundedOrders: 0 };
const round = (n: number) => Math.round(n * 100) / 100;

// A refund returns only the product price (after discount). The delivery charge is never refunded:
// it has already gone to the shipping company.
const isRefunded = { $eq: ["$paymentStatus", "REFUNDED"] };
const unlessRefunded = (value: unknown) => ({ $cond: [isRefunded, 0, value] });

// Sum orders per period in one query. `dateExpr` picks the date each order counts on.
// With `dropRefundedProducts`, refunded orders count their delivery charge only.
const totalsByPeriod = async (
  match: Record<string, unknown>,
  dateExpr: unknown,
  periods: Period[],
  { dropRefundedProducts = false } = {}
) => {
  const earliest = periods.reduce((min, p) => (p.from < min ? p.from : min), periods[0].from);
  const group = {
    _id: null,
    amount: { $sum: "$totalAmount" },
    subtotal: { $sum: "$subtotal" },
    shippingCost: { $sum: "$shippingCost" },
    discount: { $sum: "$discount" },
    keptSubtotal: { $sum: unlessRefunded("$subtotal") },
    keptDiscount: { $sum: unlessRefunded("$discount") },
    refundedOrders: { $sum: { $cond: [isRefunded, 1, 0] } },
    orders: { $sum: 1 },
  };
  const pipeline: PipelineStage[] = [
    { $match: match },
    { $addFields: { reportDate: dateExpr } },
    { $match: { reportDate: { $gte: earliest } } },
    {
      $facet: Object.fromEntries(
        periods.map((p) => [p.key, [{ $match: { reportDate: { $gte: p.from, $lt: p.to } } }, { $group: group }]])
      ),
    },
  ];
  const [result] = await Order.aggregate<Record<string, (Totals & { _id: null })[]>>(pipeline);

  return periods.map((p) => {
    const t = result[p.key][0] || EMPTY;
    const subtotal = dropRefundedProducts ? t.keptSubtotal : t.subtotal;
    const discount = dropRefundedProducts ? t.keptDiscount : t.discount;
    return {
      key: p.key,
      label: p.label,
      from: p.from,
      to: p.to,
      amount: round(dropRefundedProducts ? subtotal - discount + t.shippingCost : t.amount),
      orders: t.orders,
      refundedOrders: t.refundedOrders,
      productSales: round(subtotal),
      shippingCost: round(t.shippingCost),
      discount: round(discount),
    };
  });
};

// Old orders (before step dates were saved) fall back to their last update time
const deliveredDate = { $ifNull: ["$deliveredAt", "$updatedAt"] };
const paidDate = { $ifNull: ["$paidAt", "$updatedAt"] };
const refundedDate = { $ifNull: ["$refundedAt", "$updatedAt"] };

// @desc    Sales for the dashboard: delivered orders per period. A refunded order keeps only its delivery charge.
// @route   GET /api/reports/sales
// @access  sales.view
export const getSalesSummary = async (req: Request, res: Response) => {
  const periods = buildPeriods();
  const [sales, pipelineRows] = await Promise.all([
    totalsByPeriod({ orderStatus: "DELIVERED" }, deliveredDate, periods, { dropRefundedProducts: true }),
    // Orders still in progress right now (not time based)
    Order.aggregate<{ _id: string; orders: number; amount: number; productAmount: number; shippingCost: number }>([
      {
        $group: {
          _id: "$orderStatus",
          orders: { $sum: 1 },
          amount: { $sum: "$totalAmount" },
          productAmount: { $sum: { $subtract: ["$subtotal", "$discount"] } },
          shippingCost: { $sum: "$shippingCost" },
        },
      },
    ]),
  ]);

  const byStatus = Object.fromEntries(
    ORDER_STATUSES.map((s) => {
      const row = pipelineRows.find((r) => r._id === s);
      return [
        s,
        {
          orders: row ? row.orders : 0,
          amount: row ? round(row.amount) : 0,
          productAmount: row ? round(row.productAmount) : 0,
          shippingCost: row ? round(row.shippingCost) : 0,
        },
      ];
    })
  );

  res.status(200).json({
    success: true,
    message: "Sales summary fetched successfully",
    data: {
      currency: "BDT",
      timezone: "Asia/Dhaka (UTC+6)",
      basis:
        "Delivered orders. amount = product sales - discount + shipping. A refunded order returns only its product price, so it adds its shipping charge but no product sales.",
      periods: sales,
      ordersByStatus: byStatus,
    },
  });
};

// @desc    Payments received and refunded per period
// @route   GET /api/reports/payments
// @access  payments.view
export const getPaymentsSummary = async (req: Request, res: Response) => {
  const periods = buildPeriods();
  const [received, refunded, pending] = await Promise.all([
    // Money that came in, counted on the day it was paid (a later refund is shown separately)
    totalsByPeriod({ paymentStatus: { $in: ["PAID", "REFUNDED"] } }, paidDate, periods),
    totalsByPeriod({ paymentStatus: "REFUNDED" }, refundedDate, periods),
    // Money not collected yet (unpaid orders that are not cancelled)
    Order.aggregate<{ _id: string; orders: number; amount: number; productAmount: number; shippingCost: number }>([
      { $match: { paymentStatus: { $in: ["PENDING", "FAILED"] }, orderStatus: { $ne: "CANCELLED" } } },
      {
        $group: {
          _id: "$paymentMethod",
          orders: { $sum: 1 },
          amount: { $sum: "$totalAmount" },
          productAmount: { $sum: { $subtract: ["$subtotal", "$discount"] } },
          shippingCost: { $sum: "$shippingCost" },
        },
      },
    ]),
  ]);

  // Product money (after discount) belongs to the company; the delivery charge goes to the delivery company
  const split = (t: { productSales: number; discount: number; shippingCost: number }) => ({
    productAmount: round(t.productSales - t.discount),
    shippingCost: round(t.shippingCost),
  });
  const sum = (key: "amount" | "productAmount" | "shippingCost") => round(pending.reduce((total, r) => total + r[key], 0));

  res.status(200).json({
    success: true,
    message: "Payments summary fetched successfully",
    data: {
      currency: "BDT",
      timezone: "Asia/Dhaka (UTC+6)",
      periods: received.map((p, i) => {
        // Only the product price is given back; the delivery charge stays with the shipping company
        const refundedProducts = split(refunded[i]).productAmount;
        return {
          key: p.key,
          label: p.label,
          from: p.from,
          to: p.to,
          received: { amount: p.amount, orders: p.orders, ...split(p) },
          refunded: { amount: refundedProducts, orders: refunded[i].orders, productAmount: refundedProducts, shippingCost: 0 },
          net: round(p.amount - refundedProducts),
          netSplit: {
            productAmount: round(split(p).productAmount - refundedProducts),
            shippingCost: round(p.shippingCost),
          },
        };
      }),
      outstanding: {
        amount: sum("amount"),
        orders: pending.reduce((total, r) => total + r.orders, 0),
        productAmount: sum("productAmount"),
        shippingCost: sum("shippingCost"),
        byPaymentMethod: pending.map((r) => ({ paymentMethod: r._id, orders: r.orders, amount: round(r.amount) })),
      },
    },
  });
};

const RANGES: Record<string, { days: number; unit: "day" | "month" }> = {
  "7d": { days: 7, unit: "day" },
  "14d": { days: 14, unit: "day" },
  "30d": { days: 30, unit: "day" },
  "6m": { days: 180, unit: "month" },
  "1y": { days: 365, unit: "month" },
};

// Every day/month label in the range, so days without sales show as 0
const bucketLabels = (from: Date, unit: "day" | "month"): string[] => {
  const labels: string[] = [];
  const cursor = new Date(from.getTime() + BD_OFFSET_MS);
  const end = new Date(Date.now() + BD_OFFSET_MS);
  while (cursor <= end) {
    const label = cursor.toISOString().slice(0, unit === "day" ? 10 : 7);
    if (labels[labels.length - 1] !== label) labels.push(label);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return labels;
};

// @desc    Sales chart data: delivered sales per day (7d/14d/30d) or per month (6m/1y)
// @route   GET /api/reports/sales/chart?range=7d
// @access  sales.view
export const getSalesChart = async (req: Request, res: Response) => {
  const range = queryString(req.query.range) || "7d";
  const config = RANGES[range];
  if (!config) throw new AppError(`range must be one of: ${Object.keys(RANGES).join(", ")}`, 400);

  const from = startOfBdDay(config.days - 1);
  const rows = await Order.aggregate<{ _id: string; amount: number; productAmount: number; shippingCost: number; orders: number }>([
    { $match: { orderStatus: "DELIVERED" } },
    { $addFields: { reportDate: deliveredDate } },
    { $match: { reportDate: { $gte: from } } },
    {
      $group: {
        _id: {
          $dateToString: { date: "$reportDate", format: config.unit === "day" ? "%Y-%m-%d" : "%Y-%m", timezone: BD_TIMEZONE },
        },
        // Refunded orders keep only their delivery charge
        productAmount: { $sum: unlessRefunded({ $subtract: ["$subtotal", "$discount"] }) },
        shippingCost: { $sum: "$shippingCost" },
        orders: { $sum: 1 },
      },
    },
    { $addFields: { amount: { $add: ["$productAmount", "$shippingCost"] } } },
  ]);
  const byLabel = new Map(rows.map((r) => [r._id, r]));
  const points = bucketLabels(from, config.unit).map((label) => ({
    label,
    amount: round(byLabel.get(label)?.amount || 0),
    productAmount: round(byLabel.get(label)?.productAmount || 0),
    shippingCost: round(byLabel.get(label)?.shippingCost || 0),
    orders: byLabel.get(label)?.orders || 0,
  }));
  const sumOf = (key: "amount" | "productAmount" | "shippingCost") => round(points.reduce((total, p) => total + p[key], 0));

  res.status(200).json({
    success: true,
    message: "Sales chart fetched successfully",
    data: {
      range,
      groupBy: config.unit,
      currency: "BDT",
      total: {
        amount: sumOf("amount"),
        productAmount: sumOf("productAmount"),
        shippingCost: sumOf("shippingCost"),
        orders: points.reduce((total, p) => total + p.orders, 0),
      },
      points,
    },
  });
};

// --------------------------------------------------------------------------
// Profit & Loss report
//
// Business model:
//   revenue       = Σ(subtotal − discount − adminDiscountAmount)   over delivered, non-refunded orders in [from, to]
//   cogs          = Σ(|StockMovement.quantity| × unitCost)         over SALE movements linked to those orders
//   grossProfit   = revenue − cogs
//   expenses      = Σ(Expense.amount)                              in [from, to], grouped by expense type
//   netProfit     = grossProfit − expenses.total
//   margin        = netProfit / revenue  (percent, 0 when revenue is 0)
//
// Shipping is treated as pass-through: the customer pays shippingCost, the
// shipping company receives it. If the business absorbs shipping it should
// be entered as a DELIVERY_COST expense so it hits the P&L correctly.
// --------------------------------------------------------------------------

interface PnlTotals {
  revenue: number;
  cogs: number;
  grossProfit: number;
  expensesTotal: number;
  expensesByType: Record<string, number>;
  netProfit: number;
  margin: number;        // percent, 2 decimals
  orders: number;
  shippingCollected: number;
  discount: number;
  adminDiscount: number;
}

const emptyPnl = (): PnlTotals => ({
  revenue: 0,
  cogs: 0,
  grossProfit: 0,
  expensesTotal: 0,
  expensesByType: {},
  netProfit: 0,
  margin: 0,
  orders: 0,
  shippingCollected: 0,
  discount: 0,
  adminDiscount: 0,
});

const revenueForPeriod = async (from: Date, to: Date): Promise<Pick<PnlTotals, "revenue" | "orders" | "shippingCollected" | "discount" | "adminDiscount">> => {
  const rows = await Order.aggregate<{
    revenue: number; orders: number; shippingCollected: number; discount: number; adminDiscount: number;
  }>([
    { $match: { orderStatus: "DELIVERED", paymentStatus: { $ne: "REFUNDED" } } },
    { $addFields: { reportDate: deliveredDate } },
    { $match: { reportDate: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        revenue: { $sum: { $subtract: [{ $subtract: ["$subtotal", "$discount"] }, { $ifNull: ["$adminDiscountAmount", 0] }] } },
        shippingCollected: { $sum: "$shippingCost" },
        discount: { $sum: "$discount" },
        adminDiscount: { $sum: { $ifNull: ["$adminDiscountAmount", 0] } },
        orders: { $sum: 1 },
      },
    },
  ]);
  const r = rows[0];
  return {
    revenue: round(r?.revenue || 0),
    orders: r?.orders || 0,
    shippingCollected: round(r?.shippingCollected || 0),
    discount: round(r?.discount || 0),
    adminDiscount: round(r?.adminDiscount || 0),
  };
};

const cogsForPeriod = async (from: Date, to: Date): Promise<number> => {
  const rows = await StockMovement.aggregate<{ cogs: number }>([
    { $match: { type: "SALE", orderId: { $ne: null } } },
    { $lookup: { from: "orders", localField: "orderId", foreignField: "_id", as: "order" } },
    { $unwind: "$order" },
    { $match: { "order.orderStatus": "DELIVERED" } },
    { $addFields: { reportDate: { $ifNull: ["$order.deliveredAt", "$order.updatedAt"] } } },
    { $match: { reportDate: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        cogs: { $sum: { $multiply: [{ $abs: "$quantity" }, { $ifNull: ["$unitCost", 0] }] } },
      },
    },
  ]);
  return round(rows[0]?.cogs || 0);
};

const buildPnlForPeriod = async (from: Date, to: Date): Promise<PnlTotals> => {
  const [rev, cogs, exp] = await Promise.all([
    revenueForPeriod(from, to),
    cogsForPeriod(from, to),
    sumExpensesInRange(from, to),
  ]);
  const grossProfit = round(rev.revenue - cogs);
  const netProfit = round(grossProfit - exp.total);
  const margin = rev.revenue > 0 ? Math.round((netProfit / rev.revenue) * 10000) / 100 : 0;
  return {
    ...emptyPnl(),
    ...rev,
    cogs,
    grossProfit,
    expensesTotal: exp.total,
    expensesByType: exp.byType,
    netProfit,
    margin,
  };
};

// @desc    Profit & Loss summary across rolling windows (today, 7d, 30d, ...),
//          or for a single custom date range when `fromDate`/`toDate` are given.
// @route   GET /api/reports/pnl
// @access  reports.view
export const getProfitLossSummary = async (req: Request, res: Response) => {
  const fromDate = queryString(req.query.fromDate);
  const toDate = queryString(req.query.toDate);

  if (fromDate || toDate) {
    const from = fromDate ? new Date(fromDate) : new Date(0);
    const to = toDate ? new Date(toDate) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new AppError("fromDate / toDate must be valid ISO dates", 400);
    }
    const totals = await buildPnlForPeriod(from, to);
    return res.status(200).json({
      success: true,
      message: "Profit & Loss fetched successfully",
      data: {
        currency: "BDT",
        timezone: "Asia/Dhaka (UTC+6)",
        range: { from, to, label: "Custom" },
        totals,
      },
    });
  }

  const periods = buildPeriods();
  const totals = await Promise.all(periods.map((p) => buildPnlForPeriod(p.from, p.to)));

  return res.status(200).json({
    success: true,
    message: "Profit & Loss fetched successfully",
    data: {
      currency: "BDT",
      timezone: "Asia/Dhaka (UTC+6)",
      periods: periods.map((p, i) => ({
        key: p.key,
        label: p.label,
        from: p.from,
        to: p.to,
        totals: totals[i],
      })),
    },
  });
};
