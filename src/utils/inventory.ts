import mongoose, { type ClientSession, type Types } from "mongoose";
import Product, { type IProduct, type ProductDocument } from "../models/Product";
import Order from "../models/Order";
import OrderItem from "../models/OrderItem";
import InventoryLot from "../models/InventoryLot";
import StockMovement, { type MovementType } from "../models/StockMovement";
import AppError from "./AppError";
import { notifyStockOut, notifyLowStock } from "./adminAlerts";
import { clampPreOrderDays, getPreorderConfig, isPreOrderEligible, type PreorderConfig } from "./preorder";
import { PRE_ORDER, type OrderStatus } from "../config/orderOptions";

type ProductRef = Types.ObjectId | string;

const roundMoney = (n: number): number => Math.round(n * 100) / 100;

// Compute "available" (what a customer may actually buy right now).
export const availableOf = (product: Pick<ProductDocument, "stock" | "reserved">): number =>
  Math.max(0, (product.stock || 0) - (product.reserved || 0));

// ---- Pre-order <-> regular sync ---------------------------------------------
//
// The backend is the single source of truth for whether a product sells as
// pre-order right now. Every path that changes `stock` or `reserved` calls
// syncPreOrderState afterwards, so the switch happens automatically:
//
//   available > 0                         → regular product (isPreOrder=false).
//                                           AUTO hands control back to the site rule
//                                           (source=null); MANUAL keeps its delivery days.
//   available = 0 + eligible              → pre-order (MANUAL stays MANUAL, else AUTO),
//                                           using the stored days or the site default.
//   available = 0 + not eligible          → Out of Stock (isPreOrder=false).
//
// "Available" is stock - reserved: units held by placed-but-undelivered orders are
// already sold, so the last unit being ordered is what flips a product to pre-order.
//
// Waiting pre-orders are served first: before deciding, any available stock is
// reserved for the product's unreserved pre-order lines, oldest order first (see
// allocateToWaitingPreOrders). Only what is left sells to new customers, and while
// any pre-order is still waiting the product stays in pre-order mode.

type PreOrderFields = Pick<IProduct, "stock" | "reserved" | "isPreOrder" | "preOrderSource" | "preOrderMinDays">;
type PreOrderUpdate = Partial<Pick<IProduct, "isPreOrder" | "preOrderSource" | "preOrderMinDays">>;

const PRE_ORDER_SYNC_FIELDS = "stock reserved isPreOrder preOrderSource preOrderMinDays";
const AVAILABLE_EXPR = { $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] };

// The state a product should be in, or null when it already is. `waitingPreOrders`
// is the quantity of earlier pre-orders still unserved: while it is > 0 new
// customers can't take the leftover units, so the product stays pre-order.
export const preOrderUpdateFor = (
  p: PreOrderFields,
  config: PreorderConfig,
  waitingPreOrders = 0
): PreOrderUpdate | null => {
  const source = p.preOrderSource ?? null;
  const days = p.preOrderMinDays || 0;
  const soldOut = availableOf(p) <= 0 || waitingPreOrders > 0;

  if (soldOut && isPreOrderEligible(source, config)) {
    const nextSource = source === "MANUAL" ? "MANUAL" : "AUTO";
    if (p.isPreOrder && source === nextSource && days >= PRE_ORDER.MIN_DELIVERY_DAYS) return null;
    return {
      isPreOrder: true,
      preOrderSource: nextSource,
      // Preserve the product's own window; fall back to the site default.
      preOrderMinDays: days >= PRE_ORDER.MIN_DELIVERY_DAYS ? days : clampPreOrderDays(config.defaultPreOrderDays),
    };
  }

  if (!p.isPreOrder && source !== "AUTO") return null;
  // AUTO (or a legacy pre-order with no source) returns to the site rule; its days
  // were the site default, so they are re-derived on the next stock-out.
  if (source === "AUTO" || source === null) return { isPreOrder: false, preOrderSource: null, preOrderMinDays: 0 };
  return { isPreOrder: false };
};

