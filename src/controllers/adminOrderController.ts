import type { Request, Response } from "express";
import mongoose from "mongoose";
import Order, { type OrderDocument } from "../models/Order";
import OrderItem from "../models/OrderItem";
import Invoice from "../models/Invoice";
import CouponRedemption from "../models/CouponRedemption";
import Review from "../models/Review";
import Combo from "../models/Combo";
import { refreshRatingsOf } from "../utils/reviews";
import { releaseCoupon } from "../utils/coupons";
import User from "../models/User";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import { issueInvoiceQuietly } from "../utils/invoices";
import { assertObjectId, escapeRegex, isNonEmptyString, getPagination, queryString } from "../utils/validators";
import { findOrderOr404, getItemsByOrder, toOrderResponse, cancelOrder } from "../utils/orders";
import { finalizeSale, releaseReservation } from "../utils/inventory";
import { notifyDeliveredAndReview } from "../utils/orderEmails";
import {
  CANCELLABLE_STATUSES,
  ORDER_STATUS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  PRE_ORDER,
  isOrderStatus,
  isPaymentStatus,
  type OrderStatus,
  type PaymentStatus,
} from "../config/orderOptions";
import { getAuthUser } from "../middleware/auth";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

// Record when an order reached a step (used by the sales/payment reports)
const statusTimestamp = (status: OrderStatus): Record<string, Date> => {
  const field = (
    {
      CONFIRMED: "confirmedAt",
      READY_TO_SHIP: "readyToShipAt",
      SHIPPED: "shippedAt",
      OUT_FOR_DELIVERY: "outForDeliveryAt",
      DELIVERED: "deliveredAt",
    } as Partial<Record<OrderStatus, string>>
  )[status];
  return field ? { [field]: new Date() } : {};
};
// A refund gives back only the product price (after every discount): the delivery charge has gone to the shipping company
const paymentTimestamp = (
  status: PaymentStatus,
  order: { subtotal: number; discount: number; adminDiscountAmount?: number }
): Record<string, Date | number | null> => {
  if (status === "PAID") return { paidAt: new Date(), refundedAt: null, refundAmount: 0 };
  if (status === "REFUNDED") {
    const refundable = order.subtotal - order.discount - (order.adminDiscountAmount || 0);
    return { refundedAt: new Date(), refundAmount: Math.max(0, Math.round(refundable * 100) / 100) };
  }
  return {};
};

// Dates from the admin panel are Bangladesh time (UTC+6)
const TIMEZONE = "+06:00";
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Consume FIFO lots for every product line (and every combo member line) of an
// order, drop stock + reserved, record SALE movements, and stamp stockRestoredAt
// so a repeated SHIPPED-set (or a later deletion) never consumes stock twice.
// Pre-order lines are skipped because they never reserved stock at creation.
const finalizeOrderSale = async (order: OrderDocument): Promise<void> => {
  const items = await OrderItem.find({ orderId: order._id }).lean();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Re-check inside the transaction so two parallel admins can't double-finalize.
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, stockRestoredAt: null },
        { $set: { stockRestoredAt: new Date() } },
        { session, returnDocument: "after" }
      );
      if (!claimed) return;

      // Aggregate per-product need and matching revenue (so FIFO COGS has something
      // to compare against). Combo lines expand into their member products.
      const needs = new Map<string, { quantity: number; revenue: number }>();
      for (const item of items) {
        if (item.productId) {
          if (item.isPreOrder) continue;
          const key = String(item.productId);
          const existing = needs.get(key) || { quantity: 0, revenue: 0 };
          existing.quantity += item.quantity;
          existing.revenue += item.subtotal;
          needs.set(key, existing);
        } else if (item.comboId) {
          // Allocate combo revenue to its member products by cost weight (each
          // member gets its share of the combo line's total price proportional
          // to member unit price × quantity).
          const totalWeight = item.comboItemsSnapshot.reduce(
            (sum, m) => sum + m.unitPrice * m.quantity * item.quantity,
            0
          );
          for (const member of item.comboItemsSnapshot) {
            const key = String(member.productId);
            const existing = needs.get(key) || { quantity: 0, revenue: 0 };
            const memberWeight = member.unitPrice * member.quantity * item.quantity;
            const share = totalWeight > 0 ? (memberWeight / totalWeight) * item.subtotal : 0;
            existing.quantity += member.quantity * item.quantity;
            existing.revenue += Math.round(share * 100) / 100;
            needs.set(key, existing);
          }
        }
      }
      for (const [productId, need] of needs) {
        await finalizeSale(productId, need.quantity, need.revenue, session, {
          orderId: order._id,
          createdBy: null,
        });
      }
    });
  } finally {
    await session.endSession();
  }
};

