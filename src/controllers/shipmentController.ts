import mongoose, { type Types } from "mongoose";
import type { Request, Response } from "express";
import Shipment, { SHIPMENT_STATUSES, isShipmentStatus, type IShipmentItem, type ShipmentDocument } from "../models/Shipment";
import Supplier from "../models/Supplier";
import Product from "../models/Product";
import InventoryLot from "../models/InventoryLot";
import { nextSequence } from "../models/Counter";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import { recordMovement } from "../utils/inventory";
import { assertObjectId, escapeRegex, getPagination, queryString } from "../utils/validators";
import { getAuthUser } from "../middleware/auth";

type Body = Record<string, unknown>;

const SHIPMENT_PREFIX = "SHIP-";
const SHIPMENT_START = 1000;
const roundMoney = (n: number): number => Math.round(n * 100) / 100;

const toNumber = (value: unknown, label: string, { min = 0, integer = false }: { min?: number; integer?: boolean } = {}) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min) {
    throw new AppError(`${label} must be a number of at least ${min}`, 400);
  }
  if (integer && !Number.isInteger(n)) throw new AppError(`${label} must be a whole number`, 400);
  return n;
};

const toDate = (value: unknown, label: string, { required = false }: { required?: boolean } = {}): Date | null => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new AppError(`${label} is required`, 400);
    return null;
  }
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new AppError(`${label} must be a valid date`, 400);
  return date;
};

interface ShipmentItemInput {
  productId: string;
  purchaseQuantity: number;
  receivedQuantity?: number;
  unitCost: number;
  sellingPrice?: number;
  notes?: string;
}

const parseShipmentItemInput = (raw: unknown, index: number): ShipmentItemInput => {
  if (!raw || typeof raw !== "object") throw new AppError(`items[${index}] must be an object`, 400);
  const r = raw as Body;
  assertObjectId(r.productId, `items[${index}].productId`);
  return {
    productId: String(r.productId),
    purchaseQuantity: toNumber(r.purchaseQuantity, `items[${index}].purchaseQuantity`, { min: 1, integer: true }),
    receivedQuantity:
      r.receivedQuantity !== undefined
        ? toNumber(r.receivedQuantity, `items[${index}].receivedQuantity`, { min: 0, integer: true })
        : undefined,
    unitCost: toNumber(r.unitCost, `items[${index}].unitCost`, { min: 0 }),
    sellingPrice:
      r.sellingPrice !== undefined ? toNumber(r.sellingPrice, `items[${index}].sellingPrice`, { min: 0 }) : undefined,
    notes: r.notes !== undefined ? String(r.notes).trim().slice(0, 500) : undefined,
  };
};

const parseItemsArray = (value: unknown): ShipmentItemInput[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError("items must be a non-empty array", 400);
  }
  return value.map((raw, i) => parseShipmentItemInput(raw, i));
};

// Recalculate subtotal + totalCost + landed-unit-costs from items + extras.
// Extras are allocated proportionally to item line value (purchaseQuantity * unitCost).
const recomputeTotals = (shipment: ShipmentDocument): void => {
  const subtotal = shipment.items.reduce((sum, i) => sum + i.unitCost * i.purchaseQuantity, 0);
  shipment.subtotal = roundMoney(subtotal);
  const extras = (shipment.shippingCost || 0) + (shipment.customsCost || 0) + (shipment.tax || 0) + (shipment.otherCost || 0);
  shipment.totalCost = roundMoney(subtotal + extras);

  const totalWeight = subtotal; // guard against div-by-zero below
  for (const item of shipment.items) {
    const lineValue = item.unitCost * item.purchaseQuantity;
    const share = totalWeight > 0 ? (lineValue / totalWeight) * extras : 0;
    const perUnit = item.purchaseQuantity > 0 ? share / item.purchaseQuantity : 0;
    item.landedUnitCost = roundMoney(item.unitCost + perUnit);
  }
};

const toShipmentResponse = (shipment: ShipmentDocument) => ({
  ...shipment.toObject(),
  totalProducts: shipment.items.length,
  totalQuantity: shipment.items.reduce((sum, i) => sum + i.purchaseQuantity, 0),
  totalReceived: shipment.items.reduce((sum, i) => sum + i.receivedQuantity, 0),
});

