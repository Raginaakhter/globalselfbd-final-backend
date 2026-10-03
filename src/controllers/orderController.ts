import mongoose from "mongoose";
import type { Request, Response } from "express";
import Order, { type OrderDocument } from "../models/Order";
import OrderItem from "../models/OrderItem";
import CartItem from "../models/CartItem";
import Combo from "../models/Combo";
import { nextSequence } from "../models/Counter";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import { getPagination, queryString } from "../utils/validators";
import { parseShippingInfo, buildOrderDraft, type OrderDraft } from "../utils/checkout";
import { decrementStock } from "../utils/inventory";
import { findOrderOr404, getItemsByOrder, toOrderResponse, cancelOrder } from "../utils/orders";
import { notifyOrderEvent } from "../utils/orderEmails";
import { getAuthUser } from "../middleware/auth";
import { claimCoupon, normalizeCouponCode } from "../utils/coupons";
import {
  ORDER_STATUSES,
  ORDER_NUMBER_PREFIX,
  ORDER_NUMBER_START,
  isOrderStatus,
} from "../config/orderOptions";

// Note: Express 5 forwards errors thrown in async handlers to the error handler
// Customer endpoints: every query is limited to req.user's own orders.

const toSummary = (draft: OrderDraft) => ({
  items: draft.items.map((i) => ({
    productId: i.productId,
    comboId: i.comboId,
    productTitle: i.productTitleSnapshot,
    thumbnail: i.thumbnailSnapshot,
    quantity: i.quantity,
    selectedSize: i.selectedSize,
    selectedUnit: i.selectedUnit,
    unitPrice: i.unitPrice,
    subtotal: i.subtotal,
    comboItemsSnapshot: i.comboItemsSnapshot,
  })),
  subtotal: draft.subtotal,
  discount: draft.discount,
  coupon: draft.coupon
    ? {
        code: draft.coupon.code,
        discountType: draft.coupon.coupon.discountType,
        discountValue: draft.coupon.coupon.discountValue,
        eligibleSubtotal: draft.coupon.eligibleSubtotal,
        discount: draft.coupon.discount,
      }
    : null,
  shippingCost: draft.shippingCost,
  totalAmount: draft.totalAmount,
  paymentMethod: draft.shippingInfo.paymentMethod,
  shippingInformation: {
    name: draft.shippingInfo.customerName,
    phone: draft.shippingInfo.phoneNumber,
    email: draft.shippingInfo.email,
    address: draft.shippingInfo.shippingAddress,
    city: draft.shippingInfo.city,
    area: draft.shippingInfo.area,
    orderNotes: draft.shippingInfo.orderNotes,
  },
});

// @desc    Checkout: validate cart + shipping + payment and return the order summary (nothing is saved)
// @route   POST /api/orders/checkout
// @access  orders.create
export const checkout = async (req: Request, res: Response) => {
  const shippingInfo = parseShippingInfo(req.body);
  const draft = await buildOrderDraft(getAuthUser(req)._id, shippingInfo, normalizeCouponCode(req.body?.couponCode));

  res.status(200).json({
    success: true,
    message: "Checkout summary",
    data: toSummary(draft),
  });
};

