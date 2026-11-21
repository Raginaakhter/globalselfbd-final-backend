import type { Request, Response } from "express";
import AnalyticsEvent, {
  type AnalyticsEventName,
} from "../models/AnalyticsEvent";
import AnalyticsVisitor from "../models/AnalyticsVisitor";
import AnalyticsSession from "../models/AnalyticsSession";
import AnalyticsDailySummary from "../models/AnalyticsDailySummary";
import AppError from "../utils/AppError";
import {
  assertVisitorId,
  assertSessionId,
  buildContextFromBody,
  buildDedupeKey,
  categoryFor,
  DEDUPE_WINDOW_MS,
  extractPath,
  isAnalyticsEventName,
  optionalObjectId,
  sanitizeMetadata,
  utcDayKey,
} from "../utils/analytics";

// Public-facing ingestion endpoints. These accept traffic directly from the
// storefront and MUST NOT:
//   - trust any field as proof of a business event (e.g. a client "purchase"
//     event is dropped — the server reconciles purchases from Order rows);
//   - log or persist PII from metadata (sanitizeMetadata enforces this);
//   - echo back internal data in errors.
//
// They MAY:
//   - trust the opaque visitorId/sessionId strings for aggregation grouping
//     (they're not secrets, just stable keys the client assigns itself).

type Body = Record<string, unknown>;

const BATCH_MAX = 50;
const SESSION_IDLE_MINUTES = Math.max(
  5,
  Number(process.env.ANALYTICS_SESSION_IDLE_MINUTES) || 30
);

// Field map between event names and the daily summary counter they
// increment. Keeps the summary update one-step with a pre-built $inc object.
const SUMMARY_COUNTER_FOR: Partial<Record<AnalyticsEventName, string>> = {
  page_view: "pageViews",
  product_view: "productViews",
  product_click: "productClicks",
  add_to_cart: "addToCart",
  remove_from_cart: "removeFromCart",
  wishlist_add: "wishlistAdds",
  search: "searches",
  checkout_start: "checkoutStarts",
  payment_initiated: "paymentsInitiated",
  payment_success: "paymentsSuccess",
  payment_failed: "paymentsFailed",
};

