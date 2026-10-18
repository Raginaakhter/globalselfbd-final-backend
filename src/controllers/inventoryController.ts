import mongoose from "mongoose";
import type { Request, Response } from "express";
import Product from "../models/Product";
import InventoryLot from "../models/InventoryLot";
import StockMovement, { MOVEMENT_TYPES, type MovementType } from "../models/StockMovement";
import StockRequest, { STOCK_REQUEST_STATUSES, isStockRequestStatus } from "../models/StockRequest";
import Shipment from "../models/Shipment";
import Supplier from "../models/Supplier";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import {
  availableOf,
  recordMovement,
  returnToStock,
  returnDamaged,
  syncAutoPreOrderState,
} from "../utils/inventory";
import { notifyLowStock, notifyStockOut, notifyStockRequest } from "../utils/adminAlerts";
import { assertObjectId, escapeRegex, getPagination, queryString } from "../utils/validators";
import { getAuthUser } from "../middleware/auth";
import { getVisibleCategoryIds, getCategoryWithDescendants } from "../utils/categoryTree";

type Body = Record<string, unknown>;

const roundMoney = (n: number): number => Math.round(n * 100) / 100;

const toInteger = (value: unknown, label: string, { min = 0 }: { min?: number } = {}): number => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new AppError(`${label} must be a whole number of at least ${min}`, 400);
  }
  return n;
};

const toSignedInteger = (value: unknown, label: string): number => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AppError(`${label} must be a whole number`, 400);
  }
  return n;
};

const stockStatusOf = (available: number, threshold: number): "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" => {
  if (available <= 0) return "OUT_OF_STOCK";
  if (threshold > 0 && available <= threshold) return "LOW_STOCK";
  return "IN_STOCK";
};

// Shape a product row for the inventory table (includes everything the admin
// needs: stock, reserved, available, sold totals, cost, revenue, profit, margin).
interface InventoryRow {
  productTitle?: string;
  sku?: string;
  categoryId?: unknown;
  stock?: number;
  reserved?: number;
  soldQuantity?: number;
  soldRevenue?: number;
  returnedQuantity?: number;
  damagedQuantity?: number;
  productCost?: number;
  customerSellPrice?: number;
  customerSpecialPrice?: number | null;
  lowStockThreshold?: number;
  status?: string;
  isPreOrder?: boolean;
  slug?: string;
  thumbnail?: string;
  _id?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}