// Guarded write: only applies while stock and policy still match what the decision
// was based on. If another request changed them in between, that request runs its
// own sync after its write, so the final state is still right (no lost update).
const preOrderSyncOp = (
  p: PreOrderFields & { _id: Types.ObjectId },
  update: PreOrderUpdate
) => ({
  filter: {
    _id: p._id,
    isPreOrder: p.isPreOrder,
    preOrderSource: p.preOrderSource ?? null,
    $expr: availableOf(p) <= 0 ? { $lte: [AVAILABLE_EXPR, 0] } : { $gt: [AVAILABLE_EXPR, 0] },
  },
  update: { $set: update },
});

// ---- Serve waiting pre-orders first -----------------------------------------

// Orders whose pre-order lines still wait for (or hold) stock: not yet delivered,
// not cancelled, and not yet finalized.
const OPEN_ORDER_STATUSES: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "READY_TO_SHIP",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
];

interface PreOrderLine {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  quantity: number;
}

// A product's pre-order lines that have no stock yet, oldest order first. Starts
// from the (few, indexed) open pre-order orders, so delivered history never piles up here.
const waitingPreOrderLines = async (productId: ProductRef, session: ClientSession): Promise<PreOrderLine[]> => {
  const orders = await Order.find({ isPreOrder: true, orderStatus: { $in: OPEN_ORDER_STATUSES }, stockRestoredAt: null })
    .select("_id createdAt")
    .sort({ createdAt: 1, _id: 1 })
    .session(session)
    .lean();
  if (orders.length === 0) return [];
  const rank = new Map(orders.map((o, i) => [String(o._id), i]));
  const lines = await OrderItem.find({
    orderId: { $in: orders.map((o) => o._id) },
    productId,
    isPreOrder: true,
    stockReservedAt: null,
  })
    .select("_id orderId quantity")
    .session(session)
    .lean();
  return lines.sort(
    (a, b) => rank.get(String(a.orderId))! - rank.get(String(b.orderId))! || String(a._id).localeCompare(String(b._id))
  );
};

// Reserve stock for one pre-order line if enough is available. Atomic: the $expr
// filter only matches when the units are really there, so concurrent orders can
// never push reserved past stock. Returns false (and changes nothing) otherwise.
export const reservePreOrderLine = async (
  productId: ProductRef,
  line: PreOrderLine,
  session: ClientSession,
  createdBy: Types.ObjectId | null = null
): Promise<boolean> => {
  const claimed = await OrderItem.updateOne(
    { _id: line._id, stockReservedAt: null },
    { $set: { stockReservedAt: new Date() } },
    { session }
  );
  if (claimed.modifiedCount !== 1) return false;
  const result = await Product.findOneAndUpdate(
    { _id: productId, $expr: { $gte: [AVAILABLE_EXPR, line.quantity] } },
    { $inc: { reserved: line.quantity } },
    { session, returnDocument: "after", projection: { stock: 1 } }
  );
  if (!result) {
    await OrderItem.updateOne({ _id: line._id }, { $set: { stockReservedAt: null } }, { session });
    return false;
  }
  await recordMovement(
    {
      productId,
      type: "RESERVATION",
      quantity: line.quantity,
      previousStock: result.stock,
      newStock: result.stock,
      orderId: line.orderId,
      createdBy,
      reason: "Reserved for a waiting pre-order",
    },
    session
  );
  return true;
};

// Hand available stock to waiting pre-orders, strictly oldest first: when the next
// line doesn't fit, stop, so a later order never jumps the queue. Returns the
// quantity still waiting.
const allocateToWaitingPreOrders = async (productId: ProductRef, session: ClientSession): Promise<number> => {
  let waiting = 0;
  for (const line of await waitingPreOrderLines(productId, session)) {
    if (waiting === 0 && (await reservePreOrderLine(productId, line, session))) continue;
    waiting += line.quantity;
  }
  return waiting;
};

