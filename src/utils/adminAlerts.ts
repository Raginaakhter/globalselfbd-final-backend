import type { Types } from "mongoose";
import Product from "../models/Product";
import StockRequest from "../models/StockRequest";
import { loadNotificationSettings } from "../controllers/settingsController";
import { isEmailConfigured, sendEmail, emailLayout, escapeHtml } from "./sendEmail";

// Internal admin notification channel. Resend only — never SMS, never customer-facing.
// Caller is expected to invoke these fire-and-forget; failures are logged.
const sendAdminEmail = async (subject: string, html: string, text: string): Promise<boolean> => {
  if (!isEmailConfigured()) return false;
  const { adminEmail } = await loadNotificationSettings();
  if (!adminEmail) return false;
  try {
    await sendEmail({ to: adminEmail, subject, html, text });
    return true;
  } catch (error) {
    console.error("❌ Admin alert email failed:", (error as Error).message);
    return false;
  }
};

// Fire-and-forget stock-out alert. Called when a product's stock hits 0 after an
// inventory decrement. We flip a lastStockOutAlertAt field on the product so repeated
// decrements (impossible, since stock can't go below 0 — but defensive) never fire twice.
export const notifyStockOut = (productId: Types.ObjectId | string): void => {
  setImmediate(async () => {
    try {
      // Claim the alert: only fire when this is the first zero we've seen since the
      // last time stock was non-zero. If a previous zero was already announced, bail.
      const claimed = await Product.findOneAndUpdate(
        { _id: productId, stock: 0, $or: [{ lastStockOutAlertAt: null }, { lastStockOutAlertAt: { $exists: false } }] },
        { $set: { lastStockOutAlertAt: new Date() } },
        { returnDocument: "after" }
      ).select("productTitle slug stock sku");
      if (!claimed) return;

      const subject = `Stock-out alert: ${claimed.productTitle}`;
      const html = emailLayout(
        "Product is out of stock",
        `<p>This product has reached <strong>0</strong> units in stock:</p>
         <table style="font-size:14px;margin:12px 0">
           <tr><td style="padding:4px 8px"><strong>Title</strong></td><td style="padding:4px 8px">${escapeHtml(claimed.productTitle)}</td></tr>
           <tr><td style="padding:4px 8px"><strong>SKU</strong></td><td style="padding:4px 8px">${escapeHtml(claimed.sku || "—")}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Slug</strong></td><td style="padding:4px 8px">${escapeHtml(claimed.slug)}</td></tr>
         </table>
         <p>Please restock in the admin dashboard.</p>`
      );
      const text = `Stock-out: ${claimed.productTitle} (SKU: ${claimed.sku || "n/a"})`;
      const sent = await sendAdminEmail(subject, html, text);
      if (!sent) {
        await Product.updateOne({ _id: productId }, { $set: { lastStockOutAlertAt: null } });
      }
    } catch (error) {
      console.error("❌ Stock-out alert failed:", (error as Error).message);
    }
  });
};

// Fire-and-forget low-stock alert. Called whenever available stock drops to or
// below the per-product threshold. Dedup is on `lastLowStockAlertAt`: once set,
// no more alerts fire until the admin manually clears it OR stock rises above
// threshold (which clears the flag automatically in reservation release/receive).
export const notifyLowStock = (productId: Types.ObjectId | string): void => {
  setImmediate(async () => {
    try {
      // Only fire when (a) threshold is positive AND (b) available <= threshold
      // AND (c) we haven't alerted on this low cycle yet. Expressed as $expr so
      // the whole check runs atomically.
      const claimed = await Product.findOneAndUpdate(
        {
          _id: productId,
          lowStockThreshold: { $gt: 0 },
          $or: [{ lastLowStockAlertAt: null }, { lastLowStockAlertAt: { $exists: false } }],
          $expr: {
            $lte: [
              { $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] },
              "$lowStockThreshold",
            ],
          },
        },
        { $set: { lastLowStockAlertAt: new Date() } },
        { returnDocument: "after" }
      ).select("productTitle slug sku stock reserved lowStockThreshold");
      if (!claimed) return;

      const available = Math.max(0, (claimed.stock || 0) - (claimed.reserved || 0));
      const subject = `Low stock alert: ${claimed.productTitle}`;
      const html = emailLayout(
        "Product low stock alert",
        `<p>This product has reached its low-stock threshold:</p>
         <table style="font-size:14px;margin:12px 0">
           <tr><td style="padding:4px 8px"><strong>Product</strong></td><td style="padding:4px 8px">${escapeHtml(claimed.productTitle)}</td></tr>
           <tr><td style="padding:4px 8px"><strong>SKU</strong></td><td style="padding:4px 8px">${escapeHtml(claimed.sku || "—")}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Current stock</strong></td><td style="padding:4px 8px">${claimed.stock}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Available</strong></td><td style="padding:4px 8px">${available}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Low-stock threshold</strong></td><td style="padding:4px 8px">${claimed.lowStockThreshold}</td></tr>
         </table>
         <p>Please consider restocking this product.</p>`
      );
      const text = `Low stock: ${claimed.productTitle} — ${available} available, threshold ${claimed.lowStockThreshold}`;
      const sent = await sendAdminEmail(subject, html, text);
      if (!sent) {
        await Product.updateOne({ _id: productId }, { $set: { lastLowStockAlertAt: null } });
      }
    } catch (error) {
      console.error("❌ Low-stock alert failed:", (error as Error).message);
    }
  });
};

