import type { Request, Response } from "express";
import mongoose from "mongoose";
import AnalyticsEvent from "../models/AnalyticsEvent";
import AnalyticsVisitor from "../models/AnalyticsVisitor";
import AnalyticsSession from "../models/AnalyticsSession";
import AnalyticsDailySummary from "../models/AnalyticsDailySummary";
import Order from "../models/Order";
import Product from "../models/Product";
import AppError from "../utils/AppError";
import { assertObjectId, getPagination, queryString } from "../utils/validators";
import { resolveDateRange } from "../utils/analytics";

// Admin-only reporting endpoints. Every handler:
//   1. runs under requirePermission("analytics.view") (wired in the router);
//   2. normalizes the date range through resolveDateRange (preset or from/to);
//   3. returns a consistent { success, message, data[, pagination] } shape.
// Raw events are the source of truth; daily summaries are consulted only for
// long-horizon rollups where scanning raw rows would be expensive.

const SESSION_IDLE_MINUTES = Math.max(
  5,
  Number(process.env.ANALYTICS_SESSION_IDLE_MINUTES) || 30
);

const toActiveCutoff = (): Date =>
  new Date(Date.now() - SESSION_IDLE_MINUTES * 60 * 1000);

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/overview?preset=last7d
// ---------------------------------------------------------------------------
export const getOverview = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const dateMatch = { createdAt: { $gte: from, $lte: to } };

  const [
    visitorAgg,
    sessionAgg,
    eventAgg,
    activeVisitors,
    orderAgg,
    bounceAgg,
  ] = await Promise.all([
    AnalyticsEvent.aggregate<{ _id: null; uniqueVisitors: number; totalEvents: number }>([
      { $match: dateMatch },
      {
        $group: {
          _id: null,
          uniqueVisitors: { $addToSet: "$visitorId" },
          totalEvents: { $sum: 1 },
        },
      },
      { $project: { uniqueVisitors: { $size: "$uniqueVisitors" }, totalEvents: 1 } },
    ]),
    AnalyticsSession.aggregate<{ _id: null; sessions: number; totalDuration: number }>([
      { $match: { sessionStart: { $gte: from, $lte: to } } },
      { $group: { _id: null, sessions: { $sum: 1 }, totalDuration: { $sum: "$duration" } } },
    ]),
    AnalyticsEvent.aggregate<{ _id: string; count: number }>([
      { $match: dateMatch },
      { $group: { _id: "$eventName", count: { $sum: 1 } } },
    ]),
    AnalyticsSession.countDocuments({ lastActivity: { $gte: toActiveCutoff() } }),
    Order.aggregate<{ _id: null; orders: number; revenue: number }>([
      {
        $match: {
          orderStatus: "DELIVERED",
          paymentStatus: { $ne: "REFUNDED" },
          createdAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          revenue: {
            $sum: {
              $subtract: [
                { $subtract: ["$subtotal", "$discount"] },
                { $ifNull: ["$adminDiscountAmount", 0] },
              ],
            },
          },
        },
      },
    ]),
    AnalyticsSession.aggregate<{ _id: null; totalSessions: number; bounces: number }>([
      { $match: { sessionStart: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: null,
          totalSessions: { $sum: 1 },
          bounces: { $sum: { $cond: ["$isBounce", 1, 0] } },
        },
      },
    ]),
  ]);

  const eventCountFor = (name: string): number =>
    eventAgg.find((e) => e._id === name)?.count || 0;

  const visitors = visitorAgg[0]?.uniqueVisitors || 0;
  const sessions = sessionAgg[0]?.sessions || 0;
  const totalDuration = sessionAgg[0]?.totalDuration || 0;
  const orders = orderAgg[0]?.orders || 0;
  const revenue = Math.round((orderAgg[0]?.revenue || 0) * 100) / 100;
  const bounces = bounceAgg[0]?.bounces || 0;
  const bounceRate = sessions > 0 ? Math.round((bounces / sessions) * 10000) / 100 : 0;
  const avgSessionDuration = sessions > 0 ? Math.round(totalDuration / sessions) : 0;

  const pageViews = eventCountFor("page_view");
  const productViews = eventCountFor("product_view");
  const addToCart = eventCountFor("add_to_cart");
  const checkoutStarts = eventCountFor("checkout_start");
  const buttonClicks = eventCountFor("button_click") + eventCountFor("product_click") + eventCountFor("banner_click");

  // Returning visitors = those whose firstVisit predates the range AND fired
  // an event inside it.
  const returning = await AnalyticsEvent.aggregate<{ _id: null; returning: number }>([
    { $match: dateMatch },
    { $group: { _id: "$visitorId" } },
    {
      $lookup: {
        from: "analyticsvisitors",
        localField: "_id",
        foreignField: "visitorId",
        as: "v",
      },
    },
    { $unwind: "$v" },
    { $match: { "v.firstVisit": { $lt: from } } },
    { $group: { _id: null, returning: { $sum: 1 } } },
  ]);

  const returningVisitors = returning[0]?.returning || 0;
  const conversionRate = visitors > 0 ? Math.round((orders / visitors) * 10000) / 100 : 0;
  const cartAbandonmentRate =
    addToCart > 0
      ? Math.round(((addToCart - checkoutStarts) / addToCart) * 10000) / 100
      : 0;

  res.status(200).json({
    success: true,
    message: "Analytics overview retrieved successfully",
    data: {
      range: { from, to },
      visitors: {
        total: visitors,
        unique: visitors,
        returning: returningVisitors,
        active: activeVisitors,
      },
      sessions: {
        total: sessions,
        avgDurationSeconds: avgSessionDuration,
        bounceRate,
      },
      engagement: {
        pageViews,
        totalClicks: buttonClicks,
        productViews,
        addToCart,
        checkoutStarts,
      },
      sales: {
        completedOrders: orders,
        totalRevenue: revenue,
        conversionRate,
        cartAbandonmentRate,
      },
    },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/pages
// ---------------------------------------------------------------------------
export const getPages = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const { page, limit, skip } = getPagination(req.query as Record<string, unknown>);
  const sortField = queryString(req.query.sort) || "views";
  const sortDirection = queryString(req.query.direction) === "asc" ? 1 : -1;

  const sortKey: Record<string, string> = {
    views: "views",
    unique: "uniqueVisitors",
    sessions: "sessions",
    bounce: "bounceRate",
    time: "avgTimeOnPageSeconds",
  };
  const sortBy = sortKey[sortField] || "views";

  const pipeline: mongoose.PipelineStage[] = [
    { $match: { eventName: "page_view", createdAt: { $gte: from, $lte: to }, pagePath: { $ne: "" } } },
    {
      $group: {
        _id: "$pagePath",
        views: { $sum: 1 },
        uniqueVisitors: { $addToSet: "$visitorId" },
        sessions: { $addToSet: "$sessionId" },
        pageTitle: { $first: "$pageTitle" },
        lastSeen: { $max: "$createdAt" },
      },
    },
    {
      $project: {
        _id: 0,
        pagePath: "$_id",
        pageTitle: 1,
        views: 1,
        uniqueVisitors: { $size: "$uniqueVisitors" },
        sessions: { $size: "$sessions" },
        lastSeen: 1,
      },
    },
    { $sort: { [sortBy]: sortDirection, pagePath: 1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ];

  const [result] = await AnalyticsEvent.aggregate<{
    items: Array<{ pagePath: string; pageTitle: string; views: number; uniqueVisitors: number; sessions: number; lastSeen: Date }>;
    total: Array<{ n: number }>;
  }>(pipeline);

  // Entry / exit pages count from the Session collection (fast; already
  // denormalized onto each session).
  const paths = (result?.items || []).map((i) => i.pagePath);
  // Both entries and exits join on pagePath (short form). Previously exits
  // grouped on exitPage (full URL) which never matched any pagePath row and
  // reported 0 exits for everything. The new exitPagePath field keeps the
  // comparison apples-to-apples.
  const entryExit = paths.length
    ? await AnalyticsSession.aggregate<{ _id: string; entries: number; exits: number }>([
        {
          $match: {
            sessionStart: { $gte: from, $lte: to },
            $or: [{ entryPagePath: { $in: paths } }, { exitPagePath: { $in: paths } }],
          },
        },
        {
          $facet: {
            entries: [
              { $match: { entryPagePath: { $in: paths } } },
              { $group: { _id: "$entryPagePath", entries: { $sum: 1 } } },
            ],
            exits: [
              { $match: { exitPagePath: { $in: paths } } },
              { $group: { _id: "$exitPagePath", exits: { $sum: 1 } } },
            ],
          },
        },
        {
          $project: {
            rows: {
              $concatArrays: [
                { $map: { input: "$entries", as: "e", in: { _id: "$$e._id", entries: "$$e.entries", exits: 0 } } },
                { $map: { input: "$exits", as: "e", in: { _id: "$$e._id", entries: 0, exits: "$$e.exits" } } },
              ],
            },
          },
        },
        { $unwind: "$rows" },
        { $group: { _id: "$rows._id", entries: { $sum: "$rows.entries" }, exits: { $sum: "$rows.exits" } } },
      ])
    : [];
  const byPath = new Map(entryExit.map((r) => [r._id, r]));

  const total = result?.total?.[0]?.n || 0;
  const items = (result?.items || []).map((row) => {
    const ee = byPath.get(row.pagePath);
    const entries = ee?.entries || 0;
    const exits = ee?.exits || 0;
    // Bounce rate at page level — sessions that entered here AND bounced.
    const bounceRate = entries > 0 ? Math.min(100, Math.round((exits / entries) * 10000) / 100) : 0;
    return {
      pagePath: row.pagePath,
      pageTitle: row.pageTitle || "",
      totalViews: row.views,
      uniqueVisitors: row.uniqueVisitors,
      sessions: row.sessions,
      entries,
      exits,
      bounceRate,
      // Heuristic: average session duration / page views per session, if we
      // had it. For now expose sessions and views and let the UI derive.
      lastSeen: row.lastSeen,
    };
  });

  res.status(200).json({
    success: true,
    message: "Pages analytics retrieved successfully",
    data: items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/clicks
// ---------------------------------------------------------------------------
export const getClicks = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const { page, limit, skip } = getPagination(req.query as Record<string, unknown>);
  const pagePath = queryString(req.query.pagePath);

  const match: Record<string, unknown> = {
    eventName: { $in: ["button_click", "product_click", "banner_click", "filter_click", "sort_click", "category_click"] },
    createdAt: { $gte: from, $lte: to },
  };
  if (pagePath) match.pagePath = pagePath;

  const pipeline: mongoose.PipelineStage[] = [
    { $match: match },
    {
      $group: {
        _id: {
          elementId: "$elementId",
          elementName: "$elementName",
          buttonLabel: "$buttonLabel",
          pagePath: "$pagePath",
          productId: "$productId",
        },
        totalClicks: { $sum: 1 },
        uniqueVisitors: { $addToSet: "$visitorId" },
      },
    },
    {
      $project: {
        _id: 0,
        elementId: "$_id.elementId",
        elementName: "$_id.elementName",
        buttonLabel: "$_id.buttonLabel",
        pagePath: "$_id.pagePath",
        productId: "$_id.productId",
        totalClicks: 1,
        uniqueVisitors: { $size: "$uniqueVisitors" },
      },
    },
    { $sort: { totalClicks: -1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ];

  const [result] = await AnalyticsEvent.aggregate(pipeline);
  const total = result?.total?.[0]?.n || 0;

  res.status(200).json({
    success: true,
    message: "Clicks retrieved successfully",
    data: result?.items || [],
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

export const getTopElements = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);

  const rows = await AnalyticsEvent.aggregate([
    {
      $match: {
        eventName: { $in: ["button_click", "product_click", "banner_click", "filter_click", "sort_click", "category_click"] },
        createdAt: { $gte: from, $lte: to },
      },
    },
    {
      $group: {
        _id: { elementId: "$elementId", buttonLabel: "$buttonLabel" },
        totalClicks: { $sum: 1 },
        uniqueVisitors: { $addToSet: "$visitorId" },
      },
    },
    {
      $project: {
        _id: 0,
        elementId: "$_id.elementId",
        buttonLabel: "$_id.buttonLabel",
        totalClicks: 1,
        uniqueVisitors: { $size: "$uniqueVisitors" },
      },
    },
    { $sort: { totalClicks: -1 } },
    { $limit: limit },
  ]);

  res.status(200).json({
    success: true,
    message: "Top clicked elements retrieved successfully",
    data: rows,
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/products
// ---------------------------------------------------------------------------
export const getProductAnalytics = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const { page, limit, skip } = getPagination(req.query as Record<string, unknown>);

  const rows = await AnalyticsEvent.aggregate([
    {
      $match: {
        productId: { $ne: null },
        createdAt: { $gte: from, $lte: to },
      },
    },
    {
      $group: {
        _id: "$productId",
        views: { $sum: { $cond: [{ $eq: ["$eventName", "product_view"] }, 1, 0] } },
        clicks: { $sum: { $cond: [{ $eq: ["$eventName", "product_click"] }, 1, 0] } },
        addToCart: { $sum: { $cond: [{ $eq: ["$eventName", "add_to_cart"] }, 1, 0] } },
        wishlist: { $sum: { $cond: [{ $eq: ["$eventName", "wishlist_add"] }, 1, 0] } },
        uniqueVisitors: { $addToSet: "$visitorId" },
      },
    },
    {
      $project: {
        _id: 0,
        productId: "$_id",
        views: 1,
        clicks: 1,
        addToCart: 1,
        wishlist: 1,
        uniqueVisitors: { $size: "$uniqueVisitors" },
      },
    },
    { $sort: { views: -1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ]);

  const raw = rows[0]?.items || [];
  const total = rows[0]?.total?.[0]?.n || 0;

  const productIds = raw.map((r: { productId: mongoose.Types.ObjectId }) => r.productId);

  // Join Product + Order stats (purchases in range tied to this product).
  const [products, orderStats] = await Promise.all([
    productIds.length
      ? Product.find({ _id: { $in: productIds } })
          .select("productTitle slug thumbnail customerSellPrice customerSpecialPrice soldQuantity soldRevenue")
          .lean()
      : [],
    productIds.length
      ? Order.aggregate([
          {
            $match: {
              orderStatus: "DELIVERED",
              paymentStatus: { $ne: "REFUNDED" },
              createdAt: { $gte: from, $lte: to },
            },
          },
          {
            $lookup: {
              from: "orderitems",
              localField: "_id",
              foreignField: "orderId",
              as: "items",
            },
          },
          { $unwind: "$items" },
          { $match: { "items.productId": { $in: productIds } } },
          {
            $group: {
              _id: "$items.productId",
              purchases: { $sum: "$items.quantity" },
              revenue: { $sum: "$items.subtotal" },
            },
          },
        ])
      : [],
  ]);

  const productMap = new Map(products.map((p) => [String(p._id), p]));
  const orderMap = new Map(
    orderStats.map((r: { _id: mongoose.Types.ObjectId; purchases: number; revenue: number }) => [
      String(r._id),
      r,
    ])
  );

  const items = raw.map(
    (r: {
      productId: mongoose.Types.ObjectId;
      views: number;
      clicks: number;
      addToCart: number;
      wishlist: number;
      uniqueVisitors: number;
    }) => {
      const p = productMap.get(String(r.productId));
      const o = orderMap.get(String(r.productId));
      const purchases = o?.purchases || 0;
      const revenue = Math.round((o?.revenue || 0) * 100) / 100;
      const conversionRate = r.views > 0 ? Math.round((purchases / r.views) * 10000) / 100 : 0;
      return {
        productId: r.productId,
        productTitle: p?.productTitle || "",
        slug: p?.slug || "",
        thumbnail: p?.thumbnail || "",
        price: p?.customerSpecialPrice ?? p?.customerSellPrice ?? 0,
        views: r.views,
        clicks: r.clicks,
        addToCart: r.addToCart,
        wishlist: r.wishlist,
        uniqueVisitors: r.uniqueVisitors,
        purchases,
        revenue,
        conversionRate,
      };
    }
  );

  res.status(200).json({
    success: true,
    message: "Product analytics retrieved successfully",
    data: items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

export const getProductDetail = async (req: Request, res: Response) => {
  assertObjectId(req.params.productId, "productId");
  const productObjectId = new mongoose.Types.ObjectId(req.params.productId);
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);

  const [product, agg, orderAgg] = await Promise.all([
    Product.findById(productObjectId)
      .select("productTitle slug thumbnail customerSellPrice customerSpecialPrice soldQuantity soldRevenue")
      .lean(),
    AnalyticsEvent.aggregate([
      { $match: { productId: productObjectId, createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: null,
          views: { $sum: { $cond: [{ $eq: ["$eventName", "product_view"] }, 1, 0] } },
          clicks: { $sum: { $cond: [{ $eq: ["$eventName", "product_click"] }, 1, 0] } },
          addToCart: { $sum: { $cond: [{ $eq: ["$eventName", "add_to_cart"] }, 1, 0] } },
          removeFromCart: { $sum: { $cond: [{ $eq: ["$eventName", "remove_from_cart"] }, 1, 0] } },
          wishlist: { $sum: { $cond: [{ $eq: ["$eventName", "wishlist_add"] }, 1, 0] } },
          uniqueVisitors: { $addToSet: "$visitorId" },
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          orderStatus: "DELIVERED",
          paymentStatus: { $ne: "REFUNDED" },
          createdAt: { $gte: from, $lte: to },
        },
      },
      {
        $lookup: {
          from: "orderitems",
          localField: "_id",
          foreignField: "orderId",
          as: "items",
        },
      },
      { $unwind: "$items" },
      { $match: { "items.productId": productObjectId } },
      {
        $group: {
          _id: null,
          purchases: { $sum: "$items.quantity" },
          revenue: { $sum: "$items.subtotal" },
        },
      },
    ]),
  ]);

  if (!product) throw new AppError("Product not found", 404);

  const a = agg[0] || { views: 0, clicks: 0, addToCart: 0, removeFromCart: 0, wishlist: 0, uniqueVisitors: [] };
  const purchases = orderAgg[0]?.purchases || 0;
  const revenue = Math.round((orderAgg[0]?.revenue || 0) * 100) / 100;

  res.status(200).json({
    success: true,
    message: "Product analytics retrieved successfully",
    data: {
      productId: productObjectId,
      productTitle: product.productTitle,
      slug: product.slug,
      thumbnail: product.thumbnail,
      price: product.customerSpecialPrice ?? product.customerSellPrice,
      range: { from, to },
      views: a.views,
      clicks: a.clicks,
      addToCart: a.addToCart,
      removeFromCart: a.removeFromCart,
      wishlist: a.wishlist,
      uniqueVisitors: Array.isArray(a.uniqueVisitors) ? a.uniqueVisitors.length : 0,
      purchases,
      revenue,
      conversionRate: a.views > 0 ? Math.round((purchases / a.views) * 10000) / 100 : 0,
    },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/visitors
// ---------------------------------------------------------------------------
export const getVisitors = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query as Record<string, unknown>);
  const search = queryString(req.query.search);

  const filter: Record<string, unknown> = {};
  if (search) filter.visitorId = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const [visitors, total] = await Promise.all([
    AnalyticsVisitor.find(filter).sort({ lastVisit: -1 }).skip(skip).limit(limit).lean(),
    AnalyticsVisitor.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Visitors retrieved successfully",
    data: visitors,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

export const getVisitorDetail = async (req: Request, res: Response) => {
  const visitorId = String(req.params.visitorId);
  const visitor = await AnalyticsVisitor.findOne({ visitorId }).lean();
  if (!visitor) throw new AppError("Visitor not found", 404);

  const [sessions, recentEvents] = await Promise.all([
    AnalyticsSession.find({ visitorId }).sort({ sessionStart: -1 }).limit(20).lean(),
    AnalyticsEvent.find({ visitorId }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);

  res.status(200).json({
    success: true,
    message: "Visitor retrieved successfully",
    data: { visitor, sessions, recentEvents },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/active-visitors
// ---------------------------------------------------------------------------
export const getActiveVisitors = async (req: Request, res: Response) => {
  const cutoff = toActiveCutoff();
  const sessions = await AnalyticsSession.find({ lastActivity: { $gte: cutoff } })
    .sort({ lastActivity: -1 })
    .limit(Math.min(Math.max(Number(req.query.limit) || 100, 1), 500))
    .lean();

  res.status(200).json({
    success: true,
    message: "Active visitors retrieved successfully",
    data: {
      idleCutoff: cutoff,
      idleMinutes: SESSION_IDLE_MINUTES,
      count: sessions.length,
      sessions,
    },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/sessions
// ---------------------------------------------------------------------------
export const getSessions = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const { page, limit, skip } = getPagination(req.query as Record<string, unknown>);
  const activeOnly = queryString(req.query.active) === "true";

  const filter: Record<string, unknown> = { sessionStart: { $gte: from, $lte: to } };
  if (activeOnly) filter.lastActivity = { $gte: toActiveCutoff() };

  const [sessions, total] = await Promise.all([
    AnalyticsSession.find(filter).sort({ sessionStart: -1 }).skip(skip).limit(limit).lean(),
    AnalyticsSession.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Sessions retrieved successfully",
    data: sessions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

export const getSessionDetail = async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);
  const session = await AnalyticsSession.findOne({ sessionId }).lean();
  if (!session) throw new AppError("Session not found", 404);
  const events = await AnalyticsEvent.find({ sessionId }).sort({ createdAt: 1 }).lean();
  res.status(200).json({
    success: true,
    message: "Session retrieved successfully",
    data: { session, events },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/trends — daily timeseries
// ---------------------------------------------------------------------------
export const getTrends = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const rows = await AnalyticsDailySummary.find({ day: { $gte: from, $lte: to } })
    .sort({ day: 1 })
    .lean();
  res.status(200).json({
    success: true,
    message: "Trends retrieved successfully",
    data: { range: { from, to }, days: rows },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/funnel
// ---------------------------------------------------------------------------
export const getFunnel = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const dateMatch = { createdAt: { $gte: from, $lte: to } };

  // Unique visitors at each funnel stage.
  const [visitors, productViewers, addToCartUsers, checkoutUsers, paymentInitiated, orders] = await Promise.all([
    AnalyticsEvent.distinct("visitorId", dateMatch),
    AnalyticsEvent.distinct("visitorId", { ...dateMatch, eventName: "product_view" }),
    AnalyticsEvent.distinct("visitorId", { ...dateMatch, eventName: "add_to_cart" }),
    AnalyticsEvent.distinct("visitorId", { ...dateMatch, eventName: "checkout_start" }),
    AnalyticsEvent.distinct("visitorId", { ...dateMatch, eventName: "payment_initiated" }),
    Order.countDocuments({
      orderStatus: "DELIVERED",
      paymentStatus: { $ne: "REFUNDED" },
      createdAt: { $gte: from, $lte: to },
    }),
  ]);

  const stages = [
    { stage: "visitors", count: visitors.length },
    { stage: "productViewers", count: productViewers.length },
    { stage: "addToCart", count: addToCartUsers.length },
    { stage: "cartVisitors", count: addToCartUsers.length }, // same signal; UI can rename
    { stage: "checkoutStarted", count: checkoutUsers.length },
    { stage: "paymentInitiated", count: paymentInitiated.length },
    { stage: "purchased", count: orders }, // server-verified
  ];

  const enriched = stages.map((s, i) => {
    const prev = i > 0 ? stages[i - 1].count : s.count;
    const dropOff = prev > 0 ? Math.round(((prev - s.count) / prev) * 10000) / 100 : 0;
    const conversionFromStart = stages[0].count > 0 ? Math.round((s.count / stages[0].count) * 10000) / 100 : 0;
    return { ...s, dropOff, conversionFromStart };
  });

  res.status(200).json({
    success: true,
    message: "Funnel retrieved successfully",
    data: { range: { from, to }, stages: enriched },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/journeys — most common paths (first 5 pages)
// ---------------------------------------------------------------------------
export const getJourneys = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const topLimit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

  const rows = await AnalyticsEvent.aggregate([
    { $match: { eventName: "page_view", createdAt: { $gte: from, $lte: to } } },
    { $sort: { sessionId: 1, createdAt: 1 } },
    {
      $group: {
        _id: "$sessionId",
        path: { $push: "$pagePath" },
      },
    },
    { $project: { path: { $slice: ["$path", 5] } } },
    {
      $group: {
        _id: "$path",
        sessions: { $sum: 1 },
      },
    },
    { $sort: { sessions: -1 } },
    { $limit: topLimit },
    { $project: { _id: 0, path: "$_id", sessions: 1 } },
  ]);

  res.status(200).json({
    success: true,
    message: "Journeys retrieved successfully",
    data: rows,
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/sources
// ---------------------------------------------------------------------------
export const getSources = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);

  const rows = await AnalyticsSession.aggregate([
    { $match: { sessionStart: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: "$trafficSource",
        sessions: { $sum: 1 },
        visitors: { $addToSet: "$visitorId" },
      },
    },
    {
      $project: {
        _id: 0,
        source: "$_id",
        sessions: 1,
        uniqueVisitors: { $size: "$visitors" },
      },
    },
    { $sort: { sessions: -1 } },
  ]);

  // Join server-verified orders per source (via session UTM-source → order match).
  res.status(200).json({
    success: true,
    message: "Traffic sources retrieved successfully",
    data: rows,
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/devices
// ---------------------------------------------------------------------------
export const getDevices = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);

  const [byDevice, byBrowser, byOs] = await Promise.all([
    AnalyticsSession.aggregate([
      { $match: { sessionStart: { $gte: from, $lte: to } } },
      { $group: { _id: { $ifNull: ["$deviceType", "unknown"] }, sessions: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $project: { _id: 0, deviceType: "$_id", sessions: 1, uniqueVisitors: { $size: "$visitors" } } },
      { $sort: { sessions: -1 } },
    ]),
    AnalyticsSession.aggregate([
      { $match: { sessionStart: { $gte: from, $lte: to } } },
      { $group: { _id: { $ifNull: ["$browser", "unknown"] }, sessions: { $sum: 1 } } },
      { $project: { _id: 0, browser: "$_id", sessions: 1 } },
      { $sort: { sessions: -1 } },
    ]),
    AnalyticsSession.aggregate([
      { $match: { sessionStart: { $gte: from, $lte: to } } },
      { $group: { _id: { $ifNull: ["$operatingSystem", "unknown"] }, sessions: { $sum: 1 } } },
      { $project: { _id: 0, operatingSystem: "$_id", sessions: 1 } },
      { $sort: { sessions: -1 } },
    ]),
  ]);

  res.status(200).json({
    success: true,
    message: "Devices retrieved successfully",
    data: { byDevice, byBrowser, byOs },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/locations
// ---------------------------------------------------------------------------
export const getLocations = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const rows = await AnalyticsSession.aggregate([
    { $match: { sessionStart: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { country: { $ifNull: ["$country", "unknown"] }, city: { $ifNull: ["$city", "unknown"] } },
        sessions: { $sum: 1 },
        visitors: { $addToSet: "$visitorId" },
      },
    },
    { $project: { _id: 0, country: "$_id.country", city: "$_id.city", sessions: 1, uniqueVisitors: { $size: "$visitors" } } },
    { $sort: { sessions: -1 } },
    { $limit: 500 },
  ]);
  res.status(200).json({ success: true, message: "Locations retrieved successfully", data: rows });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/searches
// ---------------------------------------------------------------------------
export const getSearches = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const { page, limit, skip } = getPagination(req.query as Record<string, unknown>);

  const pipeline: mongoose.PipelineStage[] = [
    { $match: { eventName: "search", createdAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { $ifNull: ["$metadata.query", "$metadata.q"] },
        count: { $sum: 1 },
        noResultCount: {
          $sum: { $cond: [{ $eq: [{ $ifNull: ["$metadata.resultCount", 0] }, 0] }, 1, 0] },
        },
        uniqueVisitors: { $addToSet: "$visitorId" },
      },
    },
    { $match: { _id: { $nin: [null, ""] } } },
    {
      $project: {
        _id: 0,
        query: "$_id",
        count: 1,
        noResultCount: 1,
        uniqueVisitors: { $size: "$uniqueVisitors" },
      },
    },
    { $sort: { count: -1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ];

  const [result] = await AnalyticsEvent.aggregate(pipeline);
  const total = result?.total?.[0]?.n || 0;

  res.status(200).json({
    success: true,
    message: "Searches retrieved successfully",
    data: result?.items || [],
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/cart
// ---------------------------------------------------------------------------
export const getCartAnalytics = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);

  const [counts, byProduct] = await Promise.all([
    AnalyticsEvent.aggregate([
      {
        $match: {
          createdAt: { $gte: from, $lte: to },
          eventName: { $in: ["add_to_cart", "remove_from_cart", "checkout_start"] },
        },
      },
      { $group: { _id: "$eventName", count: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $project: { _id: 0, eventName: "$_id", count: 1, uniqueVisitors: { $size: "$visitors" } } },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          createdAt: { $gte: from, $lte: to },
          eventName: "add_to_cart",
          productId: { $ne: null },
        },
      },
      {
        $group: {
          _id: "$productId",
          additions: { $sum: 1 },
        },
      },
      { $sort: { additions: -1 } },
      { $limit: 20 },
    ]),
  ]);

  const added = counts.find((c) => c.eventName === "add_to_cart")?.count || 0;
  const removed = counts.find((c) => c.eventName === "remove_from_cart")?.count || 0;
  const checkoutStart = counts.find((c) => c.eventName === "checkout_start")?.count || 0;
  const abandonmentRate = added > 0 ? Math.round(((added - checkoutStart) / added) * 10000) / 100 : 0;

  res.status(200).json({
    success: true,
    message: "Cart analytics retrieved successfully",
    data: { added, removed, checkoutStart, abandonmentRate, topAddedProducts: byProduct },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/checkout
// ---------------------------------------------------------------------------
export const getCheckoutAnalytics = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);

  const rows = await AnalyticsEvent.aggregate([
    {
      $match: {
        createdAt: { $gte: from, $lte: to },
        eventName: { $in: ["checkout_start", "payment_initiated", "payment_success", "payment_failed"] },
      },
    },
    { $group: { _id: "$eventName", count: { $sum: 1 } } },
  ]);

  const get = (name: string): number => rows.find((r) => r._id === name)?.count || 0;

  // Server-verified orders in range:
  const orderCount = await Order.countDocuments({
    orderStatus: "DELIVERED",
    paymentStatus: { $ne: "REFUNDED" },
    createdAt: { $gte: from, $lte: to },
  });

  const paymentMethodMix = await Order.aggregate([
    {
      $match: {
        orderStatus: "DELIVERED",
        paymentStatus: { $ne: "REFUNDED" },
        createdAt: { $gte: from, $lte: to },
      },
    },
    { $group: { _id: "$paymentMethod", orders: { $sum: 1 } } },
    { $project: { _id: 0, paymentMethod: "$_id", orders: 1 } },
    { $sort: { orders: -1 } },
  ]);

  res.status(200).json({
    success: true,
    message: "Checkout analytics retrieved successfully",
    data: {
      checkoutStart: get("checkout_start"),
      paymentInitiated: get("payment_initiated"),
      paymentSuccessClient: get("payment_success"),
      paymentFailed: get("payment_failed"),
      verifiedOrders: orderCount,
      paymentMethodMix,
    },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/customers — identified users' event footprint
// ---------------------------------------------------------------------------
export const getCustomerAnalytics = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const { page, limit, skip } = getPagination(req.query as Record<string, unknown>);

  const pipeline: mongoose.PipelineStage[] = [
    { $match: { userId: { $ne: null }, createdAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: "$userId",
        totalEvents: { $sum: 1 },
        pageViews: { $sum: { $cond: [{ $eq: ["$eventName", "page_view"] }, 1, 0] } },
        addToCart: { $sum: { $cond: [{ $eq: ["$eventName", "add_to_cart"] }, 1, 0] } },
        checkoutStart: { $sum: { $cond: [{ $eq: ["$eventName", "checkout_start"] }, 1, 0] } },
        sessions: { $addToSet: "$sessionId" },
        lastSeen: { $max: "$createdAt" },
      },
    },
    { $sort: { lastSeen: -1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ];

  const [result] = await AnalyticsEvent.aggregate(pipeline);
  const rows = (result?.items || []).map(
    (r: {
      _id: mongoose.Types.ObjectId;
      totalEvents: number;
      pageViews: number;
      addToCart: number;
      checkoutStart: number;
      sessions: mongoose.Types.ObjectId[];
      lastSeen: Date;
    }) => ({
      userId: r._id,
      totalEvents: r.totalEvents,
      pageViews: r.pageViews,
      addToCart: r.addToCart,
      checkoutStart: r.checkoutStart,
      sessions: Array.isArray(r.sessions) ? r.sessions.length : 0,
      lastSeen: r.lastSeen,
    })
  );
  const total = result?.total?.[0]?.n || 0;

  res.status(200).json({
    success: true,
    message: "Customer analytics retrieved successfully",
    data: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/export — CSV of raw events (date-range capped)
// Permission: analytics.export
// ---------------------------------------------------------------------------
export const exportEvents = async (req: Request, res: Response) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const cap = Math.min(Math.max(Number(req.query.limit) || 10_000, 100), 100_000);

  const cursor = AnalyticsEvent.find({ createdAt: { $gte: from, $lte: to } })
    .sort({ createdAt: -1 })
    .limit(cap)
    .lean()
    .cursor();

  const filename = `analytics-events-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  // CSV header
  const columns = [
    "createdAt", "eventName", "eventCategory", "visitorId", "sessionId",
    "userId", "pagePath", "productId", "elementId", "buttonLabel",
    "deviceType", "browser", "operatingSystem", "country", "city",
    "trafficSource", "utmSource", "utmMedium", "utmCampaign",
  ];
  res.write(columns.join(",") + "\n");

  const esc = (v: unknown): string => {
    if (v === undefined || v === null) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  for await (const row of cursor) {
    res.write(
      columns
        .map((c) => {
          const v = (row as unknown as Record<string, unknown>)[c];
          return esc(v instanceof Date ? v.toISOString() : v);
        })
        .join(",") + "\n"
    );
  }
  res.end();
};