// @desc    List shipments (filters, search, pagination)
// @route   GET /api/admin/inventory/shipments
// @access  shipments.view
export const listShipments = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const status = queryString(req.query.status);
  const supplierId = queryString(req.query.supplierId);
  const productId = queryString(req.query.productId);
  const fromDate = queryString(req.query.fromDate);
  const toDateRaw = queryString(req.query.toDate);

  const filter: Record<string, unknown> = {};
  if (status) {
    if (!isShipmentStatus(status)) {
      throw new AppError(`status must be one of ${SHIPMENT_STATUSES.join(", ")}`, 400);
    }
    filter.status = status;
  }
  if (supplierId) {
    assertObjectId(supplierId, "supplierId");
    filter.supplierId = supplierId;
  }
  if (productId) {
    assertObjectId(productId, "productId");
    filter["items.productId"] = productId;
  }
  if (fromDate || toDateRaw) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (fromDate) {
      const d = toDate(fromDate, "fromDate", { required: true });
      if (d) range.$gte = d;
    }
    if (toDateRaw) {
      const d = toDate(toDateRaw, "toDate", { required: true });
      if (d) range.$lte = d;
    }
    filter.shipmentDate = range;
  }
  if (search && search.trim()) {
    filter.shipmentNumber = new RegExp(escapeRegex(search.trim()), "i");
  }

  const [shipments, total] = await Promise.all([
    Shipment.find(filter)
      .populate("supplierId", "name status")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Shipment.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Shipments fetched successfully",
    data: {
      shipments: shipments.map(toShipmentResponse),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
};

// @desc    One shipment by ID (populates supplier + lots created from it)
// @route   GET /api/admin/inventory/shipments/:id
// @access  shipments.view
export const getShipment = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const shipment = await Shipment.findById(req.params.id).populate("supplierId", "name status email phone");
  if (!shipment) throw new AppError("Shipment not found", 404);
  const lots = await InventoryLot.find({ shipmentId: shipment._id }).sort({ receivedDate: 1 }).lean();
  res.status(200).json({
    success: true,
    message: "Shipment fetched successfully",
    data: { ...toShipmentResponse(shipment), lots },
  });
};

// @desc    Create a shipment (PENDING by default; nothing is in stock yet).
//          Receiving the shipment creates lots and bumps product stock.
// @route   POST /api/admin/inventory/shipments
// @access  shipments.create
export const createShipment = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const supplierId = body.supplierId;
  assertObjectId(supplierId, "supplierId");
  const supplier = await Supplier.findById(supplierId);
  if (!supplier) throw new AppError("Supplier not found", 404);
  if (supplier.status !== "ACTIVE") throw new AppError("Supplier is inactive", 400);

  const shipmentDate = toDate(body.shipmentDate, "shipmentDate") ?? new Date();
  const expectedDate = toDate(body.expectedDate, "expectedDate");
  const items = parseItemsArray(body.items);

  const productIds = items.map((i) => new mongoose.Types.ObjectId(i.productId));
  const products = await Product.find({ _id: { $in: productIds } }).select("productTitle sku").lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  if (products.length !== new Set(productIds.map(String)).size) {
    throw new AppError("One or more products were not found", 404);
  }

  const seq = await nextSequence("shipment", SHIPMENT_START);
  const shipmentNumber = `${SHIPMENT_PREFIX}${seq}`;

  const shipment = new Shipment({
    shipmentNumber,
    supplierId: supplier._id,
    shipmentDate,
    expectedDate,
    status: "PENDING",
    items: items.map<IShipmentItem>((i) => {
      const product = byId.get(i.productId)!;
      return {
        productId: new mongoose.Types.ObjectId(i.productId),
        productTitleSnapshot: product.productTitle,
        skuSnapshot: product.sku || "",
        purchaseQuantity: i.purchaseQuantity,
        receivedQuantity: 0,
        unitCost: i.unitCost,
        landedUnitCost: 0,
        sellingPrice: i.sellingPrice ?? 0,
        notes: i.notes || "",
      };
    }),
    shippingCost: body.shippingCost !== undefined ? toNumber(body.shippingCost, "shippingCost") : 0,
    customsCost: body.customsCost !== undefined ? toNumber(body.customsCost, "customsCost") : 0,
    tax: body.tax !== undefined ? toNumber(body.tax, "tax") : 0,
    otherCost: body.otherCost !== undefined ? toNumber(body.otherCost, "otherCost") : 0,
    notes: body.notes !== undefined ? String(body.notes).trim().slice(0, 1000) : "",
    createdBy: getAuthUser(req)._id,
  });
  recomputeTotals(shipment);
  await shipment.save();

  await logActivity(req, {
    action: "SHIPMENT_CREATED",
    newValue: { shipmentId: shipment._id, shipmentNumber, totalCost: shipment.totalCost },
  });

  res.status(201).json({
    success: true,
    message: "Shipment created successfully",
    data: toShipmentResponse(shipment),
  });
};

