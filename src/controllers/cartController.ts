import type { Request, Response } from "express";
import type { Types } from "mongoose";
import Product, { type ProductDocument } from "../models/Product";
import CartItem from "../models/CartItem";
import Combo, { type ComboDocument } from "../models/Combo";
import StockRequest from "../models/StockRequest";
import AppError from "../utils/AppError";
import { assertObjectId } from "../utils/validators";
import { getVisibleCategoryIds } from "../utils/categoryTree";
import { getFinalPrice } from "../utils/productView";
import {
  roundMoney,
  getOrCreateCart,
  resolveSelection,
  assertPurchasable,
  productSnapshot,
  comboSnapshotFromDoc,
  loadCart,
  toCartResponse,
} from "../utils/checkout";
import { isComboLive } from "../utils/combos";
import { availableOf } from "../utils/inventory";
import { notifyStockRequest } from "../utils/adminAlerts";
import { getAuthUser } from "../middleware/auth";
import { CART_LIMITS } from "../config/orderOptions";

// Every query is scoped to the logged-in user's own cart.

type Body = Record<string, unknown>;

const parseQuantity = (value: unknown): number => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new AppError("Quantity must be a whole number of at least 1", 400);
  }
  if (n > CART_LIMITS.MAX_QUANTITY_PER_ITEM) {
    throw new AppError(`You can add at most ${CART_LIMITS.MAX_QUANTITY_PER_ITEM} of one item`, 400);
  }
  return n;
};

const loadPurchasableProduct = async (productId: unknown): Promise<ProductDocument> => {
  assertObjectId(productId, "product ID");
  const product = await Product.findById(productId);
  if (!product) throw new AppError("Product not found", 404);
  const visible = new Set((await getVisibleCategoryIds()).map(String));
  assertPurchasable(product, visible);
  // Pre-order products are always purchasable even with zero availability;
  // the admin fulfils them after the delivery window.
  if (!product.isPreOrder && availableOf(product) <= 0) {
    throw new AppError("Product is out of stock", 400);
  }
  return product;
};

// Create a StockRequest row and queue the admin alert. Called whenever a
// customer tries to add/update a quantity greater than available stock.
// Request rows feed the admin "Stock Requests" dashboard regardless of whether
// the email actually goes out (rate-limiting happens on the notification side).
const recordStockRequest = async (
  req: Request,
  product: ProductDocument,
  requestedQuantity: number,
  availableQuantity: number
): Promise<void> => {
  const shortage = Math.max(0, requestedQuantity - availableQuantity);
  if (shortage <= 0) return;
  const authUser = req.user ?? null;
  const request = await StockRequest.create({
    productId: product._id,
    customerId: authUser?._id ?? null,
    customerName: authUser?.fullName || "",
    customerPhone: authUser?.phoneNumber || "",
    customerEmail: authUser?.email || "",
    productTitleSnapshot: product.productTitle,
    skuSnapshot: product.sku || "",
    requestedQuantity,
    availableQuantity,
    shortageQuantity: shortage,
    status: "NEW",
  });
  notifyStockRequest(request._id);
};

const loadPurchasableCombo = async (
  comboId: unknown
): Promise<{ combo: ComboDocument; members: Map<string, ProductDocument> }> => {
  assertObjectId(comboId, "combo ID");
  const combo = await Combo.findById(comboId);
  if (!combo) throw new AppError("Combo not found", 404);
  if (!isComboLive(combo)) throw new AppError("Combo is not available", 400);

  const members = await Product.find({ _id: { $in: combo.items.map((i) => i.productId) } });
  const visible = new Set((await getVisibleCategoryIds()).map(String));
  const byId = new Map(members.map((p) => [String(p._id), p]));
  for (const item of combo.items) {
    const product = byId.get(String(item.productId));
    if (!product) throw new AppError("A product in this combo is no longer available", 400);
    if (product.status !== "ACTIVE" || !visible.has(String(product.categoryId))) {
      throw new AppError("A product in this combo is no longer available", 400);
    }
    if (availableOf(product) < item.quantity) {
      throw new AppError("Insufficient stock for a combo item", 400);
    }
  }
  return { combo, members: byId };
};