const toInventoryRow = (p: InventoryRow, cogs: number) => {
  const stock = p.stock ?? 0;
  const reserved = p.reserved ?? 0;
  const available = Math.max(0, stock - reserved);
  const sold = p.soldQuantity ?? 0;
  const revenue = roundMoney(p.soldRevenue ?? 0);
  const profit = roundMoney(revenue - cogs);
  const margin = revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : 0;
  return {
    _id: p._id,
    productTitle: p.productTitle,
    slug: p.slug,
    sku: p.sku || "",
    thumbnail: p.thumbnail,
    categoryId: p.categoryId,
    stock,
    reserved,
    available,
    soldQuantity: sold,
    soldRevenue: revenue,
    returnedQuantity: p.returnedQuantity ?? 0,
    damagedQuantity: p.damagedQuantity ?? 0,
    productCost: p.productCost ?? 0,
    customerSellPrice: p.customerSellPrice ?? 0,
    customerSpecialPrice: p.customerSpecialPrice ?? null,
    lowStockThreshold: p.lowStockThreshold ?? 0,
    stockStatus: stockStatusOf(available, p.lowStockThreshold ?? 0),
    isPreOrder: !!p.isPreOrder,
    cogs,
    profit,
    margin,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
};

// FIFO-COGS for a product = sum over lots of (receivedQuantity - remainingQuantity) * landedUnitCost.
// Returned per product id as a Map for fast join into table rows.
const cogsByProductIds = async (productIds: mongoose.Types.ObjectId[]): Promise<Map<string, number>> => {
  if (productIds.length === 0) return new Map();
  const rows = await InventoryLot.aggregate([
    { $match: { productId: { $in: productIds } } },
    {
      $group: {
        _id: "$productId",
        cogs: {
          $sum: {
            $multiply: [{ $subtract: ["$receivedQuantity", "$remainingQuantity"] }, "$landedUnitCost"],
          },
        },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), roundMoney(r.cogs || 0)]));
};

// @desc    Inventory dashboard cards (totals across all products)
// @route   GET /api/admin/inventory/summary
// @access  inventory.view
export const getInventorySummary = async (req: Request, res: Response) => {
  const [agg] = await Product.aggregate([
    {
      $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        totalStock: { $sum: "$stock" },
        totalReserved: { $sum: { $ifNull: ["$reserved", 0] } },
        totalSold: { $sum: { $ifNull: ["$soldQuantity", 0] } },
        totalRevenue: { $sum: { $ifNull: ["$soldRevenue", 0] } },
        totalReturned: { $sum: { $ifNull: ["$returnedQuantity", 0] } },
        totalDamaged: { $sum: { $ifNull: ["$damagedQuantity", 0] } },
        inventoryCost: { $sum: { $multiply: ["$stock", { $ifNull: ["$productCost", 0] }] } },
        inventoryValue: {
          $sum: {
            $multiply: [
              "$stock",
              {
                $cond: [
                  { $and: [{ $ne: ["$customerSpecialPrice", null] }, { $gt: ["$customerSpecialPrice", 0] }] },
                  "$customerSpecialPrice",
                  "$customerSellPrice",
                ],
              },
            ],
          },
        },
        lowStock: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gt: ["$lowStockThreshold", 0] },
                  {
                    $lte: [
                      { $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] },
                      "$lowStockThreshold",
                    ],
                  },
                  { $gt: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, 0] },
                ],
              },
              1,
              0,
            ],
          },
        },
        outOfStock: {
          $sum: {
            $cond: [{ $lte: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, 0] }, 1, 0],
          },
        },
        // Products the system auto-switched to pre-order because they ran out
        // of stock. Admin-set (MANUAL) pre-orders are counted separately so the
        // dashboard tile reflects what the auto-switch actually did.
        autoPreOrder: {
          $sum: { $cond: [{ $eq: ["$preOrderSource", "AUTO"] }, 1, 0] },
        },
        manualPreOrder: {
          $sum: { $cond: [{ $eq: ["$preOrderSource", "MANUAL"] }, 1, 0] },
        },
      },
    },
  ]);

  const summary = agg || {
    totalProducts: 0,
    totalStock: 0,
    totalReserved: 0,
    totalSold: 0,
    totalRevenue: 0,
    totalReturned: 0,
    totalDamaged: 0,
    inventoryCost: 0,
    inventoryValue: 0,
    lowStock: 0,
    outOfStock: 0,
    autoPreOrder: 0,
    manualPreOrder: 0,
  };

  const cogsAgg = await InventoryLot.aggregate([
    {
      $group: {
        _id: null,
        cogs: {
          $sum: {
            $multiply: [{ $subtract: ["$receivedQuantity", "$remainingQuantity"] }, "$landedUnitCost"],
          },
        },
      },
    },
  ]);
  const cogs = roundMoney(cogsAgg[0]?.cogs || 0);
  const revenue = roundMoney(summary.totalRevenue || 0);
  const grossProfit = roundMoney(revenue - cogs);
  const profitMargin = revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0;

  const [shipmentCount, supplierCount, pendingShipments] = await Promise.all([
    Shipment.countDocuments({}),
    Supplier.countDocuments({ status: "ACTIVE" }),
    Shipment.countDocuments({ status: { $in: ["PENDING", "IN_TRANSIT", "PARTIALLY_RECEIVED"] } }),
  ]);

  const availableStock = Math.max(0, (summary.totalStock || 0) - (summary.totalReserved || 0));

  res.status(200).json({
    success: true,
    message: "Inventory summary fetched successfully",
    data: {
      totalProducts: summary.totalProducts || 0,
      totalStock: summary.totalStock || 0,
      reservedStock: summary.totalReserved || 0,
      availableStock,
      lowStockCount: summary.lowStock || 0,
      outOfStockCount: summary.outOfStock || 0,
      autoPreOrderCount: summary.autoPreOrder || 0,
      manualPreOrderCount: summary.manualPreOrder || 0,
      damagedQuantity: summary.totalDamaged || 0,
      returnedQuantity: summary.totalReturned || 0,
      inventoryCost: roundMoney(summary.inventoryCost || 0),
      inventoryValue: roundMoney(summary.inventoryValue || 0),
      revenue,
      cogs,
      grossProfit,
      profitMargin,
      shipments: {
        total: shipmentCount,
        pending: pendingShipments,
      },
      suppliers: {
        active: supplierCount,
      },
    },
  });
};

