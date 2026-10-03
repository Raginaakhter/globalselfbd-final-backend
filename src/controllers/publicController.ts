import type { Request, Response } from "express";
import mongoose, { type Types } from "mongoose";
import Product from "../models/Product";
import type { CategoryDocument } from "../models/Category";
import Combo from "../models/Combo";
import Offer, { offerState, type IOffer } from "../models/Offer";
import AppError from "../utils/AppError";
import { toProductResponse, type ProductLike } from "../utils/productView";
import { loadCategoryMap, getAncestry, getVisibleCategoryIds } from "../utils/categoryTree";
import { getPagination, isNonEmptyString, queryString, escapeRegex } from "../utils/validators";
import { toComboItemDetails, toComboResponse } from "../utils/combos";
import { listProducts } from "./productController";

// Customer-facing storefront API: no login needed.
// Only ACTIVE items are shown, and stock numbers / product cost are never included.
const CUSTOMER_VIEW = {};

interface TreeNode {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  imageUrl: string | null;
  description: string;
  parentCategoryId: Types.ObjectId | null;
  children: TreeNode[];
}

// @desc    Active category tree for the storefront menu
// @route   GET /api/public/categories
// @access  Public
export const getPublicCategories = async (req: Request, res: Response) => {
  const map = await loadCategoryMap();
  const visible = new Set((await getVisibleCategoryIds()).map(String));

  const nodes = new Map<string, TreeNode>(
    [...map.values()]
      .filter((c) => visible.has(String(c._id)))
      .map((c) => [
        String(c._id),
        {
          _id: c._id,
          name: c.name,
          slug: c.slug,
          imageUrl: c.imageUrl,
          description: c.description,
          parentCategoryId: c.parentCategoryId,
          children: [],
        },
      ])
  );

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentCategoryId ? nodes.get(String(node.parentCategoryId)) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortTree = (list: TreeNode[]): TreeNode[] => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((n) => sortTree(n.children));
    return list;
  };

  res.status(200).json({
    success: true,
    message: "Categories fetched successfully",
    data: sortTree(roots),
  });
};

// @desc    Active products for the storefront (filters, search, sort, pagination)
// @route   GET /api/public/products
// @access  Public
export const getPublicProducts = async (req: Request, res: Response) => {
  const result = await listProducts(req, CUSTOMER_VIEW);
  res.status(200).json({ success: true, message: "Products fetched successfully", ...result });
};