export const syncPreOrderState = async (
  productId: ProductRef,
  session?: ClientSession
): Promise<PreOrderUpdate | null> => {
  // Allocation writes several documents, so it always runs inside a transaction.
  if (!session) {
    const own = await mongoose.startSession();
    try {
      let out: PreOrderUpdate | null = null;
      await own.withTransaction(async () => {
        out = await syncPreOrderState(productId, own);
      });
      return out;
    } finally {
      await own.endSession();
    }
  }

  let product = await Product.findById(productId).select(PRE_ORDER_SYNC_FIELDS).session(session).lean();
  if (!product) return null;
  let waiting = 0;
  if (availableOf(product) > 0) {
    waiting = await allocateToWaitingPreOrders(product._id, session);
    product = await Product.findById(productId).select(PRE_ORDER_SYNC_FIELDS).session(session).lean();
    if (!product) return null;
  }
  const update = preOrderUpdateFor(product, await getPreorderConfig(), waiting);
  if (!update) return null;
  const op = preOrderSyncOp(product, update);
  const result = await Product.updateOne(op.filter, op.update, { session });
  return result.modifiedCount === 1 ? update : null;
};

// Kept so older imports keep compiling.
export const syncAutoPreOrderState = async (productId: ProductRef, session?: ClientSession): Promise<void> => {
  await syncPreOrderState(productId, session);
};

// Bring every product in line with its stock and policy. Runs on startup (fixes
// rows written before this sync existed) and after the site-wide pre-order setting
// changes. Only reads products that can possibly be out of sync.
export const reconcileAllPreOrderStates = async (): Promise<number> => {
  const config = await getPreorderConfig();
  const candidates = await Product.find({
    $or: [
      { isPreOrder: true },
      { preOrderSource: "AUTO" },
      { $expr: { $lte: [AVAILABLE_EXPR, 0] } },
    ],
  })
    .select(PRE_ORDER_SYNC_FIELDS)
    .lean();

  const ops = candidates.flatMap((p) => {
    const update = preOrderUpdateFor(p, config);
    return update ? [{ updateOne: preOrderSyncOp(p, update) }] : [];
  });
  let modified = ops.length ? (await Product.bulkWrite(ops, { ordered: false })).modifiedCount : 0;

  // Products with pre-orders still waiting for stock (including ones placed before
  // allocation existed): serve them from any available stock, then re-decide the mode.
  const openPreOrders = await Order.find({
    isPreOrder: true,
    orderStatus: { $in: OPEN_ORDER_STATUSES },
    stockRestoredAt: null,
  })
    .select("_id")
    .lean();
  if (openPreOrders.length > 0) {
    const productIds: Types.ObjectId[] = await OrderItem.distinct("productId", {
      orderId: { $in: openPreOrders.map((o) => o._id) },
      isPreOrder: true,
      stockReservedAt: null,
      productId: { $ne: null },
    });
    for (const productId of productIds) {
      if (await syncPreOrderState(productId)) modified++;
    }
  }
  return modified;
};

// Record an audit entry. All movement writes go through here so the stock-movement
// report is always a complete truth. Non-transactional callers may omit `session`.
export interface RecordMovementInput {
  productId: ProductRef;
  type: MovementType;
  quantity: number;
  previousStock: number;
  newStock: number;
  lotId?: Types.ObjectId | null;
  shipmentId?: Types.ObjectId | null;
  orderId?: Types.ObjectId | null;
  unitCost?: number;
  reason?: string;
  createdBy?: Types.ObjectId | null;
}

export const recordMovement = async (
  input: RecordMovementInput,
  session?: ClientSession
): Promise<void> => {
  await StockMovement.create(
    [
      {
        productId: input.productId,
        type: input.type,
        quantity: input.quantity,
        previousStock: input.previousStock,
        newStock: input.newStock,
        lotId: input.lotId ?? null,
        shipmentId: input.shipmentId ?? null,
        orderId: input.orderId ?? null,
        unitCost: input.unitCost ?? 0,
        reason: input.reason ?? "",
        createdBy: input.createdBy ?? null,
      },
    ],
    session ? { session } : undefined
  );
};

