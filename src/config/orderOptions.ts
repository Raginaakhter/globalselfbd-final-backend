// Order, payment, shipping and cart rules. Change business rules here.

export const ORDER_STATUS = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  PROCESSING: "PROCESSING",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export const ORDER_STATUSES = Object.values(ORDER_STATUS);

// Allowed next statuses for each status
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

// Statuses from which an order can be cancelled (stock is restored)
export const CANCELLABLE_STATUSES: readonly OrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING"];

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

export const ORDER_NUMBER_PREFIX = "ORD-";
export const ORDER_NUMBER_START = 1000;

// Type guards for values coming from requests
export const isOrderStatus = (value: unknown): value is OrderStatus =>
  typeof value === "string" && (ORDER_STATUSES as string[]).includes(value);
export const isPaymentStatus = (value: unknown): value is PaymentStatus =>
  typeof value === "string" && (PAYMENT_STATUSES as string[]).includes(value);
export const isPaymentMethod = (value: unknown): value is PaymentMethod =>
  typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