// @desc    Inventory table — products with inventory numbers (filter, sort, paginate)
// @route   GET /api/admin/inventory
// @access  inventory.view
export const listInventory = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const category = queryString(req.query.category);
  const stockStatus = queryString(req.query.stockStatus);
  const includeSubcategories = queryString(req.query.includeSubcategories);
  const preOrder = queryString(req.query.preOrder);
  const preOrderSource = queryString(req.query.preOrderSource);
  const sort = queryString(req.query.sort) || "newest";

  const filter: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];

  if (search && search.trim()) {
    const pattern = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ productTitle: pattern }, { slug: pattern }, { sku: pattern }];
  }
  if (category) {
    assertObjectId(category, "category ID");
    const ids = includeSubcategories === "false" ? [category] : await getCategoryWithDescendants(category);
    and.push({ categoryId: { $in: ids } });
  }
  if (stockStatus) {
    if (!["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"].includes(stockStatus)) {
      throw new AppError("stockStatus must be IN_STOCK, LOW_STOCK or OUT_OF_STOCK", 400);
    }
    if (stockStatus === "OUT_OF_STOCK") {
      and.push({ $expr: { $lte: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, 0] } });
    } else if (stockStatus === "LOW_STOCK") {
      and.push({ lowStockThreshold: { $gt: 0 } });
      and.push({
        $expr: {
          $and: [
            { $gt: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, 0] },
            { $lte: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, "$lowStockThreshold"] },
          ],
        },
      });
    } else {
      and.push({
        $expr: {
          $or: [
            { $eq: ["$lowStockThreshold", 0] },
            { $gt: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, "$lowStockThreshold"] },
          ],
        },
      });
    }
  }
  // Pre-order filters so the dashboard can show stock-out → auto-pre-order products.
  if (preOrder === "true") and.push({ isPreOrder: true });
  else if (preOrder === "false") and.push({ isPreOrder: false });
  if (preOrderSource) {
    if (!["AUTO", "MANUAL", "NONE"].includes(preOrderSource)) {
      throw new AppError("preOrderSource must be AUTO, MANUAL or NONE", 400);
    }
    and.push(
      preOrderSource === "NONE"
        ? { $or: [{ preOrderSource: null }, { preOrderSource: { $exists: false } }] }
        : { preOrderSource }
    );
  }

  if (and.length) filter.$and = and;

  const sortMap: Record<string, Record<string, 1 | -1>> = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    stockAsc: { stock: 1 },
    stockDesc: { stock: -1 },
    titleAsc: { productTitle: 1 },
  };
  const sortSpec = sortMap[sort] || sortMap.newest;

  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate("categoryId", "name slug status")
      .sort(sortSpec)
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  const cogsMap = await cogsByProductIds(products.map((p) => p._id));

  res.status(200).json({
    success: true,
    message: "Inventory fetched successfully",
    data: {
      items: products.map((p) => toInventoryRow(p as InventoryRow, cogsMap.get(String(p._id)) || 0)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
};

// @desc    Full inventory profile for one product (lots, recent movements, totals)
// @route   GET /api/admin/inventory/:productId
// @access  inventory.view
export const getProductInventory = async (req: Request, res: Response) => {
  assertObjectId(req.params.productId, "product ID");
  const product = await Product.findById(req.params.productId).populate("categoryId", "name slug status").lean();
  if (!product) throw new AppError("Product not found", 404);

  const cogsMap = await cogsByProductIds([product._id]);
  const lots = await InventoryLot.find({ productId: product._id })
    .populate("supplierId", "name")
    .sort({ receivedDate: 1 })
    .lean();
  const movements = await StockMovement.find({ productId: product._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  res.status(200).json({
    success: true,
    message: "Product inventory fetched successfully",
    data: {
      product: toInventoryRow(product as InventoryRow, cogsMap.get(String(product._id)) || 0),
      lots,
      recentMovements: movements,
    },
  });
};

// @desc    Update per-product inventory settings (threshold, SKU). Stock itself
//          goes through PATCH /:productId/stock so every change is audited.
// @route   PUT /api/admin/inventory/:productId
// @access  inventory.update
export const updateProductInventory = async (req: Request, res: Response) => {
  assertObjectId(req.params.productId, "product ID");
  const product = await Product.findById(req.params.productId);
  if (!product) throw new AppError("Product not found", 404);

  const body = (req.body || {}) as Body;
  const touched: string[] = [];
  const before = { lowStockThreshold: product.lowStockThreshold, sku: product.sku };

  if (body.lowStockThreshold !== undefined) {
    const value = toInteger(body.lowStockThreshold, "lowStockThreshold", { min: 0 });
    if (value !== product.lowStockThreshold) {
      product.lowStockThreshold = value;
      // Reset the alert flag so a new low-stock cycle after this change can fire.
      product.lastLowStockAlertAt = null;
      touched.push("lowStockThreshold");
    }
  }
  if (body.sku !== undefined) {
    const raw = body.sku;
    const sku = typeof raw === "string" ? raw.trim().toUpperCase().slice(0, 60) : "";
    if (sku !== product.sku) {
      if (sku && (await Product.exists({ _id: { $ne: product._id }, sku }))) {
        throw new AppError("A product with this SKU already exists", 409);
      }
      product.sku = sku;
      touched.push("sku");
    }
  }

  if (touched.length === 0) throw new AppError("Send a field to change", 400);
  await product.save();

  await logActivity(req, {
    action: "INVENTORY_THRESHOLD_UPDATED",
    oldValue: { productId: product._id, ...before },
    newValue: { productId: product._id, lowStockThreshold: product.lowStockThreshold, sku: product.sku },
  });

  // If the new threshold means we're already low, fire a fresh alert.
  if (product.lowStockThreshold > 0 && availableOf(product) <= product.lowStockThreshold) {
    notifyLowStock(product._id);
  }

  res.status(200).json({ success: true, message: "Inventory settings updated", data: product });
};

// @desc    Set the stock to an exact number (admin manual stock update). Every call
//          creates a MANUAL_STOCK_UPDATE movement with the old and new numbers.
// @route   PATCH /api/admin/inventory/:productId/stock
// @access  inventory.update
export const setProductStock = async (req: Request, res: Response) => {
  assertObjectId(req.params.productId, "product ID");
  const body = (req.body || {}) as Body;
  const newStock = toInteger(body.stock, "stock", { min: 0 });
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const product = await Product.findById(req.params.productId).session(session);
      if (!product) throw new AppError("Product not found", 404);
      const previous = product.stock;
      if (previous === newStock) throw new AppError("Stock is already at this value", 400);

      product.stock = newStock;
      if (newStock > 0) {
        product.lastStockOutAlertAt = null;
        if (availableOf(product) > product.lowStockThreshold) product.lastLowStockAlertAt = null;
      }
      await product.save({ session });

      await recordMovement(
        {
          productId: product._id,
          type: "MANUAL_STOCK_UPDATE",
          quantity: newStock - previous,
          previousStock: previous,
          newStock,
          reason: reason || "Manual stock update",
          createdBy: getAuthUser(req)._id,
        },
        session
      );

      // Alert evaluation after the write.
      const available = availableOf(product);
      if (available === 0) notifyStockOut(product._id);
      else if (product.lowStockThreshold > 0 && available <= product.lowStockThreshold) {
        notifyLowStock(product._id);
      }

      await syncAutoPreOrderState(product._id, session);

      await logActivity(req, {
        action: "INVENTORY_STOCK_ADJUSTED",
        oldValue: { productId: product._id, stock: previous },
        newValue: { productId: product._id, stock: newStock, reason },
      });
    });
  } finally {
    await session.endSession();
  }

  const refreshed = await Product.findById(req.params.productId).lean();
  const cogsMap = await cogsByProductIds([refreshed!._id]);
  res.status(200).json({
    success: true,
    message: "Stock updated successfully",
    data: toInventoryRow(refreshed as InventoryRow, cogsMap.get(String(refreshed!._id)) || 0),
  });
};

// @desc    Adjust the stock up (positive) or down (negative) with a reason.
//          Different from setProductStock in that the admin provides a delta rather
//          than an absolute. Negative adjustments can't push stock below reserved.
// @route   POST /api/admin/inventory/adjust
// @access  inventory.adjust
export const adjustStock = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  assertObjectId(body.productId, "productId");
  const delta = toSignedInteger(body.adjustBy, "adjustBy");
  if (delta === 0) throw new AppError("adjustBy must be a non-zero whole number", 400);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  const session = await mongoose.startSession();
  let movementType: MovementType = delta > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT";
  if (typeof body.type === "string" && (MOVEMENT_TYPES as readonly string[]).includes(body.type)) {
    movementType = body.type as MovementType;
  }

  try {
    await session.withTransaction(async () => {
      const product = await Product.findById(body.productId).session(session);
      if (!product) throw new AppError("Product not found", 404);
      const previous = product.stock;
      const next = previous + delta;
      if (next < 0) throw new AppError("Stock cannot go below 0", 400);
      if (next < (product.reserved || 0)) {
        throw new AppError("Stock cannot go below reserved quantity", 400);
      }

      product.stock = next;
      if (delta > 0) {
        product.lastStockOutAlertAt = null;
        if (availableOf(product) > product.lowStockThreshold) product.lastLowStockAlertAt = null;
      }
      // Damaged/lost adjustments also touch damagedQuantity.
      if (movementType === "DAMAGE" && delta < 0) product.damagedQuantity += Math.abs(delta);
      await product.save({ session });

      await recordMovement(
        {
          productId: product._id,
          type: movementType,
          quantity: delta,
          previousStock: previous,
          newStock: next,
          reason: reason || `Admin ${movementType}`,
          createdBy: getAuthUser(req)._id,
        },
        session
      );

      await logActivity(req, {
        action: "INVENTORY_STOCK_ADJUSTED",
        oldValue: { productId: product._id, stock: previous },
        newValue: { productId: product._id, stock: next, type: movementType, delta, reason },
      });

      const available = availableOf(product);
      if (available === 0) notifyStockOut(product._id);
      else if (product.lowStockThreshold > 0 && available <= product.lowStockThreshold) {
        notifyLowStock(product._id);
      }

      await syncAutoPreOrderState(product._id, session);
    });
  } finally {
    await session.endSession();
  }

  const refreshed = await Product.findById(body.productId).lean();
  const cogsMap = await cogsByProductIds([refreshed!._id]);
  res.status(200).json({
    success: true,
    message: "Stock adjusted",
    data: toInventoryRow(refreshed as InventoryRow, cogsMap.get(String(refreshed!._id)) || 0),
  });
};

// @desc    Record a damaged or lost quantity (stock-- + damagedQuantity++).
// @route   POST /api/admin/inventory/damage
// @access  inventory.adjust
export const recordDamage = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  assertObjectId(body.productId, "productId");
  const qty = toInteger(body.quantity, "quantity", { min: 1 });
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const product = await Product.findById(body.productId).session(session);
      if (!product) throw new AppError("Product not found", 404);
      if (product.stock < qty) throw new AppError("Cannot record more than current stock as damaged", 400);
      const previous = product.stock;
      product.stock = previous - qty;
      product.damagedQuantity += qty;
      await product.save({ session });

      await recordMovement(
        {
          productId: product._id,
          type: "DAMAGE",
          quantity: -qty,
          previousStock: previous,
          newStock: product.stock,
          reason: reason || "Damage recorded",
          createdBy: getAuthUser(req)._id,
        },
        session
      );
      await logActivity(req, {
        action: "INVENTORY_DAMAGE_RECORDED",
        oldValue: { productId: product._id, stock: previous },
        newValue: { productId: product._id, stock: product.stock, damaged: qty, reason },
      });

      if (product.stock === 0) notifyStockOut(product._id);

      await syncAutoPreOrderState(product._id, session);
    });
  } finally {
    await session.endSession();
  }

  const refreshed = await Product.findById(body.productId).lean();
  const cogsMap = await cogsByProductIds([refreshed!._id]);
  res.status(200).json({
    success: true,
    message: "Damage recorded",
    data: toInventoryRow(refreshed as InventoryRow, cogsMap.get(String(refreshed!._id)) || 0),
  });
};