// Fire-and-forget customer stock-request alert. Rate-limited server-side by
// NOTIFY_WINDOW_MINUTES: within that window, repeat requests for the same
// (product, customer) are grouped and no new email is sent. We stamp
// notifiedAt and set status to NOTIFIED so the admin dashboard can tell at a
// glance which rows already triggered an email.
const NOTIFY_WINDOW_MINUTES = 30;

export const notifyStockRequest = (requestId: Types.ObjectId | string): void => {
  setImmediate(async () => {
    try {
      const windowStart = new Date(Date.now() - NOTIFY_WINDOW_MINUTES * 60 * 1000);
      const request = await StockRequest.findOne({ _id: requestId });
      if (!request) return;

      // Rate-limit: if ANY stock request for the same (product, customer) was
      // already notified in the last window, mark this one NOTIFIED but send no email.
      const customerKey = request.customerId
        ? { customerId: request.customerId }
        : { customerPhone: request.customerPhone || "__none__", customerEmail: request.customerEmail || "__none__" };
      const recent = await StockRequest.findOne({
        _id: { $ne: request._id },
        productId: request.productId,
        notifiedAt: { $gte: windowStart },
        ...customerKey,
      }).lean();
      if (recent) {
        request.status = "NOTIFIED";
        request.notifiedAt = new Date();
        await request.save();
        return;
      }

      const subject = `Customer stock request: ${request.productTitleSnapshot}`;
      const html = emailLayout(
        "Customer requested more stock than available",
        `<table style="font-size:14px;margin:12px 0">
           <tr><td style="padding:4px 8px"><strong>Product</strong></td><td style="padding:4px 8px">${escapeHtml(request.productTitleSnapshot)}</td></tr>
           <tr><td style="padding:4px 8px"><strong>SKU</strong></td><td style="padding:4px 8px">${escapeHtml(request.skuSnapshot || "—")}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Available</strong></td><td style="padding:4px 8px">${request.availableQuantity}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Requested</strong></td><td style="padding:4px 8px">${request.requestedQuantity}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Shortage</strong></td><td style="padding:4px 8px">${request.shortageQuantity}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Customer</strong></td><td style="padding:4px 8px">${escapeHtml(request.customerName || "Guest")}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Phone</strong></td><td style="padding:4px 8px">${escapeHtml(request.customerPhone || "—")}</td></tr>
           <tr><td style="padding:4px 8px"><strong>Email</strong></td><td style="padding:4px 8px">${escapeHtml(request.customerEmail || "—")}</td></tr>
         </table>
         <p>Consider adjusting the shipment plan or contacting the customer.</p>`
      );
      const text = `Customer wants ${request.requestedQuantity} of ${request.productTitleSnapshot}, only ${request.availableQuantity} available (short by ${request.shortageQuantity}).`;
      const sent = await sendAdminEmail(subject, html, text);
      if (sent) {
        request.status = "NOTIFIED";
        request.notifiedAt = new Date();
        await request.save();
      }
    } catch (error) {
      console.error("❌ Stock-request alert failed:", (error as Error).message);
    }
  });
};