// Total quantity of this product in the cart (across product lines and combo member usage)
// must fit in AVAILABLE stock (stock - reserved). Customers see "Insufficient product
// stock" — never the raw number — and a StockRequest row is recorded so the admin can
// see unmet demand.
const assertStockFor = async (
  req: Request,
  cartId: Types.ObjectId,
  product: ProductDocument,
  newQuantity: number,
  excludeItemId?: Types.ObjectId
): Promise<void> => {
  // Pre-order products ignore stock gating entirely.
  if (product.isPreOrder) return;

  const filter: Record<string, unknown> = { cartId, productId: product._id };
  if (excludeItemId) filter._id = { $ne: excludeItemId };
  const others = await CartItem.find(filter).select("quantity");
  // Also sum how much of this product is consumed by combo lines in the cart
  const comboItems = await CartItem.find({ cartId, comboId: { $ne: null } });
  let comboConsumption = 0;
  if (comboItems.length) {
    const combos = await Combo.find({ _id: { $in: comboItems.map((c) => c.comboId as Types.ObjectId) } });
    const comboMap = new Map(combos.map((c) => [String(c._id), c]));
    for (const line of comboItems) {
      const combo = comboMap.get(String(line.comboId));
      if (!combo) continue;
      for (const member of combo.items) {
        if (String(member.productId) === String(product._id)) {
          comboConsumption += member.quantity * line.quantity;
        }
      }
    }
  }
  const available = availableOf(product);
  const total = others.reduce((sum, i) => sum + i.quantity, 0) + newQuantity + comboConsumption;
  if (total > available) {
    // Fire-and-forget: log the shortage so the admin can see unmet demand.
    // Rate-limit happens inside notifyStockRequest; we always create the row.
    await recordStockRequest(req, product, total, available);
    throw new AppError(
      `Only ${available} unit${available === 1 ? "" : "s"} available for "${product.productTitle}"`,
      400
    );
  }
};

// For combo adds: validate that all member products have stock given the full cart
const assertComboStockFor = async (
  req: Request,
  cartId: Types.ObjectId,
  combo: ComboDocument,
  newQuantity: number,
  excludeItemId?: Types.ObjectId
): Promise<void> => {
  const memberProducts = await Product.find({ _id: { $in: combo.items.map((i) => i.productId) } });
  const byId = new Map(memberProducts.map((p) => [String(p._id), p]));

  for (const member of combo.items) {
    const product = byId.get(String(member.productId));
    if (!product) throw new AppError("A product in this combo is no longer available", 400);
    await assertStockFor(req, cartId, product, member.quantity * newQuantity, excludeItemId);
  }
};

const sendCart = async (req: Request, res: Response, statusCode: number, message: string): Promise<void> => {
  const { cart, lines } = await loadCart(getAuthUser(req)._id);
  res.status(statusCode).json({ success: true, message, data: toCartResponse(cart, lines) });
};

const findOwnItemOr404 = async (req: Request) => {
  assertObjectId(req.params.itemId, "cart item ID");
  const cart = await getOrCreateCart(getAuthUser(req)._id);
  const item = await CartItem.findOne({ _id: req.params.itemId, cartId: cart._id });
  if (!item) throw new AppError("Cart item not found", 404);
  return { cart, item };
};

// @desc    Get my cart (prices refreshed from current products/combos)
// @route   GET /api/cart
// @access  cart.manage
export const getCart = (req: Request, res: Response) => sendCart(req, res, 200, "Cart fetched successfully");

