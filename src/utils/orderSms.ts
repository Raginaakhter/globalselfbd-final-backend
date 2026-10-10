import type { Types } from "mongoose";
import Order from "../models/Order";
import User from "../models/User";
import Product from "../models/Product";
import type { IOrder } from "../models/Order";
import type { IOrderItem } from "../models/OrderItem";
import { sendSms } from "./sendSms";
import { siteUrl } from "./campaignEmail";

type NotifyOrder = { _id: Types.ObjectId | string } & Pick<
  IOrder,
  "orderNumber" | "customerId" | "shippingPhone"
>;
type NotifyItem = Pick<IOrderItem, "productId" | "productTitleSnapshot">;

// Where the customer lands to leave a review. Single-product orders deep-link to
// the product's review section; multi-product orders go to the order page where
// every item is listed with its own review action.
export const buildReviewUrl = async (
  order: NotifyOrder,
  items: NotifyItem[]
): Promise<string> => {
  const productIds = items.map((i) => i.productId).filter(Boolean) as Types.ObjectId[];
  if (productIds.length === 1) {
    const product = await Product.findById(productIds[0]).select("slug").lean();
    if (product?.slug) {
      return `${siteUrl()}/product/${encodeURIComponent(product.slug)}?review=${String(order._id)}#reviews`;
    }
  }
  return `${siteUrl()}/profile/orders/${String(order._id)}`;
};

// Phone used to reach the customer: prefer the registered account phone, fall
// back to the order's shipping phone for guest / legacy accounts.
const resolvePhone = async (order: NotifyOrder): Promise<string | null> => {
  const user = await User.findById(order.customerId).select("phoneNumber").lean();
  return user?.phoneNumber || order.shippingPhone || null;
};

// --------------------------------------------------------------------------
// Delivery + review combined SMS (ONE message)
// --------------------------------------------------------------------------
export const notifyDeliverySms = (order: NotifyOrder, items: NotifyItem[]): void => {
  setImmediate(async () => {
    try {
      // Atomic claim prevents duplicates on refresh/race.
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, deliverySmsSentAt: null },
        { $set: { deliverySmsSentAt: new Date() } },
        { returnDocument: "after" }
      ).select("_id");
      if (!claimed) return;

      const to = await resolvePhone(order);
      if (!to) {
        await Order.updateOne({ _id: order._id }, { $set: { deliverySmsSentAt: null } });
        return;
      }

      const reviewUrl = await buildReviewUrl(order, items);
      const message = `Your order #${order.orderNumber} has been delivered successfully. Thank you for shopping with us! Please share your experience by leaving a review: ${reviewUrl}`;

      const result = await sendSms({ to, message });
      // Release the slot on provider failure so a retry (admin re-trigger) can succeed.
      if (!result.sent) {
        await Order.updateOne({ _id: order._id }, { $set: { deliverySmsSentAt: null } });
      }
    } catch (error) {
      console.error(`❌ Delivery SMS (${order.orderNumber}) not sent:`, (error as Error).message);
      await Order.updateOne({ _id: order._id }, { $set: { deliverySmsSentAt: null } }).catch(() => {});
    }
  });
};

// --------------------------------------------------------------------------
// Order confirmation SMS (sent immediately after a successful order placement
// for phone-based accounts).
// --------------------------------------------------------------------------
export const notifyOrderPlacedSms = (order: NotifyOrder): void => {
  setImmediate(async () => {
    try {
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, orderConfirmationSentAt: null },
        { $set: { orderConfirmationSentAt: new Date() } },
        { returnDocument: "after" }
      ).select("_id");
      if (!claimed) return;

      const to = await resolvePhone(order);
      if (!to) {
        await Order.updateOne({ _id: order._id }, { $set: { orderConfirmationSentAt: null } });
        return;
      }

      const message = `Your order #${order.orderNumber} has been placed successfully. Thank you for shopping with us!`;
      const result = await sendSms({ to, message });
      if (!result.sent) {
        await Order.updateOne({ _id: order._id }, { $set: { orderConfirmationSentAt: null } });
      }
    } catch (error) {
      console.error(`❌ Order confirmation SMS (${order.orderNumber}) not sent:`, (error as Error).message);
      await Order.updateOne({ _id: order._id }, { $set: { orderConfirmationSentAt: null } }).catch(() => {});
    }
  });
};
