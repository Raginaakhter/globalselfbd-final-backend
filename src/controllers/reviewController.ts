import type { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import Review, { MAX_ASSOCIATED_PRODUCTS, REVIEW_STATUSES, type IReview, type ReviewStatus } from "../models/Review";
import ActivityLog from "../models/ActivityLog";
import Product from "../models/Product";
import Order from "../models/Order";
import OrderItem from "../models/OrderItem";
import User from "../models/User";
import AppError from "../utils/AppError";
import { getAuthUser } from "../middleware/auth";
import { logActivity } from "../utils/activityLog";
import { assertObjectId, escapeRegex, getPagination, isNonEmptyString, queryString } from "../utils/validators";
import { parseComment, parseRating, refreshRatingsOf, reviewableOrders, reviewsOfProduct } from "../utils/reviews";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const isReviewStatus = (value: unknown): value is ReviewStatus =>
  typeof value === "string" && (REVIEW_STATUSES as readonly string[]).includes(value);

// "Rahim Uddin" -> "Rahim U." (public pages never show the full name)
const publicName = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0] || "Customer";
};

// A product by ID or slug
const findProductOr404 = async (idOrSlug: string) => {
  const filter = mongoose.isValidObjectId(idOrSlug) ? { _id: idOrSlug } : { slug: String(idOrSlug).toLowerCase() };
  const product = await Product.findOne(filter).select("productTitle slug thumbnail status ratingAverage ratingCount").lean();
  if (!product) throw new AppError("Product not found", 404);
  return product;
};

// `forProductId`: the product page it is shown on. Verified purchase only for the product that was bought.
const publicReview = (r: IReview & { _id: Types.ObjectId }, forProductId?: Types.ObjectId) => ({
  _id: r._id,
  customerName: publicName(r.customerName),
  rating: r.rating,
  comment: r.comment,
  verifiedPurchase: !forProductId || String(r.productId) === String(forProductId),
  // Set when an admin attached this review from another product
  reviewedProduct: forProductId && String(r.productId) !== String(forProductId) ? r.productTitle : null,
  createdAt: r.createdAt,
});

/* ---------- Customer ---------- */

// @desc    Write a review for a product of one of my DELIVERED orders
// @route   POST /api/reviews   { orderId, productId, rating, comment }
// @access  reviews.create (logged-in customer; identity always from the token)
export const createReview = async (req: Request, res: Response) => {
  const customer = getAuthUser(req);
  const body = (req.body || {}) as Body;
  assertObjectId(body.orderId, "Order ID");
  assertObjectId(body.productId, "Product ID");
  const rating = parseRating(body.rating);
  const comment = parseComment(body.comment);

  // The order must be mine and delivered, and the product must be in it
  const order = await Order.findOne({ _id: body.orderId, customerId: customer._id }).select("orderNumber orderStatus").lean();
  if (!order) throw new AppError("Order not found", 404);
  if (order.orderStatus !== "DELIVERED") throw new AppError("You can review a product only after your order is delivered", 400);
  const item = await OrderItem.findOne({ orderId: order._id, productId: body.productId }).select("productTitleSnapshot thumbnailSnapshot").lean();
  if (!item) throw new AppError("This product is not part of that order", 400);

  const productId = new Types.ObjectId(String(body.productId));
  let review;
  try {
    review = await Review.create({
      customerId: customer._id,
      orderId: order._id,
      productId,
      orderNumber: order.orderNumber,
      customerName: customer.fullName,
      productTitle: item.productTitleSnapshot,
      productImage: item.thumbnailSnapshot ?? "",
      rating,
      comment,
    });
  } catch (error) {
    // The unique index stops a second review even if two requests arrive together
    if ((error as { code?: number }).code === 11000) throw new AppError("You have already reviewed this product for this order", 409);
    throw error;
  }

  await logActivity(req, {
    action: "REVIEW_CREATED",
    targetOrderId: order._id,
    targetUserId: customer._id,
    newValue: { reviewId: review._id, productId: body.productId, rating },
  });

  res.status(201).json({
    success: true,
    message: "Thank you! Your review was submitted and will appear after approval.",
    data: { _id: review._id, orderId: review.orderId, productId: review.productId, rating: review.rating, comment: review.comment, status: review.status, createdAt: review.createdAt },
  });
};

