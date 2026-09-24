import type { Request, Response } from "express";
import type { Types } from "mongoose";
import Product from "../models/Product";
import type { CategoryDocument } from "../models/Category";
import AppError from "../utils/AppError";
import { toProductResponse, type ProductLike } from "../utils/productView";
import { loadCategoryMap, getAncestry, getVisibleCategoryIds } from "../utils/categoryTree";
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