// ---------------------------------------------------------------------------
// Shared dedupe check — short-window, same (event + visitor + anchor).
// Anchor is whatever makes the event "the same" conceptually:
//   - product_view → productId
//   - page_view    → pagePath
//   - button_click → elementId or buttonLabel
//   - fallback     → pagePath
// ---------------------------------------------------------------------------
async function isDuplicate(dedupeKey: string): Promise<boolean> {
  const recent = await AnalyticsEvent.exists({
    dedupeKey,
    createdAt: { $gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
  });
  return Boolean(recent);
}

function anchorFor(
  eventName: AnalyticsEventName,
  body: { productId?: unknown; elementId?: unknown; buttonLabel?: unknown; pagePath?: string }
): string {
  if (eventName === "product_view" || eventName === "product_click") {
    return String(body.productId || "");
  }
  if (eventName === "button_click" || eventName === "banner_click" || eventName === "filter_click" || eventName === "sort_click") {
    return String(body.elementId || body.buttonLabel || body.pagePath || "");
  }
  return String(body.pagePath || "");
}

// ---------------------------------------------------------------------------
// Visitor / session upsert. Called whenever an event arrives; ensures both
// rows exist with first-touch attribution frozen on creation, and lastVisit
// / lastActivity kept fresh.
// ---------------------------------------------------------------------------
async function touchVisitor(
  visitorId: string,
  ctx: ReturnType<typeof buildContextFromBody>,
  userId: ReturnType<typeof optionalObjectId>,
  pageViewDelta: number,
  eventDelta: number
): Promise<void> {
  const now = new Date();
  await AnalyticsVisitor.updateOne(
    { visitorId },
    {
      $setOnInsert: {
        visitorId,
        firstVisit: now,
        firstTrafficSource: ctx.trafficSource,
        firstUtmSource: ctx.utmSource,
        firstUtmMedium: ctx.utmMedium,
        firstUtmCampaign: ctx.utmCampaign,
        firstReferrer: ctx.referrer,
      },
      $set: {
        lastVisit: now,
        deviceType: ctx.deviceType,
        browser: ctx.browser,
        operatingSystem: ctx.operatingSystem,
        country: ctx.country,
        city: ctx.city,
        ...(userId ? { userId } : {}),
      },
      $inc: {
        totalPageViews: pageViewDelta,
        totalEvents: eventDelta,
      },
    },
    { upsert: true }
  );
}

async function touchSession(
  sessionId: string,
  visitorId: string,
  ctx: ReturnType<typeof buildContextFromBody>,
  userId: ReturnType<typeof optionalObjectId>,
  pageViewDelta: number,
  eventDelta: number,
  options: { willBounce?: boolean; resurrect?: boolean } = {}
): Promise<boolean> {
  const now = new Date();
  // Resurrect semantics: when `sendBeacon` fires /session/end on a page
  // navigation that turns out to be a round-trip (payment gateway redirect,
  // soft page reload, a fast back-forward cache restore), the client's
  // sessionStorage still holds the same sessionId and a follow-up event
  // arrives against a server-side session that has sessionEnd set and
  // isActive=false. Treating that as a brand-new session discards the
  // original sessionStart (duration restarts, first-touch attribution is
  // lost). Reopening the same row keeps the original start, so duration
  // measures the whole visit. Called with resurrect=true from paths that
  // are an explicit "user is here" signal: /session/start and /events.
  // Heartbeats never resurrect — a backgrounded tab must not keep an ended
  // session alive.
  const setFields: Record<string, unknown> = {
    lastActivity: now,
    currentPage: ctx.pageUrl || undefined,
    exitPage: ctx.pageUrl || undefined,
    exitPagePath: ctx.pagePath || undefined,
    deviceType: ctx.deviceType,
    browser: ctx.browser,
    operatingSystem: ctx.operatingSystem,
    country: ctx.country,
    city: ctx.city,
    ...(userId ? { userId } : {}),
    // Any engagement beyond a single page_view ends the bounce classification.
    ...(options.willBounce === false ? { isBounce: false } : {}),
  };
  if (options.resurrect) {
    setFields.sessionEnd = null;
    setFields.isActive = true;
    // `duration` is left stale; endSession recomputes it from sessionStart
    // whenever the session is next closed.
  }

  // Note: `isActive` lives ONLY in $set here (when resurrect: true) or
  // falls back to the schema default (also true) on insert. Keeping it in
  // both $setOnInsert and $set triggers MongoDB's path-conflict error and
  // the whole update is rejected — which would silently 500 every event
  // ingestion. The schema default handles the insert case.
  const update = {
    $setOnInsert: {
      sessionId,
      visitorId,
      sessionStart: now,
      entryPage: ctx.pageUrl,
      entryPagePath: ctx.pagePath,
      trafficSource: ctx.trafficSource,
      utmSource: ctx.utmSource,
      utmMedium: ctx.utmMedium,
      utmCampaign: ctx.utmCampaign,
      referrer: ctx.referrer,
    },
    $set: setFields,
    $inc: {
      pageViews: pageViewDelta,
      totalEvents: eventDelta,
    },
  };
  const result = await AnalyticsSession.updateOne({ sessionId }, update, { upsert: true });
  const wasNew = (result.upsertedCount ?? 0) > 0;
  if (wasNew) {
    await AnalyticsVisitor.updateOne({ visitorId }, { $inc: { totalSessions: 1 } });
  }
  return wasNew;
}

// Increment one day-bucket counter per event. $setOnInsert is used for the
// `day` field so the upsert never overwrites an existing day's breakdown.
async function bumpDailySummary(
  eventName: AnalyticsEventName,
  when: Date,
  ctx: Pick<ReturnType<typeof buildContextFromBody>, "deviceType" | "trafficSource" | "country">,
  isNewSession: boolean
): Promise<void> {
  const day = utcDayKey(when);
  const inc: Record<string, number> = { events: 1 };
  const counter = SUMMARY_COUNTER_FOR[eventName];
  if (counter) inc[counter] = 1;
  if (isNewSession) inc.sessions = 1;
  if (ctx.deviceType) inc[`byDevice.${sanitizeKey(ctx.deviceType)}`] = 1;
  if (ctx.trafficSource) inc[`bySource.${sanitizeKey(ctx.trafficSource)}`] = 1;
  if (ctx.country) inc[`byCountry.${sanitizeKey(ctx.country)}`] = 1;

  await AnalyticsDailySummary.updateOne(
    { day },
    {
      $setOnInsert: { day },
      $set: { lastUpdatedAt: new Date() },
      $inc: inc,
    },
    { upsert: true }
  );
}

function sanitizeKey(key: string): string {
  // Mongo field names can't contain '.' or start with '$'. Strip to a safe set.
  return key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "unknown";
}

// ---------------------------------------------------------------------------
// POST /api/analytics/events  — batch or single event
// Body: { visitorId, sessionId, events: [ { eventName, ... } ] }
// OR    { visitorId, sessionId, eventName, ... }  (single)
// ---------------------------------------------------------------------------
export const ingestEvents = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const visitorId = assertVisitorId(body.visitorId);
  const sessionId = assertSessionId(body.sessionId);
  const userId = optionalObjectId(body.userId);

  const list: Body[] = Array.isArray(body.events)
    ? (body.events as Body[])
    : [body];
  if (list.length === 0) throw new AppError("events must contain at least one entry", 400);
  if (list.length > BATCH_MAX) {
    throw new AppError(`events batch cannot exceed ${BATCH_MAX}`, 400);
  }

  const summary = {
    accepted: 0,
    dropped: 0,
    duplicates: 0,
    reasons: [] as string[],
  };

  for (const raw of list) {
    const eventName = raw.eventName;
    if (!isAnalyticsEventName(eventName)) {
      summary.dropped += 1;
      summary.reasons.push("unknown-event-name");
      continue;
    }
    // Hard block: purchase events only come from the server-side reconciler.
    if (eventName === "purchase") {
      summary.dropped += 1;
      summary.reasons.push("purchase-client-not-trusted");
      continue;
    }

    const perEventBody = { ...body, ...raw } as Body;
    const ctx = buildContextFromBody(req, perEventBody);
    const anchor = anchorFor(eventName, {
      productId: perEventBody.productId,
      elementId: perEventBody.elementId,
      buttonLabel: perEventBody.buttonLabel,
      pagePath: ctx.pagePath,
    });
    const dedupeKey = buildDedupeKey(eventName, visitorId, anchor);
    if (await isDuplicate(dedupeKey)) {
      summary.duplicates += 1;
      continue;
    }

    const metadata = sanitizeMetadata(perEventBody.metadata);
    const now = new Date();
    const pageViewDelta = eventName === "page_view" ? 1 : 0;
    const bounceReset = eventName !== "page_view";

    const [, isNewSession] = await Promise.all([
      touchVisitor(visitorId, ctx, userId, pageViewDelta, 1),
      touchSession(sessionId, visitorId, ctx, userId, pageViewDelta, 1, {
        willBounce: bounceReset ? false : undefined,
        // An incoming event is unambiguous proof the user is active, so an
        // event against an ended session reopens it instead of recording
        // against a zombie row.
        resurrect: true,
      }),
    ]);

    await AnalyticsEvent.create({
      eventName,
      eventCategory: categoryFor(eventName),
      visitorId,
      sessionId,
      userId,
      pageUrl: ctx.pageUrl,
      pagePath: ctx.pagePath,
      pageTitle: ctx.pageTitle,
      referrer: ctx.referrer,
      elementId: typeof perEventBody.elementId === "string" ? perEventBody.elementId.slice(0, 200) : "",
      elementName: typeof perEventBody.elementName === "string" ? perEventBody.elementName.slice(0, 200) : "",
      buttonLabel: typeof perEventBody.buttonLabel === "string" ? perEventBody.buttonLabel.slice(0, 200) : "",
      productId: optionalObjectId(perEventBody.productId),
      categoryId: optionalObjectId(perEventBody.categoryId),
      orderId: null,
      deviceType: ctx.deviceType,
      browser: ctx.browser,
      operatingSystem: ctx.operatingSystem,
      country: ctx.country,
      city: ctx.city,
      trafficSource: ctx.trafficSource,
      utmSource: ctx.utmSource,
      utmMedium: ctx.utmMedium,
      utmCampaign: ctx.utmCampaign,
      utmTerm: ctx.utmTerm,
      utmContent: ctx.utmContent,
      metadata,
      dedupeKey,
      createdAt: now,
    });

    await bumpDailySummary(eventName, now, ctx, isNewSession);
    summary.accepted += 1;
  }

  res.status(200).json({
    success: true,
    message: "Events processed",
    data: summary,
  });
};