// @desc    Update a shipment (only before it's RECEIVED/CANCELLED; items + extras + supplier editable).
// @route   PUT /api/admin/inventory/shipments/:id
// @access  shipments.update
export const updateShipment = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const shipment = await Shipment.findById(req.params.id);
  if (!shipment) throw new AppError("Shipment not found", 404);
  if (shipment.status === "RECEIVED" || shipment.status === "CANCELLED") {
    throw new AppError(`Shipment is ${shipment.status} and can no longer be edited`, 400);
  }
  const body = (req.body || {}) as Body;
  const before = {
    shipmentDate: shipment.shipmentDate,
    expectedDate: shipment.expectedDate,
    status: shipment.status,
    subtotal: shipment.subtotal,
    totalCost: shipment.totalCost,
  };

  if (body.supplierId !== undefined) {
    assertObjectId(body.supplierId, "supplierId");
    const supplier = await Supplier.findById(body.supplierId);
    if (!supplier) throw new AppError("Supplier not found", 404);
    if (supplier.status !== "ACTIVE") throw new AppError("Supplier is inactive", 400);
    shipment.supplierId = supplier._id;
  }
  if (body.shipmentDate !== undefined) {
    const d = toDate(body.shipmentDate, "shipmentDate", { required: true });
    if (d) shipment.shipmentDate = d;
  }
  if (body.expectedDate !== undefined) {
    shipment.expectedDate = toDate(body.expectedDate, "expectedDate");
  }
  if (body.status !== undefined) {
    if (!isShipmentStatus(body.status)) {
      throw new AppError(`status must be one of ${SHIPMENT_STATUSES.join(", ")}`, 400);
    }
    if (body.status === "RECEIVED") throw new AppError("Use the receive endpoint to receive a shipment", 400);
    shipment.status = body.status;
  }
  if (body.items !== undefined) {
    const items = parseItemsArray(body.items);
    const productIds = items.map((i) => new mongoose.Types.ObjectId(i.productId));
    const products = await Product.find({ _id: { $in: productIds } }).select("productTitle sku").lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    if (products.length !== new Set(productIds.map(String)).size) {
      throw new AppError("One or more products were not found", 404);
    }
    shipment.items = items.map<IShipmentItem>((i) => {
      const product = byId.get(i.productId)!;
      return {
        productId: new mongoose.Types.ObjectId(i.productId),
        productTitleSnapshot: product.productTitle,
        skuSnapshot: product.sku || "",
        purchaseQuantity: i.purchaseQuantity,
        receivedQuantity: 0,
        unitCost: i.unitCost,
        landedUnitCost: 0,
        sellingPrice: i.sellingPrice ?? 0,
        notes: i.notes || "",
      };
    });
  }
  if (body.shippingCost !== undefined) shipment.shippingCost = toNumber(body.shippingCost, "shippingCost");
  if (body.customsCost !== undefined) shipment.customsCost = toNumber(body.customsCost, "customsCost");
  if (body.tax !== undefined) shipment.tax = toNumber(body.tax, "tax");
  if (body.otherCost !== undefined) shipment.otherCost = toNumber(body.otherCost, "otherCost");
  if (body.notes !== undefined) shipment.notes = String(body.notes).trim().slice(0, 1000);

  recomputeTotals(shipment);
  await shipment.save();

  await logActivity(req, {
    action: "SHIPMENT_UPDATED",
    oldValue: { shipmentId: shipment._id, ...before },
    newValue: {
      shipmentId: shipment._id,
      shipmentDate: shipment.shipmentDate,
      expectedDate: shipment.expectedDate,
      status: shipment.status,
      subtotal: shipment.subtotal,
      totalCost: shipment.totalCost,
    },
  });

  res.status(200).json({ success: true, message: "Shipment updated successfully", data: toShipmentResponse(shipment) });
};

