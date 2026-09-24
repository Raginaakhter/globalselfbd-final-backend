import type { Request, Response } from "express";
import type { Types } from "mongoose";
import Product, { type ProductDocument } from "../models/Product";
import CartItem from "../models/CartItem";
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
  loadCart,
  toCartResponse,
} from "../utils/checkout";
import { getAuthUser } from "../middleware/auth";
import { CART_LIMITS } from "../config/orderOptions";

// Note: Express 5 forwards errors thrown in async handlers to the error handler
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
  if (product.stock <= 0) throw new AppError("Product is out of stock", 400);
  return product;
};

// Total quantity of this product in the cart after the change must fit in stock.
// The customer only sees "Insufficient product stock", never the number.
const assertStockFor = async (
  cartId: Types.ObjectId,
  product: ProductDocument,
  newQuantity: number,
  excludeItemId?: Types.ObjectId
): Promise<void> => {
  const filter: Record<string, unknown> = { cartId, productId: product._id };
  if (excludeItemId) filter._id = { $ne: excludeItemId };
  const others = await CartItem.find(filter).select("quantity");
  const total = others.reduce((sum, i) => sum + i.quantity, 0) + newQuantity;
  if (total > product.stock) throw new AppError("Insufficient product stock", 400);
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

// @desc    Get my cart (prices refreshed from current products)
// @route   GET /api/cart
// @access  cart.manage
export const getCart = (req: Request, res: Response) => sendCart(req, res, 200, "Cart fetched successfully");

// @desc    Add a product to my cart (same product + size is merged)
// @route   POST /api/cart
// @access  cart.manage
export const addToCart = async (req: Request, res: Response) => {
  const { productId, quantity = 1, size, unit } = (req.body || {}) as Body;
  const qty = parseQuantity(quantity);
  const product = await loadPurchasableProduct(productId);
  const { selectedSize, selectedUnit } = resolveSelection(product, size, unit);

  const cart = await getOrCreateCart(getAuthUser(req)._id);
  const existing = await CartItem.findOne({ cartId: cart._id, productId: product._id, selectedSize, selectedUnit });
  const newQuantity = (existing ? existing.quantity : 0) + qty;

  if (newQuantity > CART_LIMITS.MAX_QUANTITY_PER_ITEM) {
    throw new AppError(`You can add at most ${CART_LIMITS.MAX_QUANTITY_PER_ITEM} of one item`, 400);
  }
  if (!existing && (await CartItem.countDocuments({ cartId: cart._id })) >= CART_LIMITS.MAX_ITEMS) {
    throw new AppError(`Your cart can hold at most ${CART_LIMITS.MAX_ITEMS} different items`, 400);
  }
  await assertStockFor(cart._id, product, newQuantity, existing?._id);

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
    await CartItem.create({ cartId: cart._id, productId: product._id, selectedSize, selectedUnit, ...fields });
  }

  await sendCart(req, res, existing ? 200 : 201, existing ? "Cart item quantity updated" : "Product added to cart");
};

// @desc    Change quantity and/or size of a cart item
// @route   PUT /api/cart/:itemId
// @access  cart.manage
export const updateCartItem = async (req: Request, res: Response) => {
  const { cart, item } = await findOwnItemOr404(req);
  const { quantity, size } = (req.body || {}) as Body;
  if (quantity === undefined && size === undefined) {
    throw new AppError('Send "quantity" and/or "size"', 400);
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
  await assertStockFor(cart._id, product, qty, item._id);

  const unitPrice = getFinalPrice(product);
  item.set({
    quantity: qty,
    selectedSize,
    unitPrice,
    subtotal: roundMoney(unitPrice * qty),
    productSnapshot: productSnapshot(product),
  });
  await item.save();

  await sendCart(req, res, 200, "Cart item updated");
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
