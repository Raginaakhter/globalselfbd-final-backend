import mongoose, { type Types } from "mongoose";
import Order, { type IOrder, type OrderDocument } from "../models/Order";
import OrderItem, { type IOrderItem } from "../models/OrderItem";
import Combo from "../models/Combo";
import AppError from "./AppError";
import { releaseCoupon } from "./coupons";
import { restoreStock } from "./inventory";
import { CANCELLABLE_STATUSES, ORDER_STATUS } from "../config/orderOptions";

export type OrderItemRecord = IOrderItem & { _id: Types.ObjectId };
type OrderRecord = IOrder & { _id: Types.ObjectId };

// Find by Mongo ID or order number (ORD-1001), optionally limited to one customer
export const findOrderOr404 = async (idOrNumber: string, customerId?: Types.ObjectId): Promise<OrderDocument> => {
  const filter: Record<string, unknown> = mongoose.isValidObjectId(idOrNumber)
    ? { _id: idOrNumber }
    : { orderNumber: String(idOrNumber).toUpperCase() };
  // Customers only ever see their own orders (someone else's order looks "not found")
  if (customerId) filter.customerId = customerId;
  const order = await Order.findOne(filter);
  if (!order) throw new AppError("Order not found", 404);
  return order;
};

export const getItemsByOrder = async (orderIds: Types.ObjectId[]): Promise<Map<string, OrderItemRecord[]>> => {
  const items = await OrderItem.find({ orderId: { $in: orderIds } }).sort({ createdAt: 1 }).lean();
  const byOrder = new Map<string, OrderItemRecord[]>();
  for (const item of items) {
    const key = String(item.orderId);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key)!.push(item);
  }
  return byOrder;
};

const toItemResponse = (item: OrderItemRecord) => ({
  _id: item._id,
  type: item.comboId ? ("combo" as const) : ("product" as const),
  productId: item.productId,
  comboId: item.comboId,
  productTitleSnapshot: item.productTitleSnapshot,
  thumbnailSnapshot: item.thumbnailSnapshot,
  quantity: item.quantity,
  selectedSize: item.selectedSize,
  selectedUnit: item.selectedUnit,
  unitPrice: item.unitPrice,
  subtotal: item.subtotal,
  comboItemsSnapshot: item.comboItemsSnapshot || [],
});

interface CustomerInfo {
  _id: Types.ObjectId;
  fullName: string;
  email: string;
}

// Full order details (customer and admin); admin also gets the customer account
export const toOrderResponse = (
  order: OrderDocument | OrderRecord,
  items: OrderItemRecord[],
  customer?: CustomerInfo | null
) => {
  const o: OrderRecord = "toObject" in order && typeof order.toObject === "function" ? order.toObject() : (order as OrderRecord);
  return {
    _id: o._id,
    orderNumber: o.orderNumber,
    customerId: o.customerId,
    items: items.map(toItemResponse),
    itemCount: items.length,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotal: o.subtotal,
    discount: o.discount,
    couponCode: o.couponCode ?? null,
    shippingCost: o.shippingCost,
    totalAmount: o.totalAmount,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    orderStatus: o.orderStatus,
    // The customer may still cancel it (the backend checks this again on cancel)
    canCancel: CANCELLABLE_STATUSES.includes(o.orderStatus),
    shippingInformation: {
      name: o.shippingName,
      phone: o.shippingPhone,
      email: o.shippingEmail,
      address: o.shippingAddress,
      city: o.shippingCity,
      area: o.shippingArea,
      orderNotes: o.orderNotes,
    },
    cancelledAt: o.cancelledAt,
    confirmedAt: o.confirmedAt ?? null,
    shippedAt: o.shippedAt ?? null,
    deliveredAt: o.deliveredAt ?? null,
    paidAt: o.paidAt ?? null,
    refundedAt: o.refundedAt ?? null,
    // Product price given back; the delivery charge is never refunded
    refundAmount: o.refundAmount ?? 0,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    ...(customer !== undefined
      ? { customer: customer ? { _id: customer._id, fullName: customer.fullName, email: customer.email } : null }
      : {}),
  };
};

// Cancel + restore stock in one transaction. The status filter makes it idempotent:
// a second cancel finds nothing to update, so stock is never restored twice.
export const cancelOrder = async (order: OrderDocument): Promise<OrderDocument> => {
  if (!CANCELLABLE_STATUSES.includes(order.orderStatus)) {
    throw new AppError(`Order cannot be cancelled when it is ${order.orderStatus}`, 400);
  }

  const session = await mongoose.startSession();
  let cancelled: OrderDocument | null = null;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      cancelled = await Order.findOneAndUpdate(
        { _id: order._id, orderStatus: { $in: CANCELLABLE_STATUSES }, stockRestoredAt: null },
        { $set: { orderStatus: ORDER_STATUS.CANCELLED, cancelledAt: now, stockRestoredAt: now } },
        { session, returnDocument: "after" }
      );
      if (!cancelled) throw new AppError("Order is already cancelled or can no longer be cancelled", 409);

      const items = await OrderItem.find({ orderId: order._id }).session(session);
      // Restore product stock from product lines AND from combo member snapshots
      const toRestore = new Map<string, number>();
      for (const item of items) {
        if (item.productId) {
          const key = String(item.productId);
          toRestore.set(key, (toRestore.get(key) || 0) + item.quantity);
        } else if (item.comboId) {
          for (const member of item.comboItemsSnapshot) {
            const key = String(member.productId);
            toRestore.set(key, (toRestore.get(key) || 0) + member.quantity * item.quantity);
          }
        }
      }
      for (const [productId, quantity] of toRestore) {
        await restoreStock(productId, quantity, session);
      }
      // Roll back combo analytics
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
        await Combo.updateOne(
          { _id: comboId },
          { $inc: { soldCount: -totals.quantity, revenue: -totals.revenue } },
          { session }
        );
      }
      await releaseCoupon(order._id, session);
    });
  } finally {
    await session.endSession();
  }
  if (!cancelled) throw new AppError("Order could not be cancelled", 409);
  return cancelled;
};
