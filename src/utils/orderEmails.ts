import type { Types } from "mongoose";
import User from "../models/User";
import Order from "../models/Order";
import type { IOrder } from "../models/Order";
import type { IOrderItem } from "../models/OrderItem";
import { CANCELLABLE_STATUSES, type OrderStatus, type PaymentMethod } from "../config/orderOptions";
import { isEmailConfigured, sendEmail, escapeHtml, emailLayout } from "./sendEmail";
import { siteUrl } from "./campaignEmail";
import { notifyOrderPlacedSms, notifyDeliverySms, buildReviewUrl } from "./orderSms";

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
  | "fulfillmentMethod"
  | "shippingCost"
  | "adminDiscountAmount"
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
  READY_TO_SHIP: { subject: "Your order is ready to ship", heading: "Order ready to ship", text: "Your order has been packed and is waiting to be picked up by the courier." },
  SHIPPED: { subject: "Your order has been shipped", heading: "Order shipped", text: "Your order is on the way. Please keep your phone nearby for the delivery call." },
  OUT_FOR_DELIVERY: { subject: "Your order is out for delivery", heading: "Out for delivery", text: "Your order is out for delivery today. Please keep your phone nearby." },
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

const shippingLineLabel = (order: EmailOrder): string =>
  order.fulfillmentMethod === "STORE_PICKUP" ? "Delivery (Store pickup)" : "Delivery charge";
const shippingLineValue = (order: EmailOrder): string =>
  order.fulfillmentMethod === "STORE_PICKUP" || order.shippingCost === 0 ? "Free" : money(order.shippingCost);

const totalsBlock = (order: EmailOrder): string => `
<table style="width:100%;font-size:14px;margin-bottom:16px">
  <tr><td style="padding:4px 8px">Subtotal</td><td style="padding:4px 8px;text-align:right">${money(order.subtotal)}</td></tr>
  ${order.discount > 0 ? `<tr><td style="padding:4px 8px">Discount${order.couponCode ? ` (coupon ${order.couponCode})` : ""}</td><td style="padding:4px 8px;text-align:right">-${money(order.discount)}</td></tr>` : ""}
  ${(order.adminDiscountAmount || 0) > 0 ? `<tr><td style="padding:4px 8px">Admin discount</td><td style="padding:4px 8px;text-align:right">-${money(order.adminDiscountAmount)}</td></tr>` : ""}
  <tr><td style="padding:4px 8px">${shippingLineLabel(order)}</td><td style="padding:4px 8px;text-align:right">${shippingLineValue(order)}</td></tr>
  <tr style="font-weight:bold"><td style="padding:8px;border-top:2px solid #111827">Total</td><td style="padding:8px;border-top:2px solid #111827;text-align:right">${money(order.totalAmount)}</td></tr>
</table>`;

const shippingBlock = (order: EmailOrder): string => {
  const isPickup = order.fulfillmentMethod === "STORE_PICKUP";
  const header = isPickup ? "Store pickup" : "Delivery to";
  const addressLine = isPickup
    ? "Please collect your order from our store."
    : `${escapeHtml(order.shippingAddress)}, ${escapeHtml(order.shippingArea)}, ${escapeHtml(order.shippingCity)}`;
  return `
<div style="background:#f9fafb;border-radius:6px;padding:12px 16px;font-size:14px;line-height:1.6">
  <strong>${header}</strong><br>
  ${escapeHtml(order.shippingName)} · ${escapeHtml(order.shippingPhone)}<br>
  ${addressLine}
  ${order.orderNotes ? `<br><span style="color:#6b7280">Note: ${escapeHtml(order.orderNotes)}</span>` : ""}
  <br><br><strong>Payment:</strong> ${PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod}
</div>`;
};

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

// The customer's registered email (the checkout email when the account has none).
// Phone-only accounts simply have no email delivery and are skipped silently.
const getRecipient = async (order: EmailOrder): Promise<string | undefined> => {
  const user = await User.findById(order.customerId).select("email").lean();
  return user?.email || order.shippingEmail || undefined;
};

// Decide which channel the customer should receive notifications on. Rule:
//   - Account has a registered email  -> email
//   - Else account has a phone number -> SMS
//   - Else fall back to whichever shipping contact exists.
export type NotificationChannel = "email" | "sms" | "none";
export const resolveChannel = async (order: EmailOrder): Promise<NotificationChannel> => {
  const user = await User.findById(order.customerId).select("email phoneNumber").lean();
  if (user?.email) return "email";
  if (user?.phoneNumber) return "sms";
  if (order.shippingEmail) return "email";
  if (order.shippingPhone) return "sms";
  return "none";
};