// @desc    Record a customer return. If sellable: restock + returnedQuantity++.
//          If damaged: damagedQuantity++ + returnedQuantity++ (stock stays).
// @route   POST /api/admin/inventory/return
// @access  inventory.adjust
export const recordReturn = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  assertObjectId(body.productId, "productId");
  const qty = toInteger(body.quantity, "quantity", { min: 1 });
  const sellable = body.sellable === true || body.sellable === "true";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const orderId = body.orderId;
  if (orderId !== undefined && orderId !== null) assertObjectId(orderId, "orderId");

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (sellable) {
        await returnToStock(String(body.productId), qty, session, {
          orderId: orderId ? new mongoose.Types.ObjectId(String(orderId)) : null,
          createdBy: getAuthUser(req)._id,
          reason,
        });
      } else {
        await returnDamaged(String(body.productId), qty, session, {
          orderId: orderId ? new mongoose.Types.ObjectId(String(orderId)) : null,
          createdBy: getAuthUser(req)._id,
          reason,
        });
      }

      await logActivity(req, {
        action: "INVENTORY_RETURN_RECORDED",
        newValue: { productId: body.productId, quantity: qty, sellable, orderId, reason },
      });
    });
  } finally {
    await session.endSession();
  }

  const refreshed = await Product.findById(body.productId).lean();
  const cogsMap = await cogsByProductIds([refreshed!._id]);
  res.status(200).json({
    success: true,
    message: "Return recorded",
    data: toInventoryRow(refreshed as InventoryRow, cogsMap.get(String(refreshed!._id)) || 0),
  });
};