// @desc    Active combos for the storefront
// @route   GET /api/public/combos
// @access  Public
export const getPublicCombos = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const now = new Date();

  const filter: Record<string, unknown> = {
    status: "ACTIVE",
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
    ],
  };
  if (isNonEmptyString(search)) {
    filter.comboTitle = new RegExp(escapeRegex(search.trim()), "i");
  }

  const [combos, total] = await Promise.all([
    Combo.find(filter).sort({ displayOrder: 1, createdAt: -1 }).skip(skip).limit(limit),
    Combo.countDocuments(filter),
  ]);

  const productIds = [...new Set(combos.flatMap((c) => c.items.map((i) => String(i.productId))))];
  const products = await Product.find({ _id: { $in: productIds }, status: "ACTIVE" });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const data = combos.map((combo) => {
    const details = toComboItemDetails(
      combo.items
        .map((i) => {
          const product = byId.get(String(i.productId));
          return product ? { product, quantity: i.quantity } : null;
        })
        .filter((x): x is { product: typeof products[number]; quantity: number } => x !== null)
    );
    return toComboResponse(combo, { memberDetails: details });
  });

  res.status(200).json({
    success: true,
    message: "Combos fetched successfully",
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    One active combo by slug
// @route   GET /api/public/combos/:slug
// @access  Public
export const getPublicCombo = async (req: Request, res: Response) => {
  const combo = await Combo.findOne({ slug: String(req.params.slug).toLowerCase() });
  if (!combo || combo.status !== "ACTIVE") throw new AppError("Combo not found", 404);
  const now = new Date();
  if (combo.startsAt && combo.startsAt > now) throw new AppError("Combo not found", 404);
  if (combo.endsAt && combo.endsAt <= now) throw new AppError("Combo not found", 404);

  // Track view (fire-and-forget; never fails the request)
  Combo.updateOne({ _id: combo._id }, { $inc: { views: 1 } }).catch(() => undefined);

  const products = await Product.find({ _id: { $in: combo.items.map((i) => i.productId) }, status: "ACTIVE" });
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const details = toComboItemDetails(
    combo.items
      .map((i) => {
        const product = byId.get(String(i.productId));
        return product ? { product, quantity: i.quantity } : null;
      })
      .filter((x): x is { product: typeof products[number]; quantity: number } => x !== null)
  );

  res.status(200).json({
    success: true,
    message: "Combo fetched successfully",
    data: toComboResponse(combo, { memberDetails: details }),
  });
};

// @desc    Active offer campaigns for the storefront
// @route   GET /api/public/offers
// @access  Public
export const getPublicOffers = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const now = new Date();
  const filter: Record<string, unknown> = { status: "ACTIVE", startsAt: { $lte: now }, endsAt: { $gt: now } };

  const [offers, total] = await Promise.all([
    Offer.find(filter)
      .sort({ displayOrder: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("_id title slug description bannerImage badgeColor badgeLabel discountType discountValue startsAt endsAt minOrderValue displayOrder status productIds categoryIds")
      .lean(),
    Offer.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Offers fetched successfully",
    data: offers.map((o) => ({
      ...o,
      state: offerState(o as IOffer),
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    One active offer by slug (with product details)
// @route   GET /api/public/offers/:slug
// @access  Public
export const getPublicOffer = async (req: Request, res: Response) => {
  const now = new Date();
  const offer = await Offer.findOne({
    slug: String(req.params.slug).toLowerCase(),
    status: "ACTIVE",
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  });
  if (!offer) throw new AppError("Offer not found", 404);

  const visible = (await getVisibleCategoryIds()).map(String);
  const productFilter: Record<string, unknown> = { status: "ACTIVE", categoryId: { $in: visible.map((id) => new mongoose.Types.ObjectId(id)) } };
  const or: Record<string, unknown>[] = [];
  if (offer.productIds.length) or.push({ _id: { $in: offer.productIds } });
  if (offer.categoryIds.length) or.push({ categoryId: { $in: offer.categoryIds } });
  if (or.length) productFilter.$or = or;

  const products = or.length
    ? await Product.find(productFilter).populate<{ categoryId: Pick<CategoryDocument, "_id" | "name" | "slug" | "status"> | null }>("categoryId", "name slug status")
    : [];

  res.status(200).json({
    success: true,
    message: "Offer fetched successfully",
    data: {
      ...offer.toObject(),
      state: offerState(offer),
      products: products.map((p) => toProductResponse(p as unknown as { toObject(): ProductLike }, {})),
    },
  });
};

// @desc    One active product by slug (product details page)
// @route   GET /api/public/products/:slug
// @access  Public
export const getPublicProduct = async (req: Request, res: Response) => {
  const product = await Product.findOne({ slug: String(req.params.slug).toLowerCase(), status: "ACTIVE" }).populate<{
    categoryId: Pick<CategoryDocument, "_id" | "name" | "slug" | "status"> | null;
  }>("categoryId", "name slug status");
  const visible = (await getVisibleCategoryIds()).map(String);
  if (!product || !product.categoryId || !visible.includes(String(product.categoryId._id))) {
    throw new AppError("Product not found", 404);
  }

  const map = await loadCategoryMap();
  res.status(200).json({
    success: true,
    message: "Product fetched successfully",
    data: {
      ...toProductResponse(product as unknown as { toObject(): ProductLike }, CUSTOMER_VIEW),
      breadcrumb: getAncestry(product.categoryId._id, map).map((c) => ({ _id: c._id, name: c.name, slug: c.slug })),
    },
  });
};