// @desc    Mark a shipment received (or partially received). Creates one InventoryLot
//          per item with a received quantity > 0, bumps product stock, writes a PURCHASE
//          movement, and sets the shipment status to RECEIVED (or PARTIALLY_RECEIVED).
//
//          Body: { receivedDate?, items: [{ itemId, receivedQuantity }] }
//          Passing no items array marks all items fully received.
// @route   POST /api/admin/inventory/shipments/:id/receive
// @access  shipments.receive
export const receiveShipment = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const shipment = await Shipment.findById(req.params.id);
  if (!shipment) throw new AppError("Shipment not found", 404);
  if (shipment.status === "CANCELLED") throw new AppError("Cancelled shipments cannot be received", 400);
  if (shipment.status === "RECEIVED") throw new AppError("Shipment is already fully received", 400);

  const body = (req.body || {}) as Body;
  const receivedDate = toDate(body.receivedDate, "receivedDate") ?? new Date();

  // Build a map of itemId -> receivedQuantity delta (how many we are receiving NOW).
  const deltas = new Map<string, number>();
  if (body.items === undefined || body.items === null) {
    // Fully receive remaining qty for every item
    for (const item of shipment.items) {
      const remaining = item.purchaseQuantity - item.receivedQuantity;
      if (remaining > 0) deltas.set(String(item._id), remaining);
    }
  } else {
    if (!Array.isArray(body.items)) throw new AppError("items must be an array", 400);
    for (let i = 0; i < body.items.length; i++) {
      const raw = body.items[i] as Body;
      if (!raw.itemId) throw new AppError(`items[${i}].itemId is required`, 400);
      assertObjectId(raw.itemId, `items[${i}].itemId`);
      const qty = toNumber(raw.receivedQuantity, `items[${i}].receivedQuantity`, { min: 0, integer: true });
      if (qty > 0) deltas.set(String(raw.itemId), qty);
    }
  }
  if (deltas.size === 0) throw new AppError("Nothing to receive", 400);

  // Validate every delta against remaining
  for (const [itemId, qty] of deltas) {
    const item = shipment.items.find((i) => String(i._id) === itemId);
    if (!item) throw new AppError(`Shipment item ${itemId} not found`, 404);
    const remaining = item.purchaseQuantity - item.receivedQuantity;
    if (qty > remaining) {
      throw new AppError(`Cannot receive more than remaining for item ${item.productTitleSnapshot}`, 400);
    }
  }

  // Make sure landed cost is up to date before we snapshot it onto the lot.
  recomputeTotals(shipment);

  const session = await mongoose.startSession();
  const createdLotIds: Types.ObjectId[] = [];
  try {
    await session.withTransaction(async () => {
      for (const [itemId, qty] of deltas) {
        const item = shipment.items.find((i) => String(i._id) === itemId)!;
        // One lot per receive-event per item (so partial receipts become separate lots)
        const lotSeq = await nextSequence(`lot:${shipment.shipmentNumber}:${itemId}`, 1, session);
        const [lot] = await InventoryLot.create(
          [
            {
              productId: item.productId,
              shipmentId: shipment._id,
              supplierId: shipment.supplierId,
              lotNumber: `${shipment.shipmentNumber}-${item._id}-${lotSeq}`,
              receivedQuantity: qty,
              remainingQuantity: qty,
              unitCost: item.unitCost,
              landedUnitCost: item.landedUnitCost,
              sellingPrice: item.sellingPrice,
              receivedDate,
              status: "ACTIVE",
            },
          ],
          { session }
        );
        createdLotIds.push(lot._id);

        // Bump product stock, clear low-stock/out-of-stock dedup flags, and
        // record a PURCHASE movement.
        const before = await Product.findById(item.productId).session(session).select("stock").lean();
        const updated = await Product.findOneAndUpdate(
          { _id: item.productId },
          {
            $inc: { stock: qty },
            $set: {
              productCost: item.landedUnitCost,
              lastStockOutAlertAt: null,
              lastLowStockAlertAt: null,
            },
          },
          { session, returnDocument: "after", projection: { stock: 1 } }
        );
        if (!updated) throw new AppError("Product not found while receiving", 404);
        await recordMovement(
          {
            productId: item.productId,
            type: "PURCHASE",
            quantity: qty,
            previousStock: before?.stock ?? Math.max(0, updated.stock - qty),
            newStock: updated.stock,
            lotId: lot._id,
            shipmentId: shipment._id,
            unitCost: item.landedUnitCost,
            createdBy: getAuthUser(req)._id,
            reason: `Received shipment ${shipment.shipmentNumber}`,
          },
          session
        );

        item.receivedQuantity += qty;
      }

      shipment.receivedDate = receivedDate;
      const fullyReceived = shipment.items.every((i) => i.receivedQuantity >= i.purchaseQuantity);
      shipment.status = fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED";
      await shipment.save({ session });
    });
  } finally {
    await session.endSession();
  }

  await logActivity(req, {
    action: "SHIPMENT_RECEIVED",
    newValue: {
      shipmentId: shipment._id,
      shipmentNumber: shipment.shipmentNumber,
      lotIds: createdLotIds,
      status: shipment.status,
    },
  });

  const finalStatus: string = shipment.status;
  res.status(200).json({
    success: true,
    message: `Shipment ${finalStatus === "RECEIVED" ? "fully" : "partially"} received`,
    data: toShipmentResponse(shipment),
  });
};