// ---- Reservation model ------------------------------------------------------
//
// The checkout flow calls reserveStock; nothing touches `stock` until the order
// is actually DELIVERED (finalizeSale). This mirrors the spec's three-step
// available = stock - reserved rule and makes overselling impossible under
// concurrent checkout, because the atomic $expr filter only matches when enough
// stock is left.

// Reserve `quantity` units of a product inside a transaction. Fails loudly when
// available stock is less than requested. Fires a low-stock email if the
// reservation pushes available at or below the configured threshold.
export const reserveStock = async (
  productId: ProductRef,
  quantity: number,
  session: ClientSession,
  context?: { orderId?: Types.ObjectId | null; createdBy?: Types.ObjectId | null }
): Promise<void> => {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError("Reserve quantity must be a positive whole number", 400);
  }
  const before = await Product.findById(productId).session(session).select("stock reserved").lean();
  const result = await Product.findOneAndUpdate(
    {
      _id: productId,
      status: "ACTIVE",
      $expr: { $gte: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, quantity] },
    },
    { $inc: { reserved: quantity } },
    { session, returnDocument: "after", projection: { stock: 1, reserved: 1, lowStockThreshold: 1, lastLowStockAlertAt: 1 } }
  );
  if (!result) throw new AppError("Insufficient product stock", 409);

  await recordMovement(
    {
      productId,
      type: "RESERVATION",
      quantity,
      previousStock: before?.stock ?? result.stock,
      newStock: result.stock,
      orderId: context?.orderId ?? null,
      createdBy: context?.createdBy ?? null,
    },
    session
  );

  // Low-stock alert fires after the commit (notifyLowStock uses setImmediate).
  const availableAfter = (result.stock || 0) - (result.reserved || 0);
  if (result.lowStockThreshold > 0 && availableAfter <= result.lowStockThreshold) {
    notifyLowStock(result._id);
  }
  if (availableAfter === 0 && result.stock > 0) {
    // Nothing available to buy right now even though we still own stock; alert admin.
    notifyStockOut(result._id);
  }
  // Last unit ordered → switch to pre-order (if allowed) in the same transaction, so
  // the next customer sees Pre-order instead of an In Stock product they can't buy.
  await syncPreOrderState(productId, session);
};

// Release a reservation (order cancelled before fulfilment). Idempotent at the
// callsite because order cancellation already uses `stockRestoredAt` to prevent
// a double release.
export const releaseReservation = async (
  productId: ProductRef,
  quantity: number,
  session: ClientSession,
  context?: { orderId?: Types.ObjectId | null; createdBy?: Types.ObjectId | null }
) => {
  if (!Number.isInteger(quantity) || quantity <= 0) return;
  const before = await Product.findById(productId).session(session).select("stock reserved").lean();
  const result = await Product.findOneAndUpdate(
    { _id: productId },
    { $inc: { reserved: -quantity }, $set: { lastStockOutAlertAt: null, lastLowStockAlertAt: null } },
    { session, returnDocument: "after", projection: { stock: 1, reserved: 1 } }
  );
  if (!result) return;
  // Reserved can never actually go negative (we only release what we reserved),
  // but if someone releases more than reserved by mistake, snap back to 0 so the
  // rest of the system never sees a negative value.
  if (result.reserved < 0) {
    await Product.updateOne({ _id: productId }, { $set: { reserved: 0 } }, { session });
  }
  await recordMovement(
    {
      productId,
      type: "RELEASE",
      quantity,
      previousStock: before?.stock ?? result.stock,
      newStock: result.stock,
      orderId: context?.orderId ?? null,
      createdBy: context?.createdBy ?? null,
    },
    session
  );
  // A cancelled order frees units → back to a regular in-stock product.
  await syncPreOrderState(productId, session);
};