const parseDate = (value: string, label: string, endOfDay: boolean): Date => {
  if (!DATE_REGEX.test(value)) throw new AppError(`${label} must be in YYYY-MM-DD format`, 400);
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}${TIMEZONE}`);
  if (Number.isNaN(date.getTime())) throw new AppError(`${label} is not a valid date`, 400);
  return date;
};

// @desc    All customer orders (search, filters, pagination)
// @route   GET /api/admin/orders
// @access  orders.viewAll
export const getAllOrders = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const status = queryString(req.query.status);
  const paymentStatus = queryString(req.query.paymentStatus);
  const customerId = queryString(req.query.customerId);
  const fromDate = queryString(req.query.fromDate);
  const toDate = queryString(req.query.toDate);
  // Order type: "preOrder" shows only pre-orders, "normal" shows only non-pre-order; absent = all.
  const type = queryString(req.query.type);
  const filter: Record<string, unknown> = {};

  if (type) {
    if (type === "preOrder") filter.isPreOrder = true;
    else if (type === "normal") filter.isPreOrder = { $ne: true };
    else throw new AppError('type must be "preOrder" or "normal"', 400);
  }

  if (status) {
    if (!isOrderStatus(status)) {
      throw new AppError(`Invalid status. Allowed: ${ORDER_STATUSES.join(", ")}`, 400);
    }
    filter.orderStatus = status;
  }
  if (paymentStatus) {
    if (!isPaymentStatus(paymentStatus)) {
      throw new AppError(`Invalid paymentStatus. Allowed: ${PAYMENT_STATUSES.join(", ")}`, 400);
    }
    filter.paymentStatus = paymentStatus;
  }
  if (customerId) {
    assertObjectId(customerId, "customer ID");
    filter.customerId = customerId;
  }
  if (fromDate || toDate) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (fromDate) range.$gte = parseDate(fromDate, "fromDate", false);
    if (toDate) range.$lte = parseDate(toDate, "toDate", true);
    if (range.$gte && range.$lte && range.$gte > range.$lte) {
      throw new AppError("fromDate must be before toDate", 400);
    }
    filter.createdAt = range;
  }
  if (isNonEmptyString(search)) {
    // Order number, customer name, phone (shipping and account), email (shipping and account)
    const pattern = new RegExp(escapeRegex(search.trim()), "i");
    const accountIds = await User.find({ $or: [{ phoneNumber: pattern }, { email: pattern }] }).distinct("_id");
    filter.$or = [
      { orderNumber: pattern },
      { shippingName: pattern },
      { shippingPhone: pattern },
      { shippingEmail: pattern },
      { customerId: { $in: accountIds } },
    ];
  }

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  const itemsByOrder = await getItemsByOrder(orders.map((o) => o._id));

  res.status(200).json({
    success: true,
    message: "Orders fetched successfully",
    data: {
      orders: orders.map((o) => {
        const items = itemsByOrder.get(String(o._id)) || [];
        return {
          _id: o._id,
          orderNumber: o.orderNumber,
          customerId: o.customerId,
          customerName: o.shippingName,
          customerPhone: o.shippingPhone,
          customerEmail: o.shippingEmail,
          itemCount: items.length,
          totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
          subtotal: o.subtotal,
          discount: o.discount,
          adminDiscountAmount: o.adminDiscountAmount ?? 0,
          fulfillmentMethod: o.fulfillmentMethod,
          shippingCost: o.shippingCost,
          totalAmount: o.totalAmount,
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          orderStatus: o.orderStatus,
          isPreOrder: o.isPreOrder ?? false,
          preOrderMinDays: o.preOrderMinDays ?? 0,
          expectedDeliveryDate: o.expectedDeliveryDate ?? null,
          createdAt: o.createdAt,
        };
      }),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
};

// @desc    Any order's full details (by ID or order number)
// @route   GET /api/admin/orders/:id
// @access  orders.viewAll
export const getOrderDetails = async (req: Request, res: Response) => {
  const order = await findOrderOr404(String(req.params.id));
  const [items, customer] = await Promise.all([
    OrderItem.find({ orderId: order._id }).lean(),
    User.findById(order.customerId).select("fullName phoneNumber email").lean(),
  ]);

  res.status(200).json({
    success: true,
    message: "Order fetched successfully",
    data: {
      ...toOrderResponse(order, items, customer),
      allowedNextStatuses: ORDER_TRANSITIONS[order.orderStatus],
      allowedNextPaymentStatuses: PAYMENT_TRANSITIONS[order.paymentStatus],
    },
  });
};

// @desc    Move an order to the next status (invalid transitions are rejected)
// @route   PATCH /api/admin/orders/:id/status
// @access  orders.status
export const updateOrderStatus = async (req: Request, res: Response) => {
  const { status } = (req.body || {}) as Body;
  if (!isOrderStatus(status)) {
    throw new AppError(`Invalid status. Allowed: ${ORDER_STATUSES.join(", ")}`, 400);
  }

  const order = await findOrderOr404(String(req.params.id));
  const from = order.orderStatus;
  if (from === status) throw new AppError(`Order is already ${status}`, 400);
  if (!ORDER_TRANSITIONS[from].includes(status)) {
    const allowed = ORDER_TRANSITIONS[from];
    throw new AppError(
      `Cannot change order status from ${from} to ${status}.${allowed.length ? ` Allowed: ${allowed.join(", ")}` : " This order is final."}`,
      400
    );
  }

  let updated: OrderDocument | null;
  if (status === ORDER_STATUS.CANCELLED) {
    const reasonRaw = (req.body as Body)?.cancellationReason;
    if (reasonRaw !== undefined && reasonRaw !== null && typeof reasonRaw !== "string") {
      throw new AppError("cancellationReason must be text", 400);
    }
    const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
    if (reason.length > PRE_ORDER.CANCELLATION_REASON_MAX) {
      throw new AppError(
        `cancellationReason cannot exceed ${PRE_ORDER.CANCELLATION_REASON_MAX} characters`,
        400
      );
    }
    updated = await cancelOrder(order, {
      reason: reason || null,
      cancelledBy: getAuthUser(req)._id,
    });
  } else {
    // Only update if nobody changed the status in the meantime
    updated = await Order.findOneAndUpdate(
      { _id: order._id, orderStatus: from },
      { $set: { orderStatus: status, ...statusTimestamp(status) } },
      { returnDocument: "after" }
    );
    if (!updated) throw new AppError("Order status was changed by someone else. Please reload", 409);

    // Simplified flow: finalize the sale at DELIVERED. Consume FIFO lots,
    // compute COGS, drop stock + reservation together. Idempotent via
    // stockRestoredAt so a re-attempted DELIVERED set never consumes twice.
    if (status === ORDER_STATUS.DELIVERED && !updated.stockRestoredAt) {
      await finalizeOrderSale(updated);
    }
  }

  // PENDING is never a valid target, so status here is always a real event
  if (status !== ORDER_STATUS.PENDING) {
    await logActivity(req, {
      action: `ORDER_${status}`,
      targetOrderId: order._id,
      targetUserId: order.customerId,
      oldValue: { orderStatus: from },
      newValue: { orderStatus: status },
    });
  }

  // A confirmed order gets its invoice automatically
  if (status === ORDER_STATUS.CONFIRMED) await issueInvoiceQuietly(updated);

  const items = await OrderItem.find({ orderId: order._id }).lean();
  // New flow: customers only ever receive TWO messages — the confirmation at
  // placement (handled by orderController.createOrder) and the single
  // delivered+review message here. Intermediate transitions do not notify.
  if (status === ORDER_STATUS.DELIVERED) {
    notifyDeliveredAndReview(updated, items);
  }
  res.status(200).json({
    success: true,
    message: `Order status updated to ${status}`,
    data: toOrderResponse(updated, items),
  });
};

// @desc    Change payment status (separate from order status)
// @route   PATCH /api/admin/orders/:id/payment-status
// @access  orders.paymentStatus
export const updatePaymentStatus = async (req: Request, res: Response) => {
  const { paymentStatus } = (req.body || {}) as Body;
  if (!isPaymentStatus(paymentStatus)) {
    throw new AppError(`Invalid paymentStatus. Allowed: ${PAYMENT_STATUSES.join(", ")}`, 400);
  }

  const order = await findOrderOr404(String(req.params.id));
  const from = order.paymentStatus;
  if (from === paymentStatus) throw new AppError(`Payment status is already ${paymentStatus}`, 400);
  if (!PAYMENT_TRANSITIONS[from].includes(paymentStatus)) {
    const allowed = PAYMENT_TRANSITIONS[from];
    throw new AppError(
      `Cannot change payment status from ${from} to ${paymentStatus}.${allowed.length ? ` Allowed: ${allowed.join(", ")}` : ""}`,
      400
    );
  }

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: from },
    { $set: { paymentStatus, ...paymentTimestamp(paymentStatus, order) } },
    { returnDocument: "after" }
  );
  if (!updated) throw new AppError("Payment status was changed by someone else. Please reload", 409);

  await logActivity(req, {
    action: "PAYMENT_STATUS_CHANGED",
    targetOrderId: order._id,
    targetUserId: order.customerId,
    oldValue: { paymentStatus: from },
    newValue: paymentStatus === "REFUNDED" ? { paymentStatus, refundAmount: updated.refundAmount } : { paymentStatus },
  });

  const items = await OrderItem.find({ orderId: order._id }).lean();
  res.status(200).json({
    success: true,
    message: `Payment status updated to ${paymentStatus}`,
    data: toOrderResponse(updated, items),
  });
};

// @desc    Permanently delete any order (by ID or order number)
//          PENDING/CONFIRMED/PROCESSING: cancelled first, so stock, combo stats and coupon usage are given back.
//          SHIPPED/DELIVERED: stock is NOT restored (the goods already left); combo stats are rolled back
//          and the order's reviews are removed (product ratings are recalculated).
// @route   DELETE /api/admin/orders/:id
// @access  orders.delete
export const deleteOrder = async (req: Request, res: Response) => {
  let order = await findOrderOr404(String(req.params.id));

  const statusBefore = order.orderStatus;
  if (CANCELLABLE_STATUSES.includes(order.orderStatus)) {
    order = await cancelOrder(order); // releases reservation + releases coupon
  }
  const statusNow = order.orderStatus;
  const wasFulfilled = statusNow === ORDER_STATUS.SHIPPED || statusNow === ORDER_STATUS.DELIVERED;

  const items = await OrderItem.find({ orderId: order._id }).lean();

  // Defensive cleanup: a fulfilled order whose inventory wasn't settled (e.g.
  // historical orders from before the SHIPPED-finalize path, or an admin
  // deleting straight after SHIPPED without finalize) still holds reservations.
  // Release them so Available doesn't stay inflated after the row is gone.
  if (wasFulfilled && !order.stockRestoredAt) {
    const toRelease = new Map<string, number>();
    for (const item of items) {
      if (item.productId) {
        if (item.isPreOrder) continue;
        const key = String(item.productId);
        toRelease.set(key, (toRelease.get(key) || 0) + item.quantity);
      } else if (item.comboId) {
        for (const member of item.comboItemsSnapshot) {
          const key = String(member.productId);
          toRelease.set(key, (toRelease.get(key) || 0) + member.quantity * item.quantity);
        }
      }
    }
    const cleanupSession = await mongoose.startSession();
    try {
      await cleanupSession.withTransaction(async () => {
        for (const [productId, quantity] of toRelease) {
          await releaseReservation(productId, quantity, cleanupSession, {
            orderId: order._id,
            createdBy: getAuthUser(req)._id,
          });
        }
      });
    } finally {
      await cleanupSession.endSession();
    }
  }
  const reviews = await Review.find({ orderId: order._id }).select("productId associatedProductIds").lean();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Status filter: never delete an order that moved on in the meantime
      const removed = await Order.deleteOne({ _id: order._id, orderStatus: statusNow }, { session });
      if (removed.deletedCount !== 1) throw new AppError("Order was changed by someone else. Please reload", 409);

      // Cancelled orders already had their combo stats rolled back by cancelOrder
      if (wasFulfilled) {
        const comboTotals = new Map<string, { quantity: number; revenue: number }>();
        for (const item of items) {
          if (!item.comboId) continue;
          const key = String(item.comboId);
          const existing = comboTotals.get(key) || { quantity: 0, revenue: 0 };
          existing.quantity += item.quantity;
          existing.revenue += item.subtotal;
          comboTotals.set(key, existing);
        }
        for (const [comboId, totals] of comboTotals) {
          await Combo.updateOne({ _id: comboId }, { $inc: { soldCount: -totals.quantity, revenue: -totals.revenue } }, { session });
        }
        await releaseCoupon(order._id, session); // give the coupon use back
      }

      await OrderItem.deleteMany({ orderId: order._id }, { session });
      await Invoice.deleteMany({ orderId: order._id }, { session });
      await CouponRedemption.deleteMany({ orderId: order._id }, { session });
      await Review.deleteMany({ orderId: order._id }, { session });
    });
  } finally {
    await session.endSession();
  }

  // Deleted reviews no longer count towards product ratings
  for (const review of reviews) await refreshRatingsOf(review);

  // Keep a snapshot in the activity log, because the order itself is gone
  await logActivity(req, {
    action: "ORDER_DELETED",
    targetOrderId: order._id,
    targetUserId: order.customerId,
    oldValue: {
      orderNumber: order.orderNumber,
      orderStatus: statusBefore,
      paymentStatus: order.paymentStatus,
      totalAmount: order.totalAmount,
      itemCount: items.length,
    },
  });

  res.status(200).json({
    success: true,
    message: "Order deleted successfully",
    data: { _id: order._id, orderNumber: order.orderNumber },
  });
};

// @desc    Edit the pre-order promise on an order: minimum days, expected delivery date, or both.
//          The 15-day floor applies when minDays is set; the date is also validated to be in the future.
//          Does NOT re-derive the date from current product settings — the order keeps its own snapshot.
// @route   PATCH /api/admin/orders/:id/pre-order
// @access  orders.update
export const updatePreOrderFields = async (req: Request, res: Response) => {
  const order = await findOrderOr404(String(req.params.id));
  const body = (req.body || {}) as Body;

  if (!order.isPreOrder) {
    throw new AppError("This order is not a pre-order", 400);
  }

  if (body.preOrderMinDays === undefined && body.expectedDeliveryDate === undefined) {
    throw new AppError("Send preOrderMinDays and/or expectedDeliveryDate", 400);
  }

  const before = {
    preOrderMinDays: order.preOrderMinDays,
    expectedDeliveryDate: order.expectedDeliveryDate,
  };

  if (body.preOrderMinDays !== undefined) {
    const n = typeof body.preOrderMinDays === "string" ? Number(body.preOrderMinDays) : body.preOrderMinDays;
    if (typeof n !== "number" || !Number.isInteger(n) || n < PRE_ORDER.MIN_DELIVERY_DAYS || n > PRE_ORDER.MAX_DELIVERY_DAYS) {
      throw new AppError(
        `preOrderMinDays must be a whole number between ${PRE_ORDER.MIN_DELIVERY_DAYS} and ${PRE_ORDER.MAX_DELIVERY_DAYS}`,
        400
      );
    }
    order.preOrderMinDays = n;
    // Re-base the expected delivery from the order's own placement date, keeping the snapshot principle.
    order.expectedDeliveryDate = new Date(order.createdAt.getTime() + n * 24 * 60 * 60 * 1000);
  }

  if (body.expectedDeliveryDate !== undefined) {
    const raw = body.expectedDeliveryDate;
    if (raw === null || raw === "") {
      throw new AppError("expectedDeliveryDate cannot be cleared", 400);
    }
    const date = typeof raw === "string" || typeof raw === "number" ? new Date(raw) : null;
    if (!date || Number.isNaN(date.getTime())) {
      throw new AppError("expectedDeliveryDate must be a valid date", 400);
    }
    if (date <= new Date()) {
      throw new AppError("expectedDeliveryDate must be in the future", 400);
    }
    order.expectedDeliveryDate = date;
  }

  await order.save();

  await logActivity(req, {
    action: "ORDER_PRE_ORDER_UPDATED",
    targetOrderId: order._id,
    oldValue: before,
    newValue: {
      preOrderMinDays: order.preOrderMinDays,
      expectedDeliveryDate: order.expectedDeliveryDate,
    },
  });

  const items = await OrderItem.find({ orderId: order._id }).lean();
  res.status(200).json({
    success: true,
    message: "Pre-order details updated",
    data: toOrderResponse(order, items),
  });
};

// @desc    Append an internal admin note to an order (visible only in admin dashboards).
//          Notes are append-only; previous notes are never overwritten so the audit trail stays intact.
// @route   POST /api/admin/orders/:id/notes
// @access  orders.update
export const addAdminNote = async (req: Request, res: Response) => {
  const { note } = (req.body || {}) as Body;
  if (typeof note !== "string" || !note.trim()) {
    throw new AppError("note is required", 400);
  }
  if (note.length > PRE_ORDER.ADMIN_NOTE_MAX) {
    throw new AppError(`note cannot exceed ${PRE_ORDER.ADMIN_NOTE_MAX} characters`, 400);
  }

  const order = await findOrderOr404(String(req.params.id));
  const addedBy = getAuthUser(req)._id;
  const entry = { note: note.trim(), addedBy, addedAt: new Date() };
  order.adminNotes.push(entry);
  await order.save();

  await logActivity(req, {
    action: "ORDER_ADMIN_NOTE_ADDED",
    targetOrderId: order._id,
    newValue: { noteCount: order.adminNotes.length },
  });

  const items = await OrderItem.find({ orderId: order._id }).lean();
  res.status(200).json({
    success: true,
    message: "Admin note added",
    data: toOrderResponse(order, items),
  });
};
