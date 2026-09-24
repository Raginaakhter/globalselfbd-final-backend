import User from "../models/User";
import type { IOrder } from "../models/Order";
import type { IOrderItem } from "../models/OrderItem";
import type { OrderStatus, PaymentMethod } from "../config/orderOptions";
import { isEmailConfigured, sendEmail, escapeHtml, emailLayout } from "./sendEmail";

export type OrderEmailEvent = "PLACED" | Exclude<OrderStatus, "PENDING">;
type EmailOrder = Pick<
  IOrder,
  | "orderNumber"
  | "customerId"
  | "shippingName"
  | "shippingPhone"
  | "shippingEmail"
  | "shippingAddress"
  | "shippingArea"
  | "shippingCity"
  | "orderNotes"
  | "paymentMethod"
  | "subtotal"
  | "discount"
  | "shippingCost"
  | "totalAmount"
>;
type EmailItem = Pick<IOrderItem, "productTitleSnapshot" | "selectedSize" | "selectedUnit" | "quantity" | "unitPrice" | "subtotal">;

const money = (n: number): string =>
  `৳${Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  CASH_ON_DELIVERY: "Cash on Delivery",
  BKASH: "bKash",
  NAGAD: "Nagad",
  ROCKET: "Rocket",
  CARD: "Card",
};

// Subject line and message for each order event
const EVENTS: Record<OrderEmailEvent, { subject: string; heading: string; text: string }> = {
  PLACED: { subject: "We received your order", heading: "Thank you for your order!", text: "We have received your order and will confirm it soon." },
  CONFIRMED: { subject: "Your order is confirmed", heading: "Order confirmed", text: "Your order has been confirmed and will be prepared soon." },
  PROCESSING: { subject: "Your order is being prepared", heading: "Order is being prepared", text: "We are packing your order." },
  SHIPPED: { subject: "Your order has been shipped", heading: "Order shipped", text: "Your order is on the way. Please keep your phone nearby for the delivery call." },
  DELIVERED: { subject: "Your order has been delivered", heading: "Order delivered", text: "Your order has been delivered. Thank you for shopping with us!" },
  CANCELLED: { subject: "Your order has been cancelled", heading: "Order cancelled", text: "Your order has been cancelled. If you paid online, the refund will be processed." },
};

const itemsTable = (items: EmailItem[]): string => `
<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
  <thead>
    <tr style="background:#f3f4f6;text-align:left">
      <th style="padding:8px">Product</th><th style="padding:8px;text-align:center">Qty</th><th style="padding:8px;text-align:right">Price</th><th style="padding:8px;text-align:right">Subtotal</th>
    </tr>
  </thead>
  <tbody>
    ${items
      .map((i) => {
        const options = [i.selectedSize && `Size: ${escapeHtml(i.selectedSize)}`, i.selectedUnit && `Unit: ${escapeHtml(i.selectedUnit)}`]
          .filter(Boolean)
          .join(" · ");
        return `<tr style="border-bottom:1px solid #e5e7eb">
          <td style="padding:8px">${escapeHtml(i.productTitleSnapshot)}${options ? `<br><span style="font-size:12px;color:#6b7280">${options}</span>` : ""}</td>
          <td style="padding:8px;text-align:center">${i.quantity}</td>
          <td style="padding:8px;text-align:right">${money(i.unitPrice)}</td>
          <td style="padding:8px;text-align:right">${money(i.subtotal)}</td>
        </tr>`;
      })
      .join("")}
  </tbody>
</table>`;

const totalsBlock = (order: EmailOrder): string => `
<table style="width:100%;font-size:14px;margin-bottom:16px">
  <tr><td style="padding:4px 8px">Subtotal</td><td style="padding:4px 8px;text-align:right">${money(order.subtotal)}</td></tr>
  ${order.discount > 0 ? `<tr><td style="padding:4px 8px">Discount</td><td style="padding:4px 8px;text-align:right">-${money(order.discount)}</td></tr>` : ""}
  <tr><td style="padding:4px 8px">Shipping</td><td style="padding:4px 8px;text-align:right">${money(order.shippingCost)}</td></tr>
  <tr style="font-weight:bold"><td style="padding:8px;border-top:2px solid #111827">Total</td><td style="padding:8px;border-top:2px solid #111827;text-align:right">${money(order.totalAmount)}</td></tr>
</table>`;

const shippingBlock = (order: EmailOrder): string => `
<div style="background:#f9fafb;border-radius:6px;padding:12px 16px;font-size:14px;line-height:1.6">
  <strong>Delivery to</strong><br>
  ${escapeHtml(order.shippingName)} · ${escapeHtml(order.shippingPhone)}<br>
  ${escapeHtml(order.shippingAddress)}, ${escapeHtml(order.shippingArea)}, ${escapeHtml(order.shippingCity)}
  ${order.orderNotes ? `<br><span style="color:#6b7280">Note: ${escapeHtml(order.orderNotes)}</span>` : ""}
  <br><br><strong>Payment:</strong> ${PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod}
</div>`;

export const buildOrderEmail = (event: OrderEmailEvent, order: EmailOrder, items: EmailItem[]) => {
  const e = EVENTS[event];
  const html = emailLayout(
    e.heading,
    `<p>Hi ${escapeHtml(order.shippingName)},</p>
     <p>${e.text}</p>
     <p style="font-size:15px"><strong>Order number:</strong> ${escapeHtml(order.orderNumber)}</p>
     ${itemsTable(items)}
     ${totalsBlock(order)}
     ${event === "CANCELLED" ? "" : shippingBlock(order)}`
  );
  const text = [
    `Hi ${order.shippingName},`,
    "",
    e.text,
    `Order number: ${order.orderNumber}`,
    "",
    ...items.map((i) => `- ${i.productTitleSnapshot}${i.selectedSize ? ` (${i.selectedSize})` : ""} x${i.quantity}: ${money(i.subtotal)}`),
    "",
    `Total: ${money(order.totalAmount)}`,
  ].join("\n");
  return { subject: `${e.subject} (${order.orderNumber})`, html, text };
};

// Checkout email, or the customer's account email
const getRecipient = async (order: EmailOrder): Promise<string | undefined> => {
  if (order.shippingEmail) return order.shippingEmail;
  const user = await User.findById(order.customerId).select("email").lean();
  return user?.email;
};

// Fire-and-forget: never delays or fails the API response
export const notifyOrderEvent = (event: OrderEmailEvent, order: EmailOrder, items: EmailItem[]): void => {
  if (!isEmailConfigured() || !EVENTS[event]) return;
  setImmediate(async () => {
    try {
      const to = await getRecipient(order);
      if (!to) return;
      await sendEmail({ to, ...buildOrderEmail(event, order, items) });
    } catch (error) {
      console.error(`❌ Order email (${event}, ${order.orderNumber}) not sent:`, (error as Error).message);
    }
  });
};
