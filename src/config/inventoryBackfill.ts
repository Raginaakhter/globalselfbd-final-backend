import mongoose from "mongoose";
import Product from "../models/Product";
import OrderItem from "../models/OrderItem";
import Order from "../models/Order";
import StockMovement from "../models/StockMovement";
import { slugify } from "../utils/slugify";

// Idempotent one-shot backfill for products that existed before the inventory
// system was added. Runs on every startup; each step is a no-op once satisfied,
// so it is safe to leave in place.
//
//  1. Make sure every product has the new fields present (defaults handle it on
//     write, but reads of a lean() legacy row returned `undefined` — $setOnInsert-
//     style upsert here guarantees the shape).
//  2. Auto-generate SKUs for products that have none, so the inventory table and
//     the admin notifications can always show a code.
//  3. Backfill `soldQuantity` + `soldRevenue` from historical DELIVERED and SHIPPED
//     order items whose numbers were never counted (every pre-upgrade sale).
//
// A one-row control document on `inventorybackfill` tracks what we already did,
// so step 3 only ever runs ONCE per order lifetime even if the collection grows.

type BackfillRow = { _id: string; completedAt: Date };
const BackfillLog = Product.db.collection<BackfillRow>("inventorybackfills");

const padSku = (n: number) => n.toString().padStart(4, "0");

// Shape all products once: default the inventory fields when they're missing.
const normalizeShape = async (): Promise<void> => {
  await Product.collection.updateMany(
    { reserved: { $exists: false } },
    { $set: { reserved: 0 } }
  );
  await Product.collection.updateMany(
    { soldQuantity: { $exists: false } },
    { $set: { soldQuantity: 0 } }
  );
  await Product.collection.updateMany(
    { soldRevenue: { $exists: false } },
    { $set: { soldRevenue: 0 } }
  );
  await Product.collection.updateMany(
    { returnedQuantity: { $exists: false } },
    { $set: { returnedQuantity: 0 } }
  );
  await Product.collection.updateMany(
    { damagedQuantity: { $exists: false } },
    { $set: { damagedQuantity: 0 } }
  );
  await Product.collection.updateMany(
    { lowStockThreshold: { $exists: false } },
    { $set: { lowStockThreshold: 0 } }
  );
  await Product.collection.updateMany(
    { lastLowStockAlertAt: { $exists: false } },
    { $set: { lastLowStockAlertAt: null } }
  );
  await Product.collection.updateMany(
    { sku: { $exists: false } },
    { $set: { sku: "" } }
  );
};

// Fill SKUs for products that don't have one. Format: <SLUG-PREFIX>-<4-DIGIT>.
// Collisions on the unique index are retried with a bumped sequence; the overall
// loop is still bounded (one pass per product), so a bulk-add safely terminates.
const autoGenerateSkus = async (): Promise<void> => {
  const products = await Product.find({ $or: [{ sku: "" }, { sku: { $exists: false } }] })
    .select("_id productTitle slug")
    .lean();
  if (products.length === 0) return;

  // Determine the next counter so new SKUs do not clash with any existing ones.
  const existing = await Product.find({ sku: { $ne: "" } }).select("sku").lean();
  let counter = 1000;
  for (const row of existing) {
    const match = typeof row.sku === "string" ? row.sku.match(/-(\d{4,})$/) : null;
    if (match) counter = Math.max(counter, parseInt(match[1], 10) + 1);
  }

  let generated = 0;
  for (const product of products) {
    // Prefix from the slug/title: first 3-6 alpha chars uppercased, fallback to PRD.
    const base = (product.slug || slugify(product.productTitle) || "prd")
      .replace(/[^a-z0-9]/gi, "")
      .toUpperCase()
      .slice(0, 6);
    const prefix = base || "PRD";

    let sku = `${prefix}-${padSku(counter)}`;
    let placed = false;
    const productObjectId = product._id;
    // Try up to 5 bumps per product to clear any lingering collisions.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await Product.updateOne({ _id: productObjectId, sku: "" }, { $set: { sku } });
        placed = true;
        counter += 1;
        break;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) {
          counter += 1;
          sku = `${prefix}-${padSku(counter)}`;
          continue;
        }
        throw error;
      }
    }
    if (placed) generated += 1;
  }
  if (generated) {
    console.log(`🏷️  Auto-generated SKUs for ${generated} existing product(s)`);
  }
};

