import type { Request, Response } from "express";
import mongoose, { type PipelineStage } from "mongoose";
import Invoice, { type IInvoice } from "../models/Invoice";
import Order, { type IOrder } from "../models/Order";
import AppError from "../utils/AppError";
import { getAuthUser } from "../middleware/auth";
import { escapeRegex, getPagination, isNonEmptyString, queryString } from "../utils/validators";
import { findOrderOr404 } from "../utils/orders";
import { issueInvoice } from "../utils/invoices";
import { loadFooter } from "./settingsController";
import { ORDER_STATUSES, PAYMENT_STATUSES, isOrderStatus, isPaymentStatus } from "../config/orderOptions";

// Note: Express 5 forwards errors thrown in async handlers to the error handler
// Dates follow Bangladesh time (UTC+6), like the reports.

type Body = Record<string, unknown>;

const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const round = (n: number) => Math.round(n * 100) / 100;

// 12:00 AM Bangladesh time, `daysAgo` days before today
const startOfBdDay = (daysAgo = 0): Date => {
  const bd = new Date(Date.now() + BD_OFFSET_MS);
  return new Date(Date.UTC(bd.getUTCFullYear(), bd.getUTCMonth(), bd.getUTCDate()) - BD_OFFSET_MS - daysAgo * DAY_MS);
};
const startOfBdMonth = (monthsAgo = 0): Date => {
  const bd = new Date(Date.now() + BD_OFFSET_MS);
  return new Date(Date.UTC(bd.getUTCFullYear(), bd.getUTCMonth() - monthsAgo, 1) - BD_OFFSET_MS);
};
// "2026-09-28" as a Bangladesh calendar day
const bdDate = (value: string, label: string, endOfDay: boolean): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(`${label} must be a date like 2026-09-28`, 400);
  const start = new Date(`${value}T00:00:00.000Z`).getTime() - BD_OFFSET_MS;
  if (Number.isNaN(start)) throw new AppError(`${label} must be a valid date`, 400);
  return new Date(endOfDay ? start + DAY_MS : start);
};

const DATE_RANGES: Record<string, () => { from: Date; to?: Date }> = {
  today: () => ({ from: startOfBdDay(0) }),
  yesterday: () => ({ from: startOfBdDay(1), to: startOfBdDay(0) }),
  last7Days: () => ({ from: startOfBdDay(6) }),
  last30Days: () => ({ from: startOfBdDay(29) }),
  thisMonth: () => ({ from: startOfBdMonth(0) }),
  lastMonth: () => ({ from: startOfBdMonth(1), to: startOfBdMonth(0) }),
};

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { issuedAt: -1, _id: -1 },
  oldest: { issuedAt: 1, _id: 1 },
  amountHigh: { totalAmount: -1, issuedAt: -1 },
  amountLow: { totalAmount: 1, issuedAt: -1 },
};

// Live order state joined onto each invoice
const withOrderState: PipelineStage[] = [
  {
    $lookup: {
      from: "orders",
      localField: "orderId",
      foreignField: "_id",
      pipeline: [{ $project: { orderStatus: 1, paymentStatus: 1, refundAmount: 1 } }],
      as: "order",
    },
  },
  { $unwind: { path: "$order", preserveNullAndEmptyArrays: true } },
  {
    $addFields: {
      orderStatus: "$order.orderStatus",
      paymentStatus: "$order.paymentStatus",
      refundAmount: { $ifNull: ["$order.refundAmount", 0] },
    },
  },
];

// Sales of an invoice: nothing when the order was cancelled; a refund takes back the product price only
const saleExpr = {
  $cond: [{ $eq: ["$orderStatus", "CANCELLED"] }, 0, { $subtract: ["$totalAmount", "$refundAmount"] }],
};

const summaryFacet = (from?: Date) => [
  ...(from ? [{ $match: { issuedAt: { $gte: from } } }] : []),
  {
    $group: {
      _id: null,
      invoices: { $sum: 1 },
      sales: { $sum: saleExpr },
      shipping: { $sum: { $cond: [{ $eq: ["$orderStatus", "CANCELLED"] }, 0, "$shippingCost"] } },
    },
  },
];