// ---------------------------------------------------------------------------
// POST /api/analytics/page-view — convenience wrapper
// ---------------------------------------------------------------------------
export const ingestPageView = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  (body as Body).eventName = "page_view";
  req.body = body;
  return ingestEvents(req, res);
};

// ---------------------------------------------------------------------------
// POST /api/analytics/heartbeat — keep session alive without a full event
// Body: { visitorId, sessionId, pageUrl? }
// Writes are coalesced server-side: lastActivity is set but no event row.
// ---------------------------------------------------------------------------
export const heartbeat = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const visitorId = assertVisitorId(body.visitorId);
  const sessionId = assertSessionId(body.sessionId);

  // Must include visitorId in the select — without it the mismatch check
  // below silently always passes (undefined), letting anyone with a session
  // id refresh a stranger's session. Same for sessionEnd: an explicitly
  // closed session must NOT be resurrected by a stale heartbeat still firing
  // from a backgrounded tab.
  const existing = await AnalyticsSession.findOne({ sessionId })
    .select("lastActivity sessionStart isActive visitorId sessionEnd")
    .lean();
  if (!existing) {
    throw new AppError("Unknown session — call /session/start first", 404);
  }
  if (existing.visitorId !== visitorId) {
    throw new AppError("Session/visitor mismatch", 400);
  }
  if (existing.sessionEnd) {
    // Idempotent no-op: the session has already been closed. Report 200 so
    // the client doesn't flood retries, but skip the DB write entirely.
    res.status(200).json({
      success: true,
      message: "Session already ended",
      data: { idleMinutes: SESSION_IDLE_MINUTES, ended: true },
    });
    return;
  }

  // Coalesce: only persist if the previous activity was more than 15 seconds
  // ago. A tab firing heartbeats every 5s should still result in ~4 writes
  // per minute, not 12.
  const now = new Date();
  const minGapMs = Math.max(
    5_000,
    Number(process.env.ANALYTICS_HEARTBEAT_MIN_GAP_MS) || 15_000
  );
  if (now.getTime() - new Date(existing.lastActivity).getTime() >= minGapMs) {
    const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 2048) : "";
    const pagePath = pageUrl ? extractPath(pageUrl) : "";
    await AnalyticsSession.updateOne(
      { sessionId, sessionEnd: null },
      {
        $set: {
          lastActivity: now,
          ...(pageUrl ? { currentPage: pageUrl, exitPage: pageUrl, exitPagePath: pagePath } : {}),
          isActive: true,
        },
      }
    );
    await AnalyticsVisitor.updateOne({ visitorId }, { $set: { lastVisit: now } });
  }

  res.status(200).json({
    success: true,
    message: "Heartbeat received",
    data: { idleMinutes: SESSION_IDLE_MINUTES },
  });
};