// @desc    List stock movements (filter, pagination)
// @route   GET /api/admin/inventory/movements
// @access  inventory.view
export const listMovements = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const productId = queryString(req.query.productId);
  const type = queryString(req.query.type);
  const orderId = queryString(req.query.orderId);
  const shipmentId = queryString(req.query.shipmentId);
  const fromDate = queryString(req.query.fromDate);
  const toDate = queryString(req.query.toDate);

  const filter: Record<string, unknown> = {};
  if (productId) {
    assertObjectId(productId, "productId");
    filter.productId = productId;
  }
  if (type) {
    if (!(MOVEMENT_TYPES as readonly string[]).includes(type)) {
      throw new AppError(`type must be one of ${MOVEMENT_TYPES.join(", ")}`, 400);
    }
    filter.type = type;
  }
  if (orderId) {
    assertObjectId(orderId, "orderId");
    filter.orderId = orderId;
  }
  if (shipmentId) {
    assertObjectId(shipmentId, "shipmentId");
    filter.shipmentId = shipmentId;
  }
  if (fromDate || toDate) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (fromDate) range.$gte = new Date(fromDate);
    if (toDate) range.$lte = new Date(toDate);
    filter.createdAt = range;
  }

  const [movements, total] = await Promise.all([
    StockMovement.find(filter)
      .populate("productId", "productTitle sku slug")
      .populate("createdBy", "fullName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    StockMovement.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Stock movements fetched successfully",
    data: {
      movements,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
};

// @desc    Shortcut: movements for one product
// @route   GET /api/admin/inventory/:productId/movements
// @access  inventory.view
export const listProductMovements = async (req: Request, res: Response) => {
  (req.query as Record<string, unknown>).productId = req.params.productId;
  await listMovements(req, res);
};

// ---- Reports ---------------------------------------------------------------

// @desc    Low-stock report
// @route   GET /api/admin/inventory/reports/low-stock
// @access  inventory.view
export const lowStockReport = async (req: Request, res: Response) => {
  const products = await Product.find({
    lowStockThreshold: { $gt: 0 },
    $expr: {
      $and: [
        { $gt: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, 0] },
        { $lte: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, "$lowStockThreshold"] },
      ],
    },
  })
    .populate("categoryId", "name")
    .sort({ productTitle: 1 })
    .lean();
  res.status(200).json({
    success: true,
    message: "Low-stock report fetched successfully",
    data: products.map((p) => ({
      _id: p._id,
      productTitle: p.productTitle,
      sku: p.sku || "",
      category: (p.categoryId as unknown as { name?: string })?.name || "",
      stock: p.stock,
      reserved: p.reserved || 0,
      available: Math.max(0, (p.stock || 0) - (p.reserved || 0)),
      lowStockThreshold: p.lowStockThreshold,
    })),
  });
};

// @desc    Out-of-stock report
// @route   GET /api/admin/inventory/reports/out-of-stock
// @access  inventory.view
export const outOfStockReport = async (req: Request, res: Response) => {
  const products = await Product.find({
    $expr: { $lte: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, 0] },
  })
    .populate("categoryId", "name")
    .sort({ productTitle: 1 })
    .lean();
  res.status(200).json({
    success: true,
    message: "Out-of-stock report fetched successfully",
    data: products.map((p) => ({
      _id: p._id,
      productTitle: p.productTitle,
      sku: p.sku || "",
      category: (p.categoryId as unknown as { name?: string })?.name || "",
      stock: p.stock,
      reserved: p.reserved || 0,
    })),
  });
};

