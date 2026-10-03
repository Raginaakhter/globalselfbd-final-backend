import type { Types } from "mongoose";
import Invoice, { type InvoiceDocument } from "../models/Invoice";
import OrderItem from "../models/OrderItem";
import { nextSequence } from "../models/Counter";
import type { OrderDocument } from "../models/Order";
import AppError from "./AppError";

const BD_OFFSET_MS = 6 * 60 * 60 * 1000;

// Invoice numbers restart every day (Bangladesh time): INV-20260928-000001
const nextInvoiceNumber = async (date: Date): Promise<string> => {
  const day = new Date(date.getTime() + BD_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
  const seq = await nextSequence(`invoice-${day}`);
  return `INV-${day}-${String(seq).padStart(6, "0")}`;
};

// Orders that can have an invoice: everything except cancelled ones
export const assertInvoiceable = (order: OrderDocument): void => {
  if (order.orderStatus === "CANCELLED") throw new AppError("A cancelled order cannot get an invoice", 400);
};

// Create the invoice for an order, or return the one it already has (never two per order)
export const issueInvoice = async (
  order: OrderDocument,
  createdBy: Types.ObjectId | null = null
): Promise<{ invoice: InvoiceDocument; created: boolean }> => {
  const existing = await Invoice.findOne({ orderId: order._id });
  if (existing) return { invoice: existing, created: false };
  assertInvoiceable(order);

  const items = await OrderItem.find({ orderId: order._id }).sort({ _id: 1 }).lean();
  const issuedAt = new Date();
  try {
    const invoice = await Invoice.create({
      invoiceNumber: await nextInvoiceNumber(issuedAt),
      orderId: order._id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      customerName: order.shippingName,
      customerPhone: order.shippingPhone,
      customerEmail: order.shippingEmail,
      shippingAddress: order.shippingAddress,
      shippingArea: order.shippingArea,
      shippingCity: order.shippingCity,
      items: items.map((i) => ({
        productId: i.productId,
        comboId: i.comboId,
        productTitle: i.productTitleSnapshot,
        selectedSize: i.selectedSize,
        selectedUnit: i.selectedUnit,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        subtotal: i.subtotal,
      })),
      subtotal: order.subtotal,
      discount: order.discount,
      couponCode: order.couponCode ?? null,
      shippingCost: order.shippingCost,
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      issuedAt,
      createdBy,
    });
    return { invoice, created: true };
  } catch (error) {
    // Two requests at the same moment: the other one already created it
    if ((error as { code?: number }).code === 11000) {
      const again = await Invoice.findOne({ orderId: order._id });
      if (again) return { invoice: again, created: false };
    }
    throw error;
  }
};

// Used after an order is confirmed: an invoice problem must never break the order update
export const issueInvoiceQuietly = async (order: OrderDocument): Promise<void> => {
  try {
    await issueInvoice(order);
  } catch (error) {
    console.error(`❌ Invoice for ${order.orderNumber} could not be created:`, (error as Error).message);
  }
};
