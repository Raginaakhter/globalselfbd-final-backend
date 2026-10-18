import type { ClientSession, Types } from "mongoose";
import Product, { type ProductDocument } from "../models/Product";
import InventoryLot from "../models/InventoryLot";
import StockMovement, { type MovementType } from "../models/StockMovement";
import AppError from "./AppError";
import { notifyStockOut, notifyLowStock } from "./adminAlerts";
import { getPreorderConfig } from "./preorder";
import { PRE_ORDER } from "../config/orderOptions";

type ProductRef = Types.ObjectId | string;

const roundMoney = (n: number): number => Math.round(n * 100) / 100;

// Compute "available" (what a customer may actually buy right now).
export const availableOf = (product: Pick<ProductDocument, "stock" | "reserved">): number =>
  Math.max(0, (product.stock || 0) - (product.reserved || 0));

// Keep isPreOrder in sync with stock when the site has auto-pre-order enabled.
// Called from every stock-mutating path so the admin never has to flip pre-order
// manually on a stock-out. Idempotent: if the product is already in the desired
// state (or admin-managed), it does nothing.
//
//   stock == 0 + autoEnable + not currently pre-order  → enable (source=AUTO)
//   stock >  0 + currently pre-order with source=AUTO  → disable (clear source)
//   source == MANUAL                                   → never touched
export const syncAutoPreOrderState = async (
  productId: ProductRef,
  session?: ClientSession
): Promise<void> => {
  const product = await Product.findById(productId)
    .select("stock isPreOrder preOrderSource preOrderMinDays")
    .session(session ?? null);
  if (!product) return;

  if (product.preOrderSource === "MANUAL") return;

  const config = await getPreorderConfig();
  const outOfStock = (product.stock || 0) <= 0;

  if (outOfStock && !product.isPreOrder && config.autoEnableOnStockOut) {
    product.isPreOrder = true;
    product.preOrderSource = "AUTO";
    const days = Math.max(config.defaultPreOrderDays, PRE_ORDER.MIN_DELIVERY_DAYS);
    product.preOrderMinDays = Math.min(days, PRE_ORDER.MAX_DELIVERY_DAYS);
    await product.save({ session, validateBeforeSave: false });
    return;
  }

  if (!outOfStock && product.isPreOrder && product.preOrderSource === "AUTO") {
    product.isPreOrder = false;
    product.preOrderSource = null;
    product.preOrderMinDays = 0;
    await product.save({ session, validateBeforeSave: false });
  }
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
  await syncAutoPreOrderState(productId, session);

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
  await syncAutoPreOrderState(productId, session);
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