// @desc    Add a product OR combo to my cart (same product + size is merged; same combo is merged)
// @route   POST /api/cart
// @access  cart.manage
export const addToCart = async (req: Request, res: Response) => {
  const { productId, comboId, quantity = 1, size, unit } = (req.body || {}) as Body;
  const qty = parseQuantity(quantity);

  if (comboId !== undefined && comboId !== null && comboId !== "") {
    // ---- Combo add ----
    if (productId !== undefined && productId !== null && productId !== "") {
      throw new AppError("Send either productId or comboId, not both", 400);
    }
    const { combo, members } = await loadPurchasableCombo(comboId);
    const cart = await getOrCreateCart(getAuthUser(req)._id);

    const existing = await CartItem.findOne({ cartId: cart._id, comboId: combo._id });
    const newQuantity = (existing ? existing.quantity : 0) + qty;
    if (newQuantity > CART_LIMITS.MAX_QUANTITY_PER_ITEM) {
      throw new AppError(`You can add at most ${CART_LIMITS.MAX_QUANTITY_PER_ITEM} of one item`, 400);
    }
    if (!existing && (await CartItem.countDocuments({ cartId: cart._id })) >= CART_LIMITS.MAX_ITEMS) {
      throw new AppError(`Your cart can hold at most ${CART_LIMITS.MAX_ITEMS} different items`, 400);
    }
    await assertComboStockFor(req, cart._id, combo, newQuantity, existing?._id);

    const unitPrice = combo.comboPrice;
    const fields = {
      quantity: newQuantity,
      unitPrice,
      subtotal: roundMoney(unitPrice * newQuantity),
      comboSnapshot: comboSnapshotFromDoc(combo, members),
    };
    if (existing) {
      existing.set(fields);
      await existing.save();
    } else {
      await CartItem.create({
        cartId: cart._id,
        comboId: combo._id,
        productId: null,
        selectedSize: null,
        selectedUnit: null,
        productSnapshot: null,
        ...fields,
      });
    }
    return sendCart(req, res, existing ? 200 : 201, existing ? "Cart item quantity updated" : "Combo added to cart");
  }

  // ---- Product add ----
  const product = await loadPurchasableProduct(productId);
  const { selectedSize, selectedUnit } = resolveSelection(product, size, unit);

  const cart = await getOrCreateCart(getAuthUser(req)._id);
  const existing = await CartItem.findOne({
    cartId: cart._id,
    productId: product._id,
    selectedSize,
    selectedUnit,
  });
  const newQuantity = (existing ? existing.quantity : 0) + qty;

  if (newQuantity > CART_LIMITS.MAX_QUANTITY_PER_ITEM) {
    throw new AppError(`You can add at most ${CART_LIMITS.MAX_QUANTITY_PER_ITEM} of one item`, 400);
  }
  if (!existing && (await CartItem.countDocuments({ cartId: cart._id })) >= CART_LIMITS.MAX_ITEMS) {
    throw new AppError(`Your cart can hold at most ${CART_LIMITS.MAX_ITEMS} different items`, 400);
  }
  await assertStockFor(req, cart._id, product, newQuantity, existing?._id);

  const unitPrice = getFinalPrice(product);
  const fields = {
    quantity: newQuantity,
    unitPrice,
    subtotal: roundMoney(unitPrice * newQuantity),
    productSnapshot: productSnapshot(product),
  };
  if (existing) {
    existing.set(fields);
    await existing.save();
  } else {
    await CartItem.create({
      cartId: cart._id,
      productId: product._id,
      comboId: null,
      selectedSize,
      selectedUnit,
      comboSnapshot: null,
      ...fields,
    });
  }

  return sendCart(req, res, existing ? 200 : 201, existing ? "Cart item quantity updated" : "Product added to cart");
};