// @desc    Profit report (per product, revenue - COGS)
// @route   GET /api/admin/inventory/reports/profit
// @access  inventory.view
export const profitReport = async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 100, 1), 500);
  const products = await Product.find({})
    .select("productTitle sku categoryId stock reserved soldQuantity soldRevenue")
    .limit(limit)
    .lean();
  const cogsMap = await cogsByProductIds(products.map((p) => p._id));

  const rows = products
    .map((p) => {
      const revenue = roundMoney(p.soldRevenue || 0);
      const cogs = cogsMap.get(String(p._id)) || 0;
      const profit = roundMoney(revenue - cogs);
      const margin = revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : 0;
      return {
        productId: p._id,
        productTitle: p.productTitle,
        sku: p.sku || "",
        soldQuantity: p.soldQuantity || 0,
        revenue,
        cogs,
        profit,
        margin,
      };
    })
    .sort((a, b) => b.profit - a.profit);

  const totalRevenue = roundMoney(rows.reduce((s, r) => s + r.revenue, 0));
  const totalCogs = roundMoney(rows.reduce((s, r) => s + r.cogs, 0));
  const totalProfit = roundMoney(totalRevenue - totalCogs);
  const totalMargin = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0;

  res.status(200).json({
    success: true,
    message: "Profit report fetched successfully",
    data: {
      rows,
      totals: { revenue: totalRevenue, cogs: totalCogs, profit: totalProfit, margin: totalMargin },
    },
  });
};

