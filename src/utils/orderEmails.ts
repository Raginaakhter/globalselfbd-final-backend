import type { Types } from "mongoose";
import User from "../models/User";
import Product from "../models/Product";
import type { IOrder } from "../models/Order";
import type { IOrderItem } from "../models/OrderItem";
import { CANCELLABLE_STATUSES, type OrderStatus, type PaymentMethod } from "../config/orderOptions";
import { isEmailConfigured, sendEmail, escapeHtml, emailLayout } from "./sendEmail";
import { siteUrl } from "./campaignEmail";

export type OrderEmailEvent = "PLACED" | Exclude<OrderStatus, "PENDING">;
type EmailOrder = { _id: Types.ObjectId | string } & Pick<
  IOrder,
  | "orderNumber"
  | "orderStatus"
  | "cancelledAt"
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
  | "couponCode"
  | "shippingCost"
  | "totalAmount"
>;
type EmailItem = Pick<IOrderItem, "productTitleSnapshot" | "selectedSize" | "selectedUnit" | "quantity" | "unitPrice" | "subtotal">;
type ReviewItem = Pick<IOrderItem, "productId" | "productTitleSnapshot" | "thumbnailSnapshot">;

// Customer order page on the website (login is required there before anything can change)
const orderUrl = (order: EmailOrder) => `${siteUrl()}/profile/orders/${String(order._id)}`;
const bdDateTime = (d: Date) =>
  new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const button = (href: string, label: string, color = "#111827") =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:${color};color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;margin:4px 8px 4px 0">${escapeHtml(label)}</a>`;

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
  CANCELLED: { subject: "Your order has been cancelled", heading: "Order cancelled successfully", text: "Your order has been cancelled successfully. If you paid online, the refund will be processed." },
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
  ${order.discount > 0 ? `<tr><td style="padding:4px 8px">Discount${order.couponCode ? ` (coupon ${order.couponCode})` : ""}</td><td style="padding:4px 8px;text-align:right">-${money(order.discount)}</td></tr>` : ""}
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
     <p style="font-size:15px"><strong>Order number:</strong> ${escapeHtml(order.orderNumber)}<br>
       <strong>Order status:</strong> ${escapeHtml(order.orderStatus)}${
         event === "CANCELLED" && order.cancelledAt ? `<br><strong>Cancelled on:</strong> ${bdDateTime(order.cancelledAt)}` : ""
       }</p>
     ${itemsTable(items)}
     ${totalsBlock(order)}
     ${event === "CANCELLED" ? "" : shippingBlock(order)}
     <p style="margin-top:20px">${button(orderUrl(order), "View order details")}${
       // The customer can still cancel: the link opens the order page, where login is required
       event !== "CANCELLED" && CANCELLABLE_STATUSES.includes(order.orderStatus) ? button(`${orderUrl(order)}?action=cancel`, "Cancel order", "#dc2626") : ""
     }</p>`
  );
  const text = [
    `Hi ${order.shippingName},`,
    "",
    e.text,
    `Order number: ${order.orderNumber}`,
    `Order status: ${order.orderStatus}`,
    ...(event === "CANCELLED" && order.cancelledAt ? [`Cancelled on: ${bdDateTime(order.cancelledAt)}`] : []),
    "",
    ...items.map((i) => `- ${i.productTitleSnapshot}${i.selectedSize ? ` (${i.selectedSize})` : ""} x${i.quantity}: ${money(i.subtotal)}`),
    "",
    `Total: ${money(order.totalAmount)}`,
    "",
    `Order details: ${orderUrl(order)}`,
  ].join("\n");
  const subject = event === "CANCELLED" ? `Your order #${order.orderNumber} has been cancelled` : `${e.subject} (${order.orderNumber})`;
  return { subject, html, text };
};

// The customer's registered email (the checkout email when the account has none)
const getRecipient = async (order: EmailOrder): Promise<string | undefined> => {
  const user = await User.findById(order.customerId).select("email").lean();
  return user?.email || order.shippingEmail || undefined;
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

// After delivery: ask the customer to rate each product ("Rate & Review" opens the product's review section)
export const notifyReviewRequest = (order: EmailOrder, items: ReviewItem[]): void => {
  if (!isEmailConfigured() || items.length === 0) return;
  setImmediate(async () => {
    try {
      const to = await getRecipient(order);
      if (!to) return;
      const slugs = new Map(
        (await Product.find({ _id: { $in: items.map((i) => i.productId) } }).select("slug").lean()).map((p) => [String(p._id), p.slug])
      );
      const rows = items
        .filter((i) => slugs.has(String(i.productId)))
        .map((i) => {
          const url = `${siteUrl()}/product/${encodeURIComponent(slugs.get(String(i.productId)) as string)}?review=${String(order._id)}#reviews`;
          return `<tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb">
            <table role="presentation" width="100%"><tr>
              <td width="90" valign="top">${i.thumbnailSnapshot ? `<img src="${escapeHtml(i.thumbnailSnapshot)}" width="80" alt="${escapeHtml(i.productTitleSnapshot)}" style="border-radius:8px;border:1px solid #e5e7eb;display:block">` : ""}</td>
              <td valign="top" style="padding-left:10px"><div style="font-weight:bold;margin-bottom:8px">${escapeHtml(i.productTitleSnapshot)}</div>${button(url, "Rate & Review", "#f59e0b")}</td>
            </tr></table>
          </td></tr>`;
        });
      if (!rows.length) return;
      const html = emailLayout(
        "How was your order?",
        `<p>Hi ${escapeHtml(order.shippingName)},</p>
         <p>Your order <strong>${escapeHtml(order.orderNumber)}</strong> has been delivered. Please tell other customers what you think of the products you bought.</p>
         <table role="presentation" width="100%" style="border-collapse:collapse">${rows.join("")}</table>`
      );
      const text = [
        `Hi ${order.shippingName},`,
        "",
        `Your order ${order.orderNumber} has been delivered. Please rate the products you bought:`,
        ...items.filter((i) => slugs.has(String(i.productId))).map((i) => `- ${i.productTitleSnapshot}: ${siteUrl()}/product/${slugs.get(String(i.productId))}?review=${String(order._id)}#reviews`),
      ].join("\n");
      await sendEmail({ to, subject: `Rate your products (${order.orderNumber})`, html, text });
    } catch (error) {
      console.error(`❌ Review request email (${order.orderNumber}) not sent:`, (error as Error).message);
    }
  });
};