// ---------------------------------------------------------------------------
// POST /api/analytics/session/start
// Body: { visitorId, sessionId, pageUrl?, referrer?, utm* }
// ---------------------------------------------------------------------------
export const startSession = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const visitorId = assertVisitorId(body.visitorId);
  const sessionId = assertSessionId(body.sessionId);
  const userId = optionalObjectId(body.userId);
  const ctx = buildContextFromBody(req, body);

  const [, isNew] = await Promise.all([
    touchVisitor(visitorId, ctx, userId, 0, 0),
    // Explicit /session/start is a strong "user is here" signal — on a round
    // trip from a payment gateway or a page-reload after sendBeacon fired
    // /session/end, reopen the existing row instead of leaving it ended.
    touchSession(sessionId, visitorId, ctx, userId, 0, 0, { resurrect: true }),
  ]);

  res.status(200).json({
    success: true,
    message: isNew ? "Session started" : "Session reopened",
    data: { sessionId, visitorId, isNew },
  });
};

// ---------------------------------------------------------------------------
// POST /api/analytics/session/end
// Body: { visitorId, sessionId, exitPage? }
// Marks the session closed and computes its duration.
// ---------------------------------------------------------------------------
export const endSession = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const visitorId = assertVisitorId(body.visitorId);
  const sessionId = assertSessionId(body.sessionId);

  const session = await AnalyticsSession.findOne({ sessionId }).select(
    "sessionStart lastActivity sessionEnd isActive visitorId"
  );
  if (!session) throw new AppError("Unknown session", 404);
  if (session.visitorId !== visitorId) throw new AppError("Session/visitor mismatch", 400);
  if (session.sessionEnd) {
    res.status(200).json({
      success: true,
      message: "Session already ended",
      data: { sessionId, duration: session.duration },
    });
    return;
  }

  const now = new Date();
  const end = now;
  const duration = Math.max(
    0,
    Math.round((end.getTime() - new Date(session.sessionStart).getTime()) / 1000)
  );
  const exitPage = typeof body.exitPage === "string" ? body.exitPage.slice(0, 2048) : "";
  const exitPagePath = exitPage ? extractPath(exitPage) : "";

  await AnalyticsSession.updateOne(
    { sessionId },
    {
      $set: {
        sessionEnd: end,
        isActive: false,
        duration,
        ...(exitPage ? { exitPage, exitPagePath } : {}),
      },
    }
  );

  res.status(200).json({
    success: true,
    message: "Session ended",
    data: { sessionId, duration },
  });
};