// @desc    Can I review this product? (delivered order containing it, not reviewed yet)
// @route   GET /api/reviews/eligibility?productId=...
// @access  Login required
export const getReviewEligibility = async (req: Request, res: Response) => {
  const productId = queryString(req.query.productId);
  const product = await findProductOr404(productId || "");
  const orders = await reviewableOrders(getAuthUser(req)._id, product._id);
  const open = orders.filter((o) => !o.reviewed);
  res.status(200).json({
    success: true,
    message: "Review eligibility",
    data: {
      eligible: open.length > 0,
      // Bought and delivered, but every delivered order of it is already reviewed
      alreadyReviewed: orders.length > 0 && open.length === 0,
      productId: product._id,
      // Send one of these as orderId when creating the review
      orders: open.map(({ orderId, orderNumber, deliveredAt }) => ({ orderId, orderNumber, deliveredAt })),
    },
  });
};

// @desc    My reviews (any status)
// @route   GET /api/reviews/my
// @access  Login required
export const getMyReviews = async (req: Request, res: Response) => {
  const reviews = await Review.find({ customerId: getAuthUser(req)._id })
    .select("orderId orderNumber productId productTitle productImage rating comment status createdAt")
    .sort({ createdAt: -1 })
    .lean();
  res.status(200).json({ success: true, message: "Your reviews", data: reviews });
};

/* ---------- Public ---------- */

// @desc    Reviews picked for the homepage carousel (APPROVED + showOnHomepage)
// @route   GET /api/reviews/homepage?limit=12
// @access  Public
export const getHomepageReviews = async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 12, 1), 30);
  const reviews = await Review.find({ status: "APPROVED", showOnHomepage: true }).sort({ updatedAt: -1 }).limit(limit).lean();
  const slugs = new Map(
    (await Product.find({ _id: { $in: reviews.map((r) => r.productId) } }).select("slug").lean()).map((p) => [String(p._id), p.slug])
  );
  res.status(200).json({
    success: true,
    message: "Homepage reviews",
    data: reviews.map((r) => ({
      ...publicReview(r),
      productId: r.productId,
      productName: r.productTitle,
      productImage: r.productImage,
      productSlug: slugs.get(String(r.productId)) ?? null,
    })),
  });
};

