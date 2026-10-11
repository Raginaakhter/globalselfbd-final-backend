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
import {
  parseShippingInfo,
  parseAdminDiscountInput,
  buildOrderDraft,
  type OrderDraft,
  type AdminDiscountInput,
} from "../utils/checkout";
import { reserveStock } from "../utils/inventory";
import { findOrderOr404, getItemsByOrder, toOrderResponse, cancelOrder } from "../utils/orders";
// notifyOrderPlaced is deliberately NOT called at order-create time anymore;
// the admin fires it by moving the order from PENDING → CONFIRMED, so the
// import lives in adminOrderController. If a future flow needs auto-confirm
// on creation, re-import here and send after the transaction.
import { getAuthUser, loadPermissions } from "../middleware/auth";
import { claimCoupon, normalizeCouponCode } from "../utils/coupons";
import { buildGuestOrderDraft, findOrCreateGuestCustomer } from "../utils/guestCheckout";
import { normalizeBdPhone } from "../utils/validators";
import {
  ORDER_STATUS,
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
  adminDiscount: draft.adminDiscount
    ? {
        type: draft.adminDiscount.type,
        value: draft.adminDiscount.value,
        amount: draft.adminDiscount.amount,
        eligibleSubtotal: draft.adminDiscount.eligibleSubtotal,
      }
    : null,
  fulfillmentMethod: draft.shippingInfo.fulfillmentMethod,
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

// Decide whether the admin-discount fields in the request can be honored.
// Never trust a role-name claim from the client: this reads the server's own
// req.permissions set that authorize/requirePermission populated.
const resolveAdminDiscount = async (
  req: Request,
  requestedAdminDiscount: AdminDiscountInput | null
): Promise<AdminDiscountInput | null> => {
  if (!requestedAdminDiscount) return null;
  const permissions = await loadPermissions(req);
  if (!permissions.has("orders.adminDiscount")) {
    throw new AppError("You are not allowed to apply an admin discount", 403);
  }
  return requestedAdminDiscount;
};

// @desc    Lightweight stock-only re-check before the final order submit. Walks the
//          cart with current product stock, returns `ok` + per-line issues.
//          Does NOT touch the cart or create any order.
// @route   POST /api/orders/validate-stock
// @access  orders.create
export const validateCheckoutStock = async (req: Request, res: Response) => {
  const customer = getAuthUser(req);
  try {
    await buildOrderDraft(customer._id, {
      // Use dummy-but-valid shipping to satisfy the draft validator — the exact
      // values do not matter for stock validation, only cart contents.
      customerName: "stock-check",
      phoneNumber: "01700000000",
      email: null,
      shippingAddress: "stock-check",
      city: "Dhaka",
      area: "stock-check",
      orderNotes: "",
      paymentMethod: "CASH_ON_DELIVERY",
      fulfillmentMethod: "DELIVERY",
    });
    return res.status(200).json({
      success: true,
      message: "All cart items can be ordered",
      data: { ok: true },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stock check failed";
    return res.status(200).json({
      success: true,
      message,
      data: { ok: false, reason: message },
    });
  }
};

// @desc    Checkout: validate cart + shipping + payment and return the order summary (nothing is saved)
// @route   POST /api/orders/checkout
// @access  orders.create
export const checkout = async (req: Request, res: Response) => {
  const shippingInfo = parseShippingInfo(req.body);
  const adminDiscount = await resolveAdminDiscount(req, parseAdminDiscountInput(req.body));
  const draft = await buildOrderDraft(getAuthUser(req)._id, shippingInfo, {
    couponCode: normalizeCouponCode(req.body?.couponCode),
    adminDiscount,
  });

  res.status(200).json({
    success: true,
    message: "Checkout summary",
    data: {
      ...toSummary(draft),
      // So the frontend can decide whether to render the admin-discount controls at all
      canUseAdminDiscount: (await loadPermissions(req)).has("orders.adminDiscount"),
    },
  });
};

// @desc    Place an order from my cart
// @route   POST /api/orders
// @access  orders.create
// All steps run in one transaction: order + items + stock + clear cart. Any failure rolls back everything.
export const createOrder = async (req: Request, res: Response) => {
  const customer = getAuthUser(req);
  const shippingInfo = parseShippingInfo(req.body);
  const adminDiscount = await resolveAdminDiscount(req, parseAdminDiscountInput(req.body));
  const draft = await buildOrderDraft(customer._id, shippingInfo, {
    couponCode: normalizeCouponCode(req.body?.couponCode),
    adminDiscount,
  });
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
            // Orders are placed as PENDING. An admin must explicitly confirm
            // the order from the admin dashboard, which fires the "order
            // confirmed" email. The default on the schema handles PENDING,
            // but we spell it out here so a reader sees the intent at the
            // call-site.
            orderStatus: "PENDING" as const,
            subtotal: draft.subtotal,
            discount: draft.discount,
            couponId: draft.coupon?.coupon._id ?? null,
            couponCode: draft.coupon?.code ?? null,
            fulfillmentMethod: shippingInfo.fulfillmentMethod,
            shippingCost: draft.shippingCost,
            adminDiscountType: draft.adminDiscount?.type ?? null,
            adminDiscountValue: draft.adminDiscount?.value ?? 0,
            adminDiscountAmount: draft.adminDiscount?.amount ?? 0,
            isPreOrder: draft.isPreOrder,
            preOrderMinDays: draft.preOrderMinDays,
            expectedDeliveryDate: draft.expectedDeliveryDate,
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

      // Aggregate per-product requested stock from product lines AND combo member lines.
      // Pre-order product lines are intentionally skipped: those are fulfilled from incoming
      // supplier shipments after the delivery window and do not consume current stock.
      const stockNeeded = new Map<string, number>();
      for (const item of draft.items) {
        if (item.productId) {
          if (item.isPreOrder) continue;
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
        await reserveStock(productId, quantity, session, { orderId: order._id, createdBy: customer._id });
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
  // Confirmation email is deliberately held until the admin flips the order
  // to CONFIRMED. New orders start PENDING and the customer is told so on the
  // frontend. The notification helpers remain idempotent — one email per order
  // guaranteed by orderConfirmationSentAt on first dispatch.
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
          isPreOrder: o.isPreOrder ?? false,
          expectedDeliveryDate: o.expectedDeliveryDate ?? null,
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
  // Simplified flow: no cancellation email — customers only receive the
  // confirmation (on placement) and the delivery+review message (on DELIVERED).
  res.status(200).json({
    success: true,
    message: "Order cancelled successfully",
    data: toOrderResponse(cancelled, items),
  });
};

// @desc    Guest checkout — place an order without logging in. Items are sent
//          directly in the body (no cart). The server finds or auto-creates a
//          passive customer account by phone so the order is still linked to a
//          user. The customer may later claim that account by OTP-login with
//          the same phone and will see this order in their history.
// @route   POST /api/orders/guest
// @access  Public
export const createGuestOrder = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;

  // Find or create the customer FIRST so we can thread their id through the
  // rest of the draft (coupon rules + reservation + order creation).
  const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber : "";
  const customer = await findOrCreateGuestCustomer(phoneNumber, {
    fullName: typeof body.customerName === "string" ? body.customerName.trim() : "",
    email: typeof body.email === "string" && body.email.trim() ? body.email.trim() : null,
  });

  const draft = await buildGuestOrderDraft(customer._id, body);

  const session = await mongoose.startSession();
  let order: OrderDocument | undefined;
  try {
    await session.withTransaction(async () => {
      const seq = await nextSequence("order", ORDER_NUMBER_START, session);
      [order] = await Order.create(
        [
          {
            orderNumber: `${ORDER_NUMBER_PREFIX}${seq}`,
            customerId: customer._id,
            orderStatus: ORDER_STATUS.PENDING,
            subtotal: draft.subtotal,
            discount: draft.discount,
            couponId: draft.coupon?.coupon._id ?? null,
            couponCode: draft.coupon?.code ?? null,
            fulfillmentMethod: draft.shippingInfo.fulfillmentMethod,
            shippingCost: draft.shippingCost,
            adminDiscountType: draft.adminDiscount?.type ?? null,
            adminDiscountValue: draft.adminDiscount?.value ?? 0,
            adminDiscountAmount: draft.adminDiscount?.amount ?? 0,
            isPreOrder: draft.isPreOrder,
            preOrderMinDays: draft.preOrderMinDays,
            expectedDeliveryDate: draft.expectedDeliveryDate,
            totalAmount: draft.totalAmount,
            paymentMethod: draft.shippingInfo.paymentMethod,
            shippingName: draft.shippingInfo.customerName,
            shippingPhone: draft.shippingInfo.phoneNumber,
            shippingEmail: draft.shippingInfo.email,
            shippingAddress: draft.shippingInfo.shippingAddress,
            shippingCity: draft.shippingInfo.city,
            shippingArea: draft.shippingInfo.area,
            orderNotes: draft.shippingInfo.orderNotes,
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

      const stockNeeded = new Map<string, number>();
      for (const item of draft.items) {
        if (item.productId) {
          if (item.isPreOrder) continue;
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
        await reserveStock(productId, quantity, session, { orderId: order._id, createdBy: customer._id });
      }

      for (const comboLine of draft.comboLines) {
        const comboItem = draft.items.find((i) => i.comboId && String(i.comboId) === String(comboLine.comboId));
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
  // Guest orders also wait for admin CONFIRMED before the confirmation
  // message fires — same rule as logged-in checkout.
  await logActivity(req, {
    action: "ORDER_CREATED",
    targetOrderId: created._id,
    newValue: { orderNumber: created.orderNumber, totalAmount: created.totalAmount, itemCount: items.length, guest: true },
  });

  res.status(201).json({
    success: true,
    message: "Order placed successfully",
    data: {
      ...toOrderResponse(created, items),
      // Guest-friendly track reference so the UI can show it immediately.
      tracking: {
        orderNumber: created.orderNumber,
        trackUrl: `/api/orders/track?orderNumber=${encodeURIComponent(created.orderNumber)}&phone=${encodeURIComponent(created.shippingPhone)}`,
      },
    },
  });
};

// @desc    Public order tracking. No login — the caller supplies the order
//          number and the phone number on file; both must match. Returns a
//          narrower response than the authenticated route (no customer PII
//          beyond what's already on the order).
// @route   GET /api/orders/track?orderNumber=ORD-1023&phone=01712345678
// @access  Public
export const trackOrder = async (req: Request, res: Response) => {
  const orderNumber = queryString(req.query.orderNumber);
  const phone = queryString(req.query.phone);
  if (!orderNumber || !orderNumber.trim()) throw new AppError("orderNumber is required", 400);
  if (!phone || !phone.trim()) throw new AppError("phone is required", 400);
  const normalizedPhone = normalizeBdPhone(phone);
  if (!normalizedPhone) throw new AppError("phone must be a valid Bangladeshi phone number", 400);

  const order = await Order.findOne({
    orderNumber: orderNumber.trim().toUpperCase(),
    shippingPhone: normalizedPhone,
  }).lean();
  if (!order) throw new AppError("Order not found. Check the order number and phone number.", 404);

  const items = await OrderItem.find({ orderId: order._id }).lean();

  // Public view — mirror only the fields a customer needs to see.
  res.status(200).json({
    success: true,
    message: "Order fetched successfully",
    data: {
      orderNumber: order.orderNumber,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      fulfillmentMethod: order.fulfillmentMethod,
      isPreOrder: order.isPreOrder ?? false,
      expectedDeliveryDate: order.expectedDeliveryDate ?? null,
      confirmedAt: order.confirmedAt ?? null,
      deliveredAt: order.deliveredAt ?? null,
      cancelledAt: order.cancelledAt ?? null,
      cancellationReason: order.cancellationReason ?? null,
      shippingInformation: {
        name: order.shippingName,
        phone: order.shippingPhone,
        email: order.shippingEmail,
        address: order.shippingAddress,
        city: order.shippingCity,
        area: order.shippingArea,
      },
      items: items.map((i) => ({
        productTitle: i.productTitleSnapshot,
        thumbnail: i.thumbnailSnapshot,
        quantity: i.quantity,
        selectedSize: i.selectedSize,
        unitPrice: i.unitPrice,
        subtotal: i.subtotal,
      })),
      subtotal: order.subtotal,
      discount: order.discount,
      shippingCost: order.shippingCost,
      totalAmount: order.totalAmount,
      createdAt: order.createdAt,
    },
  });
};