// ---- FIFO consumption -------------------------------------------------------

export interface ConsumedLot {
  lotId: Types.ObjectId;
  shipmentId: Types.ObjectId;
  supplierId: Types.ObjectId;
  quantity: number;
  landedUnitCost: number;
  cost: number;
}

export interface FinalizeSaleResult {
  consumed: ConsumedLot[];
  cogs: number;
  revenue: number;
}

// Deduct `quantity` units from the oldest ACTIVE lots (FIFO) and set that lot
// DEPLETED when its remaining count hits zero. Returns per-lot breakdown so the
// caller can log a SALE movement per lot.
const consumeLots = async (
  productId: ProductRef,
  quantity: number,
  session: ClientSession,
  fallbackUnitCost: number
): Promise<ConsumedLot[]> => {
  let remaining = quantity;
  const consumed: ConsumedLot[] = [];
  while (remaining > 0) {
    const lot = await InventoryLot.findOne({
      productId,
      status: "ACTIVE",
      remainingQuantity: { $gt: 0 },
    })
      .sort({ receivedDate: 1, _id: 1 })
      .session(session);
    if (!lot) {
      // No more lots — fall back to the product's own cost for the leftover.
      consumed.push({
        lotId: null as unknown as Types.ObjectId,
        shipmentId: null as unknown as Types.ObjectId,
        supplierId: null as unknown as Types.ObjectId,
        quantity: remaining,
        landedUnitCost: fallbackUnitCost,
        cost: roundMoney(fallbackUnitCost * remaining),
      });
      remaining = 0;
      break;
    }
    const take = Math.min(remaining, lot.remainingQuantity);
    const newRemaining = lot.remainingQuantity - take;
    await InventoryLot.updateOne(
      { _id: lot._id },
      {
        $set: {
          remainingQuantity: newRemaining,
          ...(newRemaining === 0 ? { status: "DEPLETED" as const } : {}),
        },
      },
      { session }
    );
    consumed.push({
      lotId: lot._id,
      shipmentId: lot.shipmentId,
      supplierId: lot.supplierId,
      quantity: take,
      landedUnitCost: lot.landedUnitCost,
      cost: roundMoney(lot.landedUnitCost * take),
    });
    remaining -= take;
  }
  return consumed;
};

// Finalize a sale for one product line of a DELIVERED order. Consumes FIFO lots,
// decrements stock, releases the reservation, increments sold totals, and records
// one SALE movement per lot consumed. Returns the aggregated COGS.
export const finalizeSale = async (
  productId: ProductRef,
  quantity: number,
  revenue: number,
  session: ClientSession,
  context: { orderId?: Types.ObjectId | null; createdBy?: Types.ObjectId | null } = {}
): Promise<FinalizeSaleResult> => {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { consumed: [], cogs: 0, revenue: 0 };
  }
  const product = await Product.findById(productId).session(session).select("stock reserved productCost").lean();
  if (!product) throw new AppError("Product not found", 404);
  const fallbackCost = product.productCost || 0;

  const consumed = await consumeLots(productId, quantity, session, fallbackCost);
  const cogs = roundMoney(consumed.reduce((sum, c) => sum + c.cost, 0));

  // Decrement both stock and reserved by the same qty. Guarded by $gte to avoid
  // negative values on any corrupted state.
  const updated = await Product.findOneAndUpdate(
    { _id: productId, stock: { $gte: quantity } },
    {
      $inc: {
        stock: -quantity,
        reserved: -quantity,
        soldQuantity: quantity,
        soldRevenue: roundMoney(revenue),
      },
    },
    { session, returnDocument: "after", projection: { stock: 1, reserved: 1, lowStockThreshold: 1 } }
  );
  if (!updated) throw new AppError("Insufficient stock to finalize sale", 409);
  if (updated.reserved < 0) {
    await Product.updateOne({ _id: productId }, { $set: { reserved: 0 } }, { session });
  }

  for (const line of consumed) {
    await recordMovement(
      {
        productId,
        type: "SALE",
        quantity: line.quantity,
        previousStock: (product.stock || 0),
        newStock: updated.stock,
        lotId: line.lotId,
        shipmentId: line.shipmentId,
        unitCost: line.landedUnitCost,
        orderId: context.orderId ?? null,
        createdBy: context.createdBy ?? null,
      },
      session
    );
  }

  if (updated.stock === 0) notifyStockOut(updated._id);
  await syncPreOrderState(productId, session);

  return { consumed, cogs, revenue: roundMoney(revenue) };
};