// @desc    Approved reviews of a product, with the rating summary
// @route   GET /api/products/:id/reviews?page=1&limit=10   (:id = product ID or slug)
// @access  Public
export const getProductReviews = async (req: Request, res: Response) => {
  const product = await findProductOr404(String(req.params.id));
  const { page, limit, skip } = getPagination(req.query, 50);
  const filter = { ...reviewsOfProduct(product._id), status: "APPROVED" as const };
  const [reviews, total, breakdown] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Review.countDocuments(filter),
    Review.aggregate<{ _id: number; count: number }>([{ $match: filter }, { $group: { _id: "$rating", count: { $sum: 1 } } }]),
  ]);
  res.status(200).json({
    success: true,
    message: "Product reviews",
    data: reviews.map((r) => publicReview(r, product._id)),
    summary: {
      averageRating: product.ratingAverage ?? 0,
      totalReviews: product.ratingCount ?? 0,
      // How many 5, 4, 3, 2 and 1 star reviews
      breakdown: Object.fromEntries([5, 4, 3, 2, 1].map((s) => [s, breakdown.find((b) => b._id === s)?.count || 0])),
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    A product's rating (approved reviews only)
// @route   GET /api/products/:id/rating
// @access  Public
export const getProductRating = async (req: Request, res: Response) => {
  const product = await findProductOr404(String(req.params.id));
  res.status(200).json({
    success: true,
    message: "Product rating",
    data: { productId: product._id, averageRating: product.ratingAverage ?? 0, totalReviews: product.ratingCount ?? 0 },
  });
};

/* ---------- Admin ---------- */

const findReviewOr404 = async (id: unknown) => {
  assertObjectId(id, "Review ID");
  const review = await Review.findById(id);
  if (!review) throw new AppError("Review not found", 404);
  return review;
};

// Admin view: customer email, the bought product and the products the review is attached to
const withCustomers = async (reviews: (IReview & { _id: Types.ObjectId })[]) => {
  const users = new Map(
    (await User.find({ _id: { $in: reviews.map((r) => r.customerId) } }).select("fullName email").lean()).map((u) => [String(u._id), u])
  );
  const productIds = reviews.flatMap((r) => [r.productId, ...(r.associatedProductIds || [])]);
  const products = new Map(
    (await Product.find({ _id: { $in: productIds } }).select("productTitle slug thumbnail status").lean()).map((p) => [String(p._id), p])
  );
  return reviews.map((r) => ({
    ...r,
    associatedProductIds: r.associatedProductIds || [],
    customerEmail: users.get(String(r.customerId))?.email ?? null,
    productSlug: products.get(String(r.productId))?.slug ?? null,
    // For "Tshirt +4 more"
    associatedProducts: (r.associatedProductIds || []).map((id) => products.get(String(id))).filter(Boolean),
  }));
};

// @desc    All reviews with counts per status
// @route   GET /api/admin/reviews?status=&search=&rating=&showOnHomepage=&productId=&sort=&page=&limit=
// @access  reviews.view
export const getAdminReviews = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const status = queryString(req.query.status);
  const search = queryString(req.query.search);
  const rating = queryString(req.query.rating);
  const onHomepage = queryString(req.query.showOnHomepage);
  const productId = queryString(req.query.productId);
  const sort = queryString(req.query.sort) || "newest";

  const filter: Record<string, unknown> = {};
  if (status) {
    if (!isReviewStatus(status)) throw new AppError(`status must be one of: ${REVIEW_STATUSES.join(", ")}`, 400);
    filter.status = status;
  }
  if (rating) filter.rating = parseRating(rating);
  if (onHomepage) {
    if (onHomepage !== "true" && onHomepage !== "false") throw new AppError("showOnHomepage must be true or false", 400);
    filter.showOnHomepage = onHomepage === "true";
  }
  if (productId) {
    assertObjectId(productId, "Product ID");
    filter.productId = productId;
  }
  if (isNonEmptyString(search)) {
    const re = new RegExp(escapeRegex(search.trim()), "i");
    const userIds = await User.find({ email: re }).distinct("_id");
    filter.$or = [{ customerName: re }, { productTitle: re }, { orderNumber: re }, { comment: re }, { customerId: { $in: userIds } }];
  }
  const SORTS: Record<string, Record<string, 1 | -1>> = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, ratingHigh: { rating: -1, createdAt: -1 }, ratingLow: { rating: 1, createdAt: -1 } };
  if (!SORTS[sort]) throw new AppError(`sort must be one of: ${Object.keys(SORTS).join(", ")}`, 400);

  const [reviews, total, counts, homepage] = await Promise.all([
    Review.find(filter).sort(SORTS[sort]).skip(skip).limit(limit).lean(),
    Review.countDocuments(filter),
    Review.aggregate<{ _id: ReviewStatus; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Review.countDocuments({ status: "APPROVED", showOnHomepage: true }),
  ]);
  const count = (s: ReviewStatus) => counts.find((c) => c._id === s)?.count || 0;
  res.status(200).json({
    success: true,
    message: "Reviews fetched successfully",
    data: await withCustomers(reviews),
    summary: {
      total: REVIEW_STATUSES.reduce((sum, s) => sum + count(s), 0),
      pending: count("PENDING"),
      approved: count("APPROVED"),
      rejected: count("REJECTED"),
      hidden: count("HIDDEN"),
      onHomepage: homepage,
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    One review
// @route   GET /api/admin/reviews/:id
// @access  reviews.view
export const getAdminReview = async (req: Request, res: Response) => {
  const review = await findReviewOr404(req.params.id);
  const [data] = await withCustomers([review.toObject()]);
  const [product, moderator, logs] = await Promise.all([
    Product.findById(review.productId).select("slug status ratingAverage ratingCount").lean(),
    review.moderatedBy ? User.findById(review.moderatedBy).select("fullName").lean() : null,
    // Everything that happened to this review (created, approved, hidden, attached products, ...)
    ActivityLog.find({ $or: [{ "newValue.reviewId": review._id }, { "oldValue.reviewId": review._id }] }).sort({ createdAt: 1 }).lean(),
  ]);
  const actors = new Map(
    (await User.find({ _id: { $in: logs.map((l) => l.actorUserId).filter(Boolean) } }).select("fullName").lean()).map((u) => [String(u._id), u.fullName])
  );
  res.status(200).json({
    success: true,
    message: "Review fetched successfully",
    data: {
      ...data,
      product,
      moderatedByName: moderator?.fullName ?? null,
      audit: logs.map((l) => ({
        action: l.action,
        by: l.actorUserId ? actors.get(String(l.actorUserId)) ?? null : null,
        oldValue: l.oldValue ?? null,
        newValue: l.newValue ?? null,
        at: l.createdAt,
      })),
    },
  });
};

const STATUS_ACTIONS = {
  APPROVED: "REVIEW_APPROVED",
  REJECTED: "REVIEW_REJECTED",
  HIDDEN: "REVIEW_HIDDEN",
  PENDING: "REVIEW_PENDING",
} as const;

// @desc    Approve / reject / hide a review (or put it back to pending)
// @route   PATCH /api/admin/reviews/:id/status   { status }
// @access  reviews.update
export const updateReviewStatus = async (req: Request, res: Response) => {
  const { status } = (req.body || {}) as Body;
  if (!isReviewStatus(status)) throw new AppError(`status must be one of: ${REVIEW_STATUSES.join(", ")}`, 400);
  const review = await findReviewOr404(req.params.id);
  const from = review.status;
  if (from === status) throw new AppError(`Review is already ${status}`, 400);

  review.status = status;
  // Only approved reviews can stay on the homepage
  if (status !== "APPROVED") review.showOnHomepage = false;
  review.moderatedBy = getAuthUser(req)._id;
  review.moderatedAt = new Date();
  await review.save();
  if (from === "APPROVED" || status === "APPROVED") await refreshRatingsOf(review);

  await logActivity(req, {
    action: STATUS_ACTIONS[status],
    targetOrderId: review.orderId,
    targetUserId: review.customerId,
    oldValue: { status: from },
    newValue: { reviewId: review._id, status },
  });
  const [data] = await withCustomers([review.toObject()]);
  res.status(200).json({ success: true, message: `Review ${status.toLowerCase()}`, data });
};

// @desc    Show or remove an approved review on the homepage carousel
// @route   PATCH /api/admin/reviews/:id/homepage   { showOnHomepage: true|false }
// @access  reviews.update
export const updateReviewHomepage = async (req: Request, res: Response) => {
  const { showOnHomepage } = (req.body || {}) as Body;
  if (typeof showOnHomepage !== "boolean") throw new AppError("showOnHomepage must be true or false", 400);
  const review = await findReviewOr404(req.params.id);
  if (showOnHomepage && review.status !== "APPROVED") throw new AppError("Only an approved review can be shown on the homepage", 400);
  if (review.showOnHomepage === showOnHomepage) throw new AppError(`Review is already ${showOnHomepage ? "on" : "off"} the homepage`, 400);

  review.showOnHomepage = showOnHomepage;
  await review.save();
  await logActivity(req, {
    action: showOnHomepage ? "REVIEW_HOMEPAGE_ENABLED" : "REVIEW_HOMEPAGE_DISABLED",
    targetOrderId: review.orderId,
    targetUserId: review.customerId,
    newValue: { reviewId: review._id, showOnHomepage },
  });
  const [data] = await withCustomers([review.toObject()]);
  res.status(200).json({ success: true, message: showOnHomepage ? "Review will show on the homepage" : "Review removed from the homepage", data });
};

// @desc    Delete a review
// @route   DELETE /api/admin/reviews/:id
// @access  reviews.delete
export const deleteReview = async (req: Request, res: Response) => {
  const review = await findReviewOr404(req.params.id);
  await review.deleteOne();
  if (review.status === "APPROVED") await refreshRatingsOf(review);
  await logActivity(req, {
    action: "REVIEW_DELETED",
    targetOrderId: review.orderId,
    targetUserId: review.customerId,
    oldValue: { reviewId: review._id, status: review.status, rating: review.rating, productTitle: review.productTitle },
  });
  res.status(200).json({ success: true, message: "Review deleted successfully", data: { _id: review._id } });
};

// @desc    Attach the review to other products (it also shows and counts on their pages)
// @route   PUT /api/admin/reviews/:id/products   { productIds: [...] }   (replaces the list; [] removes all)
// @access  reviews.update
export const updateReviewProducts = async (req: Request, res: Response) => {
  const { productIds } = (req.body || {}) as Body;
  if (!Array.isArray(productIds)) throw new AppError('Send "productIds": an array of product IDs ([] to remove all)', 400);
  const review = await findReviewOr404(req.params.id);
  const unique = [...new Set(productIds.map(String))].filter((id) => id !== String(review.productId));
  unique.forEach((id) => assertObjectId(id, "Product ID"));
  if (unique.length > MAX_ASSOCIATED_PRODUCTS) throw new AppError(`A review can be attached to at most ${MAX_ASSOCIATED_PRODUCTS} other products`, 400);
  if ((await Product.countDocuments({ _id: { $in: unique } })) !== unique.length) throw new AppError("One or more products were not found", 404);

  const before = review.associatedProductIds.map(String);
  review.associatedProductIds = unique.map((id) => new Types.ObjectId(id));
  await review.save();
  // Products added and removed both change when the review is approved
  if (review.status === "APPROVED") {
    await refreshRatingsOf({ productId: review.productId, associatedProductIds: [...new Set([...before, ...unique])].map((id) => new Types.ObjectId(id)) });
  }

  await logActivity(req, {
    action: "REVIEW_PRODUCTS_UPDATED",
    targetOrderId: review.orderId,
    targetUserId: review.customerId,
    oldValue: { reviewId: review._id, associatedProductIds: before },
    newValue: { reviewId: review._id, associatedProductIds: unique },
  });
  const [data] = await withCustomers([review.toObject()]);
  res.status(200).json({
    success: true,
    message: unique.length ? `Review attached to ${unique.length} other product(s)` : "Review is attached to its own product only",
    data,
  });
};
