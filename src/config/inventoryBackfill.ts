import mongoose from "mongoose";
import Product from "../models/Product";
import OrderItem from "../models/OrderItem";
import Order from "../models/Order";
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

export const runInventoryBackfill = async (): Promise<void> => {
  await normalizeShape();
  await autoGenerateSkus();
  await backfillSoldTotals();
};