// @desc    Purchase report (shipments summary)
// @route   GET /api/admin/inventory/reports/purchases
// @access  inventory.view
export const purchaseReport = async (req: Request, res: Response) => {
  const fromDate = queryString(req.query.fromDate);
  const toDate = queryString(req.query.toDate);
  const supplierId = queryString(req.query.supplierId);
  const match: Record<string, unknown> = {};
  if (supplierId) {
    assertObjectId(supplierId, "supplierId");
    match.supplierId = new mongoose.Types.ObjectId(supplierId);
  }
  if (fromDate || toDate) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (fromDate) range.$gte = new Date(fromDate);
    if (toDate) range.$lte = new Date(toDate);
    match.shipmentDate = range;
  }

  const shipments = await Shipment.find(match)
    .populate("supplierId", "name")
    .sort({ shipmentDate: -1 })
    .lean();

  const totals = shipments.reduce(
    (acc, s) => {
      acc.subtotal += s.subtotal;
      acc.totalCost += s.totalCost;
      acc.quantity += s.items.reduce((sum, i) => sum + i.purchaseQuantity, 0);
      acc.received += s.items.reduce((sum, i) => sum + i.receivedQuantity, 0);
      return acc;
    },
    { subtotal: 0, totalCost: 0, quantity: 0, received: 0 }
  );

  res.status(200).json({
    success: true,
    message: "Purchase report fetched successfully",
    data: {
      shipments: shipments.map((s) => ({
        _id: s._id,
        shipmentNumber: s.shipmentNumber,
        supplier: (s.supplierId as unknown as { name?: string })?.name || "",
        shipmentDate: s.shipmentDate,
        status: s.status,
        totalItems: s.items.length,
        quantity: s.items.reduce((sum, i) => sum + i.purchaseQuantity, 0),
        received: s.items.reduce((sum, i) => sum + i.receivedQuantity, 0),
        subtotal: s.subtotal,
        totalCost: s.totalCost,
      })),
      totals: {
        subtotal: roundMoney(totals.subtotal),
        totalCost: roundMoney(totals.totalCost),
        quantity: totals.quantity,
        received: totals.received,
      },
    },
  });
};

// @desc    Inventory valuation (cost + sell price value) per product
// @route   GET /api/admin/inventory/reports/valuation
// @access  inventory.view
export const valuationReport = async (req: Request, res: Response) => {
  const products = await Product.find({ stock: { $gt: 0 } })
    .select("productTitle sku stock productCost customerSellPrice customerSpecialPrice")
    .lean();
  const rows = products.map((p) => {
    const sellPrice = p.customerSpecialPrice && p.customerSpecialPrice > 0 ? p.customerSpecialPrice : p.customerSellPrice;
    return {
      productId: p._id,
      productTitle: p.productTitle,
      sku: p.sku || "",
      stock: p.stock,
      unitCost: p.productCost,
      sellPrice,
      costValue: roundMoney(p.stock * p.productCost),
      sellValue: roundMoney(p.stock * sellPrice),
    };
  });
  const totals = rows.reduce(
    (acc, r) => {
      acc.costValue += r.costValue;
      acc.sellValue += r.sellValue;
      return acc;
    },
    { costValue: 0, sellValue: 0 }
  );
  res.status(200).json({
    success: true,
    message: "Inventory valuation fetched successfully",
    data: {
      rows,
      totals: { costValue: roundMoney(totals.costValue), sellValue: roundMoney(totals.sellValue) },
    },
  });
};

// ---- Stock requests --------------------------------------------------------

// @desc    List stock-request rows (admin inbox)
// @route   GET /api/admin/inventory/stock-requests
// @access  stockRequests.view
export const listStockRequests = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const status = queryString(req.query.status);
  const productId = queryString(req.query.productId);
  const customerId = queryString(req.query.customerId);
  const filter: Record<string, unknown> = {};
  if (status) {
    if (!isStockRequestStatus(status)) {
      throw new AppError(`status must be one of ${STOCK_REQUEST_STATUSES.join(", ")}`, 400);
    }
    filter.status = status;
  }
  if (productId) {
    assertObjectId(productId, "productId");
    filter.productId = productId;
  }
  if (customerId) {
    assertObjectId(customerId, "customerId");
    filter.customerId = customerId;
  }

  const [requests, total] = await Promise.all([
    StockRequest.find(filter)
      .populate("productId", "productTitle sku slug")
      .populate("customerId", "fullName phoneNumber email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    StockRequest.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Stock requests fetched successfully",
    data: {
      requests,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
};

// @desc    Update a stock-request (change status, add admin note)
// @route   PUT /api/admin/inventory/stock-requests/:id
// @access  stockRequests.update
export const updateStockRequest = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "stock request ID");
  const request = await StockRequest.findById(req.params.id);
  if (!request) throw new AppError("Stock request not found", 404);
  const body = (req.body || {}) as Body;
  const before = { status: request.status, adminNote: request.adminNote };

  if (body.status !== undefined) {
    if (!isStockRequestStatus(body.status)) {
      throw new AppError(`status must be one of ${STOCK_REQUEST_STATUSES.join(", ")}`, 400);
    }
    request.status = body.status;
  }
  if (body.adminNote !== undefined) {
    if (typeof body.adminNote !== "string") throw new AppError("adminNote must be text", 400);
    request.adminNote = body.adminNote.trim().slice(0, 1000);
  }
  await request.save();

  await logActivity(req, {
    action: "STOCK_REQUEST_UPDATED",
    oldValue: { requestId: request._id, ...before },
    newValue: { requestId: request._id, status: request.status, adminNote: request.adminNote },
  });

  res.status(200).json({ success: true, message: "Stock request updated", data: request });
};

// @desc    Delete a stock-request (admin cleanup)
// @route   DELETE /api/admin/inventory/stock-requests/:id
// @access  stockRequests.delete
export const deleteStockRequest = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "stock request ID");
  const request = await StockRequest.findByIdAndDelete(req.params.id);
  if (!request) throw new AppError("Stock request not found", 404);
  await logActivity(req, {
    action: "STOCK_REQUEST_DELETED",
    oldValue: { requestId: request._id, productId: request.productId },
  });
  res.status(200).json({
    success: true,
    message: "Stock request deleted successfully",
    data: { _id: request._id },
  });
};

