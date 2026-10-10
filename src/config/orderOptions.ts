// Order, payment, shipping and cart rules. Change business rules here.

// Customer-facing order lifecycle is simple: an order is CONFIRMED when it is
// placed, and DELIVERED once the courier marks it handed over. CANCELLED is kept
// as an internal state for refunds and admin cleanup. The old intermediate
// statuses (PROCESSING, READY_TO_SHIP, SHIPPED, OUT_FOR_DELIVERY) are retained
// in the enum for backward compatibility with historical orders already stored
// in the database — the active flow never routes through them.
export const ORDER_STATUS = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  PROCESSING: "PROCESSING",
  READY_TO_SHIP: "READY_TO_SHIP",
  SHIPPED: "SHIPPED",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export const ORDER_STATUSES = Object.values(ORDER_STATUS);

// New simplified transitions: CONFIRMED → DELIVERED (or CANCELLED).
// Historical rows that are still PENDING / PROCESSING / READY_TO_SHIP /
// SHIPPED / OUT_FOR_DELIVERY are kept movable so admins can still finalise them.
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["DELIVERED", "CANCELLED"],
  PROCESSING: ["DELIVERED", "CANCELLED"],
  READY_TO_SHIP: ["DELIVERED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

// Statuses from which an order can be cancelled (reservation is released).
// Simplified flow: anything that hasn't shipped out yet can still be cancelled.
export const CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "READY_TO_SHIP",
];

// Statuses the customer-facing UI should ever surface. Admin dashboards show
// the full list for historical rows, but customers only ever see these two
// (plus CANCELLED when the order was cancelled).
export const CUSTOMER_VISIBLE_STATUSES: readonly OrderStatus[] = [
  "CONFIRMED",
  "DELIVERED",
  "CANCELLED",
];

export const PAYMENT_STATUS = {
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];
export const PAYMENT_STATUSES = Object.values(PAYMENT_STATUS);

// Allowed next payment statuses (payment is tracked separately from the order status)
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ["PAID", "FAILED"],
  FAILED: ["PENDING", "PAID"],
  PAID: ["REFUNDED"],
  REFUNDED: [],
};

export const PAYMENT_METHODS = ["CASH_ON_DELIVERY", "BKASH", "NAGAD", "ROCKET", "CARD"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// How the customer receives the order. STORE_PICKUP forces delivery charge to 0.
export const FULFILLMENT_METHODS = ["DELIVERY", "STORE_PICKUP"] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

// Admin-only manual discount at checkout; percent is 0..100, fixed is capped by the eligible subtotal.
export const ADMIN_DISCOUNT_TYPES = ["PERCENTAGE", "FIXED"] as const;
export type AdminDiscountType = (typeof ADMIN_DISCOUNT_TYPES)[number];

// Shipping cost by city (BDT). Override in .env
export const SHIPPING = {
  INSIDE_DHAKA: Number(process.env.SHIPPING_COST_INSIDE_DHAKA) || 80,
  OUTSIDE_DHAKA: Number(process.env.SHIPPING_COST_OUTSIDE_DHAKA) || 130,
  DHAKA_CITIES: ["dhaka"],
  // 0 = no free shipping
  FREE_SHIPPING_MIN: Number(process.env.FREE_SHIPPING_MIN_AMOUNT) || 0,
};

export const CART_LIMITS = {
  MAX_QUANTITY_PER_ITEM: 50,
  MAX_ITEMS: 50,
} as const;

// Pre-order business rules. The minimum delivery window a pre-order can promise
// is 15 days; admins may push it out further but never below this floor.
export const PRE_ORDER = {
  MIN_DELIVERY_DAYS: 15,
  MAX_DELIVERY_DAYS: 365,
  ADMIN_NOTE_MAX: 1000,
  CANCELLATION_REASON_MAX: 500,
} as const;

export const ORDER_NUMBER_PREFIX = "ORD-";
export const ORDER_NUMBER_START = 1000;

// Type guards for values coming from requests
export const isOrderStatus = (value: unknown): value is OrderStatus =>
  typeof value === "string" && (ORDER_STATUSES as string[]).includes(value);
export const isPaymentStatus = (value: unknown): value is PaymentStatus =>
  typeof value === "string" && (PAYMENT_STATUSES as string[]).includes(value);
export const isPaymentMethod = (value: unknown): value is PaymentMethod =>
  typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
export const isFulfillmentMethod = (value: unknown): value is FulfillmentMethod =>
  typeof value === "string" && (FULFILLMENT_METHODS as readonly string[]).includes(value);
export const isAdminDiscountType = (value: unknown): value is AdminDiscountType =>
  typeof value === "string" && (ADMIN_DISCOUNT_TYPES as readonly string[]).includes(value);