// @desc    Delete/cancel a shipment. Fully-received shipments are soft-cancelled
//          only when every lot still has its full receivedQuantity remaining (no
//          sales yet); otherwise the shipment is kept and status is forced to
//          CANCELLED only when nothing was received yet.
// @route   DELETE /api/admin/inventory/shipments/:id
// @access  shipments.delete
export const deleteShipment = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const shipment = await Shipment.findById(req.params.id);
  if (!shipment) throw new AppError("Shipment not found", 404);

  const lots = await InventoryLot.find({ shipmentId: shipment._id });
  const hasSales = lots.some((l) => l.remainingQuantity < l.receivedQuantity);

  if (hasSales) {
    throw new AppError(
      "This shipment has units already sold and cannot be deleted. Only cancellable shipments without sales may be deleted.",
      400
    );
  }

  // Reservations may still depend on stock added by this shipment. Voiding it
  // would push the affected product below reserved and oversell on finalize.
  // Reject the delete so the admin can first cancel the pending orders.
  const perProduct = new Map<string, number>();
  for (const lot of lots) {
    const key = String(lot.productId);
    perProduct.set(key, (perProduct.get(key) || 0) + lot.remainingQuantity);
  }
  if (perProduct.size > 0) {
    const affectedProducts = await Product.find({ _id: { $in: [...perProduct.keys()] } })
      .select("productTitle stock reserved")
      .lean();
    for (const product of affectedProducts) {
      const toRemove = perProduct.get(String(product._id)) || 0;
      const stockAfter = (product.stock || 0) - toRemove;
      if (stockAfter < (product.reserved || 0)) {
        throw new AppError(
          `Cannot delete: "${product.productTitle}" has ${product.reserved} unit(s) reserved by pending orders. Cancel those orders first.`,
          409
        );
      }
    }
  }

  // If anything was received, reverse the stock bump and void the lots.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const lot of lots) {
        if (lot.receivedQuantity <= 0) continue;
        const before = await Product.findById(lot.productId).session(session).select("stock").lean();
        const updated = await Product.findOneAndUpdate(
          { _id: lot.productId, stock: { $gte: lot.remainingQuantity } },
          { $inc: { stock: -lot.remainingQuantity } },
          { session, returnDocument: "after", projection: { stock: 1 } }
        );
        if (!updated) throw new AppError("Cannot delete: product stock has already been consumed", 409);
        await recordMovement(
          {
            productId: lot.productId,
            type: "ADJUSTMENT_OUT",
            quantity: lot.remainingQuantity,
            previousStock: before?.stock ?? updated.stock + lot.remainingQuantity,
            newStock: updated.stock,
            lotId: lot._id,
            shipmentId: shipment._id,
            reason: `Shipment ${shipment.shipmentNumber} deleted`,
            createdBy: getAuthUser(req)._id,
          },
          session
        );
      }
      await InventoryLot.updateMany(
        { shipmentId: shipment._id },
        { $set: { status: "VOID", remainingQuantity: 0 } },
        { session }
      );
      shipment.status = "CANCELLED";
      await shipment.save({ session });
    });
  } finally {
    await session.endSession();
  }

  await logActivity(req, {
    action: "SHIPMENT_DELETED",
    oldValue: { shipmentId: shipment._id, shipmentNumber: shipment.shipmentNumber },
    newValue: { status: shipment.status },
  });

  res.status(200).json({
    success: true,
    message: "Shipment cancelled and all unsold lots voided",
    data: { _id: shipment._id, shipmentNumber: shipment.shipmentNumber, status: shipment.status },
  });
};