// @desc    Public endpoint: record a stock request for a product (customer or guest).
//          The customer gets a non-sensitive confirmation; the admin gets an email
//          (rate-limited). Also fires on cart overshoot via the cart controller.
// @route   POST /api/inventory/stock-request
// @access  Public (optional auth)
export const createStockRequestPublic = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  assertObjectId(body.productId, "productId");
  const quantity = toInteger(body.quantity, "quantity", { min: 1 });

  const product = await Product.findById(body.productId).lean();
  if (!product) throw new AppError("Product not found", 404);
  // Public endpoint should only expose products the storefront can see.
  const visible = new Set((await getVisibleCategoryIds()).map(String));
  if (product.status !== "ACTIVE" || !visible.has(String(product.categoryId))) {
    throw new AppError("Product not available", 400);
  }

  const available = Math.max(0, (product.stock || 0) - (product.reserved || 0));
  const authUser = req.user;
  const customerName =
    typeof body.customerName === "string"
      ? body.customerName.trim().slice(0, 160)
      : authUser?.fullName || "";
  const customerPhone =
    typeof body.customerPhone === "string"
      ? body.customerPhone.trim().slice(0, 30)
      : authUser?.phoneNumber || "";
  const customerEmail =
    typeof body.customerEmail === "string"
      ? body.customerEmail.trim().toLowerCase().slice(0, 160)
      : authUser?.email || "";

  if (!customerName && !customerPhone && !customerEmail) {
    throw new AppError("Provide at least one contact field so admin can reach you", 400);
  }

  const request = await StockRequest.create({
    productId: product._id,
    customerId: authUser?._id ?? null,
    customerName,
    customerPhone,
    customerEmail,
    productTitleSnapshot: product.productTitle,
    skuSnapshot: product.sku || "",
    requestedQuantity: quantity,
    availableQuantity: available,
    shortageQuantity: Math.max(1, quantity - available),
  });
  notifyStockRequest(request._id);
  await logActivity(req, {
    action: "STOCK_REQUEST_CREATED",
    newValue: { requestId: request._id, productId: product._id, quantity },
  });

  res.status(201).json({
    success: true,
    message: "Stock request submitted. Our team will contact you if more stock is available.",
    data: {
      _id: request._id,
      available,
      requested: quantity,
      shortage: request.shortageQuantity,
    },
  });
};

// ---- Validation endpoints --------------------------------------------------
//
// Dedicated endpoints the storefront can call to proactively re-check stock
// without actually mutating the cart or placing an order.

// @desc    Validate a single product+quantity against current stock
// @route   POST /api/inventory/validate
// @access  Public (optional auth)
export const validateProductStock = async (req: Request, res: Response): Promise<void> => {
  const body = (req.body || {}) as Body;
  assertObjectId(body.productId, "productId");
  const quantity = toInteger(body.quantity, "quantity", { min: 1 });
  const product = await Product.findById(body.productId).lean();
  if (!product) throw new AppError("Product not found", 404);

  const available = Math.max(0, (product.stock || 0) - (product.reserved || 0));
  if (product.isPreOrder) {
    res.status(200).json({
      success: true,
      message: "Pre-order product — unlimited availability",
      data: { productId: product._id, requested: quantity, available: null, ok: true, isPreOrder: true },
    });
    return;
  }

  res.status(200).json({
    success: true,
    message: quantity <= available ? "Stock is available" : "Insufficient stock",
    data: {
      productId: product._id,
      requested: quantity,
      available,
      ok: quantity <= available,
      stockStatus: stockStatusOf(available, product.lowStockThreshold || 0),
      isPreOrder: !!product.isPreOrder,
    },
  });
};

// @desc    List movement types (for admin UI filters)
// @route   GET /api/admin/inventory/movements/types
// @access  inventory.view
export const stockMovementTypes = (_req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "Movement types", data: MOVEMENT_TYPES });
};