// Internal: raw send without dedup (used by routed helpers below).
const sendOrderEventEmail = async (event: OrderEmailEvent, order: EmailOrder, items: EmailItem[]): Promise<boolean> => {
  if (!isEmailConfigured() || !EVENTS[event]) return false;
  const to = await getRecipient(order);
  if (!to) return false;
  try {
    await sendEmail({ to, ...buildOrderEmail(event, order, items) });
    return true;
  } catch (error) {
    console.error(`❌ Order email (${event}, ${order.orderNumber}) not sent:`, (error as Error).message);
    return false;
  }
};

// --------------------------------------------------------------------------
// Order confirmation (ONE notification, channel chosen from the customer's
// verified contact method). Sent right after a successful order placement.
// Dedup is enforced through order.orderConfirmationSentAt (set by the SMS or
// email path, whichever actually dispatches the message).
// --------------------------------------------------------------------------
export const notifyOrderPlaced = (order: EmailOrder, items: EmailItem[]): void => {
  setImmediate(async () => {
    const channel = await resolveChannel(order);
    if (channel === "sms") {
      // Phone-first customer: send the confirmation SMS. The SMS util owns the
      // orderConfirmationSentAt dedup flag.
      notifyOrderPlacedSms(order);
      return;
    }
    if (channel !== "email") return;

    // Claim the slot before sending so a race or a replay produces one email at most.
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, orderConfirmationSentAt: null },
      { $set: { orderConfirmationSentAt: new Date() } },
      { returnDocument: "after" }
    ).select("_id");
    if (!claimed) return;

    const sent = await sendOrderEventEmail("PLACED", order, items);
    if (!sent) {
      await Order.updateOne({ _id: order._id }, { $set: { orderConfirmationSentAt: null } });
    }
  });
};

// --------------------------------------------------------------------------
// Lifecycle emails are intentionally disabled in the simplified flow: the
// customer only ever receives TWO messages — the confirmation at placement
// (notifyOrderPlaced) and the delivery+review one at DELIVERED
// (notifyDeliveredAndReview). This function is kept as a no-op so legacy
// callers keep compiling.
// --------------------------------------------------------------------------
export const notifyOrderEvent = (_event: OrderEmailEvent, _order: EmailOrder, _items: EmailItem[]): void => {
  // intentionally no-op
};

// --------------------------------------------------------------------------
// Delivery + review combined notification (ONE message, channel-routed).
// Phone-first customers already receive this as SMS via notifyDeliverySms;
// email-first customers get the single email below, with the review link
// baked in.
// --------------------------------------------------------------------------
export const notifyDeliveredAndReview = (order: EmailOrder, items: ReviewItem[]): void => {
  setImmediate(async () => {
    const channel = await resolveChannel(order);
    if (channel === "sms") {
      notifyDeliverySms(order, items);
      return;
    }
    if (channel !== "email") return;

    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, deliveryEmailSentAt: null },
      { $set: { deliveryEmailSentAt: new Date() } },
      { returnDocument: "after" }
    ).select("_id");
    if (!claimed) return;

    try {
      const to = await getRecipient(order);
      if (!to) {
        await Order.updateOne({ _id: order._id }, { $set: { deliveryEmailSentAt: null } });
        return;
      }
      const reviewUrl = await buildReviewUrl(order, items);
      const html = emailLayout(
        "Your order has been delivered",
        `<p>Hi ${escapeHtml(order.shippingName)},</p>
         <p>Your order <strong>${escapeHtml(order.orderNumber)}</strong> has been delivered successfully. Thank you for shopping with us!</p>
         <p>Please share your experience by leaving a review:</p>
         <p style="margin:20px 0">${button(reviewUrl, "Leave a review", "#f59e0b")}</p>
         <p style="font-size:13px;color:#6b7280">You can also paste this link into your browser: ${escapeHtml(reviewUrl)}</p>`
      );
      const text = `Hi ${order.shippingName},

Your order #${order.orderNumber} has been delivered successfully. Thank you for shopping with us! Please share your experience by leaving a review: ${reviewUrl}`;
      await sendEmail({
        to,
        subject: `Your order ${order.orderNumber} has been delivered — leave a review`,
        html,
        text,
      });
    } catch (error) {
      console.error(`❌ Delivery+review email (${order.orderNumber}) not sent:`, (error as Error).message);
      await Order.updateOne({ _id: order._id }, { $set: { deliveryEmailSentAt: null } }).catch(() => {});
    }
  });
};

// Legacy alias retained for callers that still reference `notifyReviewRequest`.
// The spec removes the standalone review email: this now redirects to the
// combined delivery+review helper so the single-notification rule stays intact.
export const notifyReviewRequest = (order: EmailOrder, items: ReviewItem[]): void => {
  notifyDeliveredAndReview(order, items);
};