const listItem = {
  _id: 1,
  invoiceNumber: 1,
  orderId: 1,
  orderNumber: 1,
  customerId: 1,
  customerName: 1,
  customerPhone: 1,
  itemCount: { $size: "$items" },
  subtotal: 1,
  discount: 1,
  couponCode: 1,
  shippingCost: 1,
  totalAmount: 1,
  refundAmount: 1,
  paymentMethod: 1,
  paymentStatus: 1,
  orderStatus: 1,
  issuedAt: 1,
};

type Totals = { invoices: number; sales: number; shipping: number };
const totalsOf = (rows: Totals[]) => {
  const t = rows[0] || { invoices: 0, sales: 0, shipping: 0 };
  return { invoices: t.invoices, sales: round(t.sales), productSales: round(t.sales - t.shipping), shippingCost: round(t.shipping) };
};

// @desc    Invoice list with totals (total/today invoices and sales)
// @route   GET /api/invoices
// @access  invoices.view
export const getInvoices = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const paymentStatus = queryString(req.query.paymentStatus);
  const orderStatus = queryString(req.query.orderStatus);
  const dateRange = queryString(req.query.dateRange);
  const fromDate = queryString(req.query.fromDate);
  const toDate = queryString(req.query.toDate);
  const sort = queryString(req.query.sort) || "newest";

  const match: Record<string, unknown> = {};
  if (dateRange) {
    const range = DATE_RANGES[dateRange];
    if (!range) throw new AppError(`dateRange must be one of: ${Object.keys(DATE_RANGES).join(", ")}`, 400);
    const { from, to } = range();
    match.issuedAt = { $gte: from, ...(to ? { $lt: to } : {}) };
  } else if (fromDate || toDate) {
    const range: { $gte?: Date; $lt?: Date } = {};
    if (fromDate) range.$gte = bdDate(fromDate, "fromDate", false);
    if (toDate) range.$lt = bdDate(toDate, "toDate", true);
    if (range.$gte && range.$lt && range.$gte >= range.$lt) throw new AppError("fromDate must be before toDate", 400);
    match.issuedAt = range;
  }
  if (isNonEmptyString(search)) {
    // Invoice number, order number, customer name or phone
    const re = new RegExp(escapeRegex(search.trim()), "i");
    match.$or = [{ invoiceNumber: re }, { orderNumber: re }, { customerName: re }, { customerPhone: re }, { customerEmail: re }];
  }
  const statusMatch: Record<string, unknown> = {};
  if (paymentStatus) {
    if (!isPaymentStatus(paymentStatus)) throw new AppError(`paymentStatus must be one of: ${PAYMENT_STATUSES.join(", ")}`, 400);
    statusMatch.paymentStatus = paymentStatus;
  }
  if (orderStatus) {
    if (!isOrderStatus(orderStatus)) throw new AppError(`orderStatus must be one of: ${ORDER_STATUSES.join(", ")}`, 400);
    statusMatch.orderStatus = orderStatus;
  }
  if (!SORTS[sort]) throw new AppError(`sort must be one of: ${Object.keys(SORTS).join(", ")}`, 400);

  const [list] = await Invoice.aggregate<{ data: unknown[]; total: { count: number }[] }>([
    { $match: match },
    ...withOrderState,
    { $match: statusMatch },
    {
      $facet: {
        data: [{ $sort: SORTS[sort] }, { $skip: skip }, { $limit: limit }, { $project: listItem }],
        total: [{ $count: "count" }],
      },
    },
  ]);
  const [summary] = await Invoice.aggregate<{ all: Totals[]; today: Totals[] }>([
    ...withOrderState,
    { $facet: { all: summaryFacet(), today: summaryFacet(startOfBdDay(0)) } },
  ]);

  const total = list.total[0]?.count || 0;
  const all = totalsOf(summary.all);
  const today = totalsOf(summary.today);
  res.status(200).json({
    success: true,
    message: "Invoices fetched successfully",
    data: list.data,
    summary: {
      totalInvoices: all.invoices,
      totalSales: all.sales,
      todayInvoices: today.invoices,
      todaySales: today.sales,
      // Sales split: product money is the company's, shipping goes to the shipping company
      totalProductSales: all.productSales,
      totalShipping: all.shippingCost,
      todayProductSales: today.productSales,
      todayShipping: today.shippingCost,
      basis: "Sales leave out cancelled orders. A refund takes back only the product price.",
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// Full invoice for viewing/printing, with the shop details and the order's live status
const invoiceResponse = async (invoice: IInvoice & { _id: mongoose.Types.ObjectId }) => {
  const [order, footer] = await Promise.all([
    Order.findById(invoice.orderId).select("orderStatus paymentStatus refundAmount paidAt deliveredAt").lean<Pick<IOrder, "orderStatus" | "paymentStatus" | "refundAmount" | "paidAt" | "deliveredAt">>(),
    loadFooter(),
  ]);
  const refundAmount = order?.refundAmount || 0;
  return {
    ...invoice,
    orderStatus: order?.orderStatus ?? null,
    paymentStatus: order?.paymentStatus ?? null,
    paidAt: order?.paidAt ?? null,
    deliveredAt: order?.deliveredAt ?? null,
    refundAmount,
    // What the customer finally paid after a refund (delivery charge is never refunded)
    netAmount: round(invoice.totalAmount - refundAmount),
    seller: {
      name: "GlobalShelfBD",
      logoUrl: footer.logoUrl,
      phone: footer.contact.phone,
      email: footer.contact.email,
      address: footer.contact.address,
    },
  };
};

const findInvoiceOr404 = async (idOrNumber: string, customerId?: mongoose.Types.ObjectId) => {
  const filter: Record<string, unknown> = mongoose.isValidObjectId(idOrNumber)
    ? { _id: idOrNumber }
    : { invoiceNumber: String(idOrNumber).toUpperCase() };
  if (customerId) filter.customerId = customerId;
  const invoice = await Invoice.findOne(filter).lean<IInvoice & { _id: mongoose.Types.ObjectId }>();
  if (!invoice) throw new AppError("Invoice not found", 404);
  return invoice;
};

// @desc    One invoice (by ID or invoice number)
// @route   GET /api/invoices/:id
// @access  invoices.view
export const getInvoice = async (req: Request, res: Response) => {
  const invoice = await findInvoiceOr404(String(req.params.id));
  res.status(200).json({ success: true, message: "Invoice fetched successfully", data: await invoiceResponse(invoice) });
};

// @desc    Create the invoice for an order (returns the existing one if it already has one)
// @route   POST /api/invoices   { orderId }  (order ID or order number)
// @access  invoices.create
export const createInvoice = async (req: Request, res: Response) => {
  const { orderId } = (req.body || {}) as Body;
  if (!isNonEmptyString(orderId)) throw new AppError("orderId is required (order ID or order number)", 400);
  const order = await findOrderOr404(orderId.trim());
  const { invoice, created } = await issueInvoice(order, getAuthUser(req)._id);
  res.status(created ? 201 : 200).json({
    success: true,
    message: created ? "Invoice created successfully" : "This order already has an invoice",
    data: await invoiceResponse(invoice.toObject()),
  });
};

// @desc    Create invoices for confirmed/shipped/delivered orders that do not have one yet (e.g. older orders)
// @route   POST /api/invoices/generate-missing
// @access  invoices.create
export const generateMissingInvoices = async (req: Request, res: Response) => {
  const invoiced = await Invoice.distinct("orderId");
  const orders = await Order.find({
    _id: { $nin: invoiced },
    orderStatus: { $in: ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"] },
  }).sort({ createdAt: 1 });

  const createdBy = getAuthUser(req)._id;
  const numbers: string[] = [];
  for (const order of orders) {
    const { invoice, created } = await issueInvoice(order, createdBy);
    if (created) numbers.push(invoice.invoiceNumber);
  }
  res.status(200).json({
    success: true,
    message: numbers.length ? `${numbers.length} invoice(s) created` : "Every confirmed order already has an invoice",
    data: { created: numbers.length, invoiceNumbers: numbers },
  });
};

// @desc    Invoice of my own order (customer). Created once the order is confirmed.
// @route   GET /api/orders/:id/invoice
// @access  orders.view (own orders only)
export const getMyOrderInvoice = async (req: Request, res: Response) => {
  const customer = getAuthUser(req);
  const order = await findOrderOr404(String(req.params.id), customer._id);
  if (order.orderStatus === "PENDING") throw new AppError("The invoice will be ready once your order is confirmed", 404);
  if (order.orderStatus === "CANCELLED") throw new AppError("A cancelled order has no invoice", 404);
  const { invoice } = await issueInvoice(order);
  res.status(200).json({ success: true, message: "Invoice fetched successfully", data: await invoiceResponse(invoice.toObject()) });
};