// Backfill historical sold totals from past DELIVERED/SHIPPED orders. Runs ONCE —
// subsequent sales flow through finalizeSale/reserveStock and update soldQuantity
// and soldRevenue incrementally.
const backfillSoldTotals = async (): Promise<void> => {
  const existing = await BackfillLog.findOne({ _id: "soldTotals" });
  if (existing) return;

  const settledOrderIds = await Order.find({
    orderStatus: { $in: ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] },
  })
    .select("_id")
    .lean();
  if (settledOrderIds.length === 0) {
    await BackfillLog.insertOne({ _id: "soldTotals", completedAt: new Date() });
    return;
  }

  const totals = await OrderItem.aggregate([
    { $match: { orderId: { $in: settledOrderIds.map((o) => o._id) }, isPreOrder: { $ne: true } } },
    {
      $facet: {
        products: [
          { $match: { productId: { $ne: null } } },
          {
            $group: {
              _id: "$productId",
              quantity: { $sum: "$quantity" },
              revenue: { $sum: "$subtotal" },
            },
          },
        ],
        combos: [
          { $match: { comboId: { $ne: null } } },
          { $unwind: "$comboItemsSnapshot" },
          {
            $group: {
              _id: "$comboItemsSnapshot.productId",
              quantity: {
                $sum: { $multiply: ["$quantity", "$comboItemsSnapshot.quantity"] },
              },
              // Attribute combo revenue to each member by its unit price × quantity share.
              revenue: {
                $sum: {
                  $multiply: [
                    "$quantity",
                    "$comboItemsSnapshot.unitPrice",
                    "$comboItemsSnapshot.quantity",
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ]);

  const perProduct = new Map<string, { quantity: number; revenue: number }>();
  const addRows = (rows: { _id: unknown; quantity: number; revenue: number }[]) => {
    for (const row of rows) {
      const id = String(row._id);
      const existing = perProduct.get(id) || { quantity: 0, revenue: 0 };
      existing.quantity += row.quantity || 0;
      existing.revenue += row.revenue || 0;
      perProduct.set(id, existing);
    }
  };
  addRows(totals[0]?.products || []);
  addRows(totals[0]?.combos || []);

  if (perProduct.size > 0) {
    const ops = [...perProduct.entries()].map(([productId, totals]) => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(productId) },
        update: {
          $set: {
            soldQuantity: Math.max(0, Math.round(totals.quantity)),
            soldRevenue: Math.round(totals.revenue * 100) / 100,
          },
        },
      },
    }));
    await Product.bulkWrite(ops, { ordered: false });
    console.log(`📊 Backfilled sold totals on ${perProduct.size} product(s) from historical orders`);
  }

  await BackfillLog.insertOne({ _id: "soldTotals", completedAt: new Date() });
};

// Create missing SALE stock-movements for every historical DELIVERED/SHIPPED
// order item that pre-dates the inventory system. Without these, PnL and
// inventory COGS reports both aggregate off StockMovement SALE events and
// return 0 for every pre-upgrade sale — the sale happened (soldQuantity was
// backfilled) but no movement row exists to attribute the cost to.
//
// Idempotent in two ways:
//   1. A BackfillLog row (`saleMovements`) short-circuits a second run.
//   2. Per-order existence check — if an order already has ANY SALE movements
//      for a given product, we assume that order was processed through the
//      normal finalizeSale path and skip it. Only pure-gap orders get rows.
//
// unitCost uses the product's current productCost, which is the best estimate
// available for historical cost — admins who paid attention set this at upload.
// Products with productCost=0 get movements with unitCost=0, which is the same
// outcome as before this backfill (so no regression, just honest zeros).
const backfillSaleMovements = async (): Promise<void> => {
  const existing = await BackfillLog.findOne({ _id: "saleMovements" });
  if (existing) return;

  const settledOrders = await Order.find({
    orderStatus: { $in: ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] },
  })
    .select("_id customerId deliveredAt createdAt")
    .lean();
  if (settledOrders.length === 0) {
    await BackfillLog.insertOne({ _id: "saleMovements", completedAt: new Date() });
    return;
  }

  const orderIds = settledOrders.map((o) => o._id);

  // One query to find which (order, product) pairs already have SALE movements.
  const existingPairs = await StockMovement.aggregate<{ _id: { orderId: mongoose.Types.ObjectId; productId: mongoose.Types.ObjectId } }>([
    { $match: { orderId: { $in: orderIds }, type: "SALE" } },
    { $group: { _id: { orderId: "$orderId", productId: "$productId" } } },
  ]);
  const covered = new Set(
    existingPairs.map((r) => `${String(r._id.orderId)}:${String(r._id.productId)}`)
  );

  const items = await OrderItem.find({ orderId: { $in: orderIds }, isPreOrder: { $ne: true } }).lean();
  if (items.length === 0) {
    await BackfillLog.insertOne({ _id: "saleMovements", completedAt: new Date() });
    return;
  }

  // Load every product referenced (direct + combo members) so we can read productCost.
  const productIds = new Set<string>();
  for (const item of items) {
    if (item.productId) productIds.add(String(item.productId));
    for (const member of item.comboItemsSnapshot || []) {
      if (member.productId) productIds.add(String(member.productId));
    }
  }
  const products = await Product.find({ _id: { $in: [...productIds] } })
    .select("_id productCost stock")
    .lean();
  const costOf = new Map(products.map((p) => [String(p._id), p.productCost || 0]));
  const stockOf = new Map(products.map((p) => [String(p._id), p.stock || 0]));

  const orderDateOf = new Map(
    settledOrders.map((o) => [String(o._id), o.deliveredAt || o.createdAt])
  );

  // Build one SALE movement per (orderItem, productId) gap. For combo lines
  // the OrderItem contributes one movement per member product.
  type MovementInsert = {
    productId: mongoose.Types.ObjectId;
    lotId: null;
    shipmentId: null;
    orderId: mongoose.Types.ObjectId;
    type: "SALE";
    quantity: number;
    previousStock: number;
    newStock: number;
    unitCost: number;
    reason: string;
    createdBy: null;
    createdAt: Date;
  };
  const inserts: MovementInsert[] = [];

  for (const item of items) {
    const orderId = item.orderId;
    const when = orderDateOf.get(String(orderId)) || new Date();

    const pushMovement = (productId: mongoose.Types.ObjectId, qty: number): void => {
      const key = `${String(orderId)}:${String(productId)}`;
      if (covered.has(key)) return;
      const stock = stockOf.get(String(productId)) || 0;
      inserts.push({
        productId,
        lotId: null,
        shipmentId: null,
        orderId,
        type: "SALE",
        quantity: qty,
        previousStock: stock + qty, // best-effort reconstruction; audit only
        newStock: stock,
        unitCost: costOf.get(String(productId)) || 0,
        reason: "Backfill: historical sale pre-dating inventory system",
        createdBy: null,
        createdAt: when,
      });
      covered.add(key); // dedupe within this run too
    };

    if (item.productId) {
      pushMovement(item.productId, item.quantity);
    } else {
      // Combo line — one SALE per member product, qty = memberQty * lineQty
      for (const member of item.comboItemsSnapshot || []) {
        pushMovement(member.productId, member.quantity * item.quantity);
      }
    }
  }

  if (inserts.length > 0) {
    // insertMany with ordered:false so one bad row never blocks the batch.
    await StockMovement.insertMany(inserts, { ordered: false });
    console.log(`📊 Backfilled ${inserts.length} SALE stock-movements for historical orders`);
  }

  await BackfillLog.insertOne({ _id: "saleMovements", completedAt: new Date() });
};

export const runInventoryBackfill = async (): Promise<void> => {
  await normalizeShape();
  await autoGenerateSkus();
  await backfillSoldTotals();
  await backfillSaleMovements();
};