// ---------------------------------------------------------------------------
// Internal (not an HTTP endpoint): record a server-verified purchase. Call
// this from the order controller after the order transitions to a terminal
// paid/delivered state. Idempotent by orderId — a second call for the same
// order is a no-op. Never trust client "purchase" events.
// ---------------------------------------------------------------------------
export interface PurchaseFact {
  orderId: string;
  visitorId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  revenue: number;
  pageUrl?: string;
}

export const recordServerPurchase = async (fact: PurchaseFact): Promise<void> => {
  const orderObjectId = optionalObjectId(fact.orderId);
  if (!orderObjectId) throw new AppError("recordServerPurchase: invalid orderId", 400);
  const exists = await AnalyticsEvent.exists({ eventName: "purchase", orderId: orderObjectId });
  if (exists) return; // idempotent dedupe on verified orderId

  const now = new Date();
  const visitorId = fact.visitorId && /^[A-Za-z0-9._:-]{8,80}$/.test(fact.visitorId)
    ? fact.visitorId
    : `order-${String(orderObjectId)}`;
  const sessionId = fact.sessionId && /^[A-Za-z0-9._:-]{8,80}$/.test(fact.sessionId)
    ? fact.sessionId
    : `order-${String(orderObjectId)}`;
  const userId = optionalObjectId(fact.userId);
  const revenue = Math.max(0, Number(fact.revenue) || 0);

  await AnalyticsEvent.create({
    eventName: "purchase",
    eventCategory: "ecommerce",
    visitorId,
    sessionId,
    userId,
    pageUrl: fact.pageUrl || "",
    pagePath: "/checkout/success",
    pageTitle: "Purchase",
    referrer: "",
    elementId: "",
    elementName: "",
    buttonLabel: "",
    productId: null,
    categoryId: null,
    orderId: orderObjectId,
    deviceType: "",
    browser: "",
    operatingSystem: "",
    country: "",
    city: "",
    trafficSource: "direct",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    utmTerm: "",
    utmContent: "",
    metadata: { revenue },
    dedupeKey: `purchase:${String(orderObjectId)}`,
    createdAt: now,
  });

  await AnalyticsDailySummary.updateOne(
    { day: utcDayKey(now) },
    {
      $setOnInsert: { day: utcDayKey(now) },
      $set: { lastUpdatedAt: now },
      $inc: { purchases: 1, revenue },
    },
    { upsert: true }
  );
};