// @desc    Change quantity and/or size of a cart item (combo cart items only accept quantity)
// @route   PUT /api/cart/:itemId
// @access  cart.manage
export const updateCartItem = async (req: Request, res: Response) => {
  const { cart, item } = await findOwnItemOr404(req);
  const { quantity, size } = (req.body || {}) as Body;
  if (quantity === undefined && size === undefined) {
    throw new AppError('Send "quantity" and/or "size"', 400);
  }

  if (item.comboId) {
    if (size !== undefined) throw new AppError("Combo items do not have a size", 400);
    const qty = parseQuantity(quantity);
    const combo = await Combo.findById(item.comboId);
    if (!combo || !isComboLive(combo)) throw new AppError("Combo is not available", 400);
    await assertComboStockFor(req, cart._id, combo, qty, item._id);

    const members = await Product.find({ _id: { $in: combo.items.map((i) => i.productId) } });
    const byId = new Map(members.map((p) => [String(p._id), p]));

    const unitPrice = combo.comboPrice;
    item.set({
      quantity: qty,
      unitPrice,
      subtotal: roundMoney(unitPrice * qty),
      comboSnapshot: comboSnapshotFromDoc(combo, byId),
    });
    await item.save();
    return sendCart(req, res, 200, "Cart item updated");
  }

  const product = await loadPurchasableProduct(String(item.productId));
  const qty = quantity === undefined ? item.quantity : parseQuantity(quantity);
  const selectedSize =
    size === undefined ? item.selectedSize : resolveSelection(product, size, item.selectedUnit || undefined).selectedSize;

  if (selectedSize !== item.selectedSize) {
    const clash = await CartItem.exists({
      cartId: cart._id,
      productId: item.productId,
      selectedSize,
      selectedUnit: item.selectedUnit,
      _id: { $ne: item._id },
    });
    if (clash) throw new AppError("This product with the selected size is already in your cart", 409);
  }
  await assertStockFor(req, cart._id, product, qty, item._id);

  const unitPrice = getFinalPrice(product);
  item.set({
    quantity: qty,
    selectedSize,
    unitPrice,
    subtotal: roundMoney(unitPrice * qty),
    productSnapshot: productSnapshot(product),
  });
  await item.save();

  return sendCart(req, res, 200, "Cart item updated");
};

// @desc    Remove one item from my cart
// @route   DELETE /api/cart/:itemId
// @access  cart.manage
export const removeCartItem = async (req: Request, res: Response) => {
  const { item } = await findOwnItemOr404(req);
  await item.deleteOne();
  await sendCart(req, res, 200, "Item removed from cart");
};

// @desc    Remove all items from my cart
// @route   DELETE /api/cart
// @access  cart.manage
export const clearCart = async (req: Request, res: Response) => {
  const cart = await getOrCreateCart(getAuthUser(req)._id);
  await CartItem.deleteMany({ cartId: cart._id });
  await sendCart(req, res, 200, "Cart cleared");
};

// @desc    Re-check every item in my cart against current stock. Returns an
//          `ok` flag and a list of lines that would fail. Does not mutate the cart.
// @route   POST /api/cart/validate-stock
// @access  cart.manage
export const validateCartStock = async (req: Request, res: Response) => {
  const { cart, lines } = await loadCart(getAuthUser(req)._id);
  const issues: {
    cartItemId: Types.ObjectId;
    type: "product" | "combo" | "invalid";
    productId: Types.ObjectId | null;
    comboId: Types.ObjectId | null;
    productTitle: string;
    requested: number;
    available: number | null;
    issue: string;
  }[] = [];
  for (const line of lines) {
    if (!line.issue) continue;
    const title =
      line.product?.productTitle ||
      line.combo?.comboTitle ||
      line.item.productSnapshot?.productTitle ||
      line.item.comboSnapshot?.comboTitle ||
      "Item";
    issues.push({
      cartItemId: line.item._id,
      type: line.product ? "product" : line.combo ? "combo" : "invalid",
      productId: line.item.productId,
      comboId: line.item.comboId,
      productTitle: title,
      requested: line.item.quantity,
      available: line.product ? availableOf(line.product) : null,
      issue: line.issue,
    });
  }
  res.status(200).json({
    success: true,
    message: issues.length === 0 ? "All cart items are in stock" : "Some cart items are out of stock",
    data: { cartId: cart._id, ok: issues.length === 0, issues },
  });
};