// @desc    Place an order from my cart
// @route   POST /api/orders
// @access  orders.create
// All steps run in one transaction: order + items + stock + clear cart. Any failure rolls back everything.
export const createOrder = async (req: Request, res: Response) => {
  const customer = getAuthUser(req);
  const shippingInfo = parseShippingInfo(req.body);
  const draft = await buildOrderDraft(customer._id, shippingInfo, normalizeCouponCode(req.body?.couponCode));
  const { cartItemIds } = draft;

  const session = await mongoose.startSession();
  let order: OrderDocument | undefined;
  try {
    await session.withTransaction(async () => {
      // Claim the cart items first: a double-submitted checkout finds them gone and stops
      const removed = await CartItem.deleteMany({ _id: { $in: cartItemIds } }, { session });
      if (removed.deletedCount !== cartItemIds.length) {
        throw new AppError("Your cart changed while placing the order. Please review your cart", 409);
      }

      const seq = await nextSequence("order", ORDER_NUMBER_START, session);
      [order] = await Order.create(
        [
          {
            orderNumber: `${ORDER_NUMBER_PREFIX}${seq}`,
            customerId: customer._id,
            subtotal: draft.subtotal,
            discount: draft.discount,
            couponId: draft.coupon?.coupon._id ?? null,
            couponCode: draft.coupon?.code ?? null,
            shippingCost: draft.shippingCost,
            totalAmount: draft.totalAmount,
            paymentMethod: shippingInfo.paymentMethod,
            shippingName: shippingInfo.customerName,
            shippingPhone: shippingInfo.phoneNumber,
            shippingEmail: shippingInfo.email,
            shippingAddress: shippingInfo.shippingAddress,
            shippingCity: shippingInfo.city,
            shippingArea: shippingInfo.area,
            orderNotes: shippingInfo.orderNotes,
          },
        ],
        { session }
      );
      const orderId = order._id;
      if (draft.coupon) await claimCoupon(draft.coupon, customer._id, orderId, session);

      await OrderItem.insertMany(
        draft.items.map((item) => ({ ...item, orderId })),
        { session }
      );

      // Aggregate per-product requested stock from both product lines AND combo member lines
      const stockNeeded = new Map<string, number>();
      for (const item of draft.items) {
        if (item.productId) {
          const key = String(item.productId);
          stockNeeded.set(key, (stockNeeded.get(key) || 0) + item.quantity);
        } else if (item.comboId) {
          for (const member of item.comboItemsSnapshot) {
            const key = String(member.productId);
            stockNeeded.set(key, (stockNeeded.get(key) || 0) + member.quantity * item.quantity);
          }
        }
      }
      for (const [productId, quantity] of stockNeeded) {
        await decrementStock(productId, quantity, session);
      }

      // Update combo analytics (sold count, revenue)
      for (const comboLine of draft.comboLines) {
        const comboItem = draft.items.find(
          (i) => i.comboId && String(i.comboId) === String(comboLine.comboId)
        );
        const revenueDelta = comboItem ? comboItem.subtotal : 0;
        await Combo.updateOne(
          { _id: comboLine.comboId },
          { $inc: { soldCount: comboLine.quantity, revenue: revenueDelta } },
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }
  if (!order) throw new AppError("Order could not be created", 500);
  const created: OrderDocument = order;

  const items = await OrderItem.find({ orderId: created._id }).lean();
  notifyOrderEvent("PLACED", created, items);
  await logActivity(req, {
    action: "ORDER_CREATED",
    targetOrderId: created._id,
    newValue: { orderNumber: created.orderNumber, totalAmount: created.totalAmount, itemCount: items.length },
  });

  res.status(201).json({
    success: true,
    message: "Order created successfully",
    data: toOrderResponse(created, items),
  });
};

// @desc    My order history
// @route   GET /api/orders
// @access  orders.view (own orders only)
export const getMyOrders = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter: Record<string, unknown> = { customerId: getAuthUser(req)._id };
  const status = queryString(req.query.status);
  if (status) {
    if (!isOrderStatus(status)) {
      throw new AppError(`Invalid status. Allowed: ${ORDER_STATUSES.join(", ")}`, 400);
    }
    filter.orderStatus = status;
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
          itemCount: items.length,
          totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
          firstItem: items[0] ? { productTitle: items[0].productTitleSnapshot, thumbnail: items[0].thumbnailSnapshot } : null,
          totalAmount: o.totalAmount,
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          orderStatus: o.orderStatus,
          createdAt: o.createdAt,
        };
      }),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
};

// @desc    One of my orders (by ID or order number)
// @route   GET /api/orders/:id
// @access  orders.view (own orders only)
export const getMyOrder = async (req: Request, res: Response) => {
  const order = await findOrderOr404(String(req.params.id), getAuthUser(req)._id);
  const items = await OrderItem.find({ orderId: order._id }).lean();

  res.status(200).json({
    success: true,
    message: "Order fetched successfully",
    data: toOrderResponse(order, items),
  });
};

// @desc    Cancel one of my orders (stock is restored once)
// @route   PATCH /api/orders/:id/cancel
// @access  orders.create (own orders only)
export const cancelMyOrder = async (req: Request, res: Response) => {
  const order = await findOrderOr404(String(req.params.id), getAuthUser(req)._id);
  const cancelled = await cancelOrder(order);

  await logActivity(req, {
    action: "ORDER_CANCELLED",
    targetOrderId: order._id,
    oldValue: { orderStatus: order.orderStatus },
    newValue: { orderStatus: cancelled.orderStatus, cancelledBy: "customer" },
  });

  const items = await OrderItem.find({ orderId: order._id }).lean();
  notifyOrderEvent("CANCELLED", cancelled, items);
  res.status(200).json({
    success: true,
    message: "Order cancelled successfully",
    data: toOrderResponse(cancelled, items),
  });
};