// Record a sellable return: stock goes back up; soldQuantity does NOT change
// (gross sold stays as reported revenue), but returnedQuantity bumps.
export const returnToStock = async (
  productId: ProductRef,
  quantity: number,
  session: ClientSession,
  context: { orderId?: Types.ObjectId | null; createdBy?: Types.ObjectId | null; reason?: string } = {}
) => {
  if (!Number.isInteger(quantity) || quantity <= 0) return;
  const before = await Product.findById(productId).session(session).select("stock").lean();
  const updated = await Product.findOneAndUpdate(
    { _id: productId },
    {
      $inc: { stock: quantity, returnedQuantity: quantity },
      $set: { lastStockOutAlertAt: null, lastLowStockAlertAt: null },
    },
    { session, returnDocument: "after", projection: { stock: 1 } }
  );
  if (!updated) return;
  await recordMovement(
    {
      productId,
      type: "RETURN",
      quantity,
      previousStock: before?.stock ?? updated.stock - quantity,
      newStock: updated.stock,
      orderId: context.orderId ?? null,
      createdBy: context.createdBy ?? null,
      reason: context.reason ?? "",
    },
    session
  );
  await syncPreOrderState(productId, session);
};

// Record a damaged return (no restock): damagedQuantity++ and returnedQuantity++.
// Stock is NOT increased — the units stay out of circulation.
export const returnDamaged = async (
  productId: ProductRef,
  quantity: number,
  session: ClientSession,
  context: { orderId?: Types.ObjectId | null; createdBy?: Types.ObjectId | null; reason?: string } = {}
) => {
  if (!Number.isInteger(quantity) || quantity <= 0) return;
  const before = await Product.findById(productId).session(session).select("stock").lean();
  const updated = await Product.findOneAndUpdate(
    { _id: productId },
    { $inc: { damagedQuantity: quantity, returnedQuantity: quantity } },
    { session, returnDocument: "after", projection: { stock: 1 } }
  );
  if (!updated) return;
  await recordMovement(
    {
      productId,
      type: "DAMAGE",
      quantity,
      previousStock: before?.stock ?? updated.stock,
      newStock: updated.stock,
      orderId: context.orderId ?? null,
      createdBy: context.createdBy ?? null,
      reason: context.reason ?? "Damaged return",
    },
    session
  );
};

// ---- Back-compat helpers (older callsites) ---------------------------------
//
// `decrementStock` and `restoreStock` are kept as thin wrappers around the
// reservation model so existing imports keep compiling. New code should call
// `reserveStock`/`releaseReservation`/`finalizeSale` directly.

export const decrementStock = async (
  productId: ProductRef,
  quantity: number,
  session: ClientSession
): Promise<void> => reserveStock(productId, quantity, session);

export const restoreStock = async (
  productId: ProductRef,
  quantity: number,
  session: ClientSession
): Promise<void> => releaseReservation(productId, quantity, session);

// Sum quantities per product (the same product can be in the cart in several sizes)
export const quantitiesByProduct = (lines: { productId: ProductRef; quantity: number }[]): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const id = String(line.productId);
    totals.set(id, (totals.get(id) || 0) + line.quantity);
  }
  return totals;
};
