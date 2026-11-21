# Analytics & User Activity Tracking — Backend Integration Guide

Complete storefront analytics module. Visitors, sessions, events, funnel,
sources, product performance and revenue — all aggregated live from
MongoDB. Integrates with existing User, Product, Order models without
modifying them.

---

## 1. MongoDB models (new)

| Collection | Purpose |
|---|---|
| `analyticsevents` | Append-only raw event log. TTL `ANALYTICS_EVENT_TTL_DAYS` (default 90d). |
| `analyticsvisitors` | One row per anonymous visitor; lifetime totals + first-touch attribution. |
| `analyticssessions` | One row per browser session; TTL `ANALYTICS_SESSION_TTL_DAYS` (default 180d). |
| `analyticsdailysummaries` | Pre-aggregated daily counters. TTL `ANALYTICS_SUMMARY_TTL_DAYS` (default 730d). |

Every collection ships with compound indexes matching the dashboard
aggregations (`createdAt` + `eventName`/`productId`/`pagePath`), a TTL index
for retention, and `visitorId` / `sessionId` unique constraints where
applicable.

---

## 2. Environment variables

All optional — sensible defaults apply.

```env
# Raw events retention (days). Minimum 7, default 90.
ANALYTICS_EVENT_TTL_DAYS=90
# Session rows retention (days). Minimum 14, default 180.
ANALYTICS_SESSION_TTL_DAYS=180
# Daily summary retention (days). Minimum 90, default 730.
ANALYTICS_SUMMARY_TTL_DAYS=730
# Session idle timeout — seconds without a heartbeat/event = closed. Default 30 min.
ANALYTICS_SESSION_IDLE_MINUTES=30
# Minimum ms between heartbeat DB writes (coalescing). Default 15_000.
ANALYTICS_HEARTBEAT_MIN_GAP_MS=15000
# Max span (days) a single admin query may cover. Default 366.
ANALYTICS_MAX_RANGE_DAYS=366
# Rate limiters
ANALYTICS_INGEST_RATE_LIMIT=300        # events + session calls per IP / 5min
ANALYTICS_HEARTBEAT_RATE_LIMIT=30      # heartbeats per IP / min
```

---

## 3. Permissions (seeded on server start)

```
analytics.view     — dashboard + all admin GET endpoints
analytics.export   — CSV export of raw events (separate because exports leak rows)
```

Default `Manager` role receives `analytics.view`. `analytics.export` must be
granted explicitly to users who need it.

---

## 4. Public ingestion endpoints

Unauthenticated (storefront visitors have no account). Rate-limited.

| Method | Path | Body |
|---|---|---|
| POST | `/api/analytics/session/start` | `{ visitorId, sessionId, pageUrl?, referrer?, utmSource? ... }` |
| POST | `/api/analytics/events` | `{ visitorId, sessionId, events: [...] }` OR single event |
| POST | `/api/analytics/page-view` | shorthand for `{ eventName: "page_view", ... }` |
| POST | `/api/analytics/heartbeat` | `{ visitorId, sessionId, pageUrl? }` |
| POST | `/api/analytics/session/end` | `{ visitorId, sessionId, exitPage? }` |

### Accepted event names

```
page_view, button_click, product_view, product_click,
add_to_cart, remove_from_cart, wishlist_add, wishlist_remove,
search, category_click, banner_click, filter_click, sort_click,
checkout_start, payment_initiated, payment_success, payment_failed
```

`purchase` is **NEVER** accepted from the client — it's emitted by the
server-side reconciler (`recordServerPurchase`) when an Order transitions
to a verified completed state. Call it from your order flow:

```ts
import { recordServerPurchase } from "./controllers/analyticsIngestController";
await recordServerPurchase({
  orderId: order._id.toString(),
  visitorId: order.metadata?.visitorId, // if you carried it through checkout
  userId: order.customerId.toString(),
  revenue: order.totalAmount - order.shippingCost,
});
```

Idempotent: a second call for the same `orderId` is a no-op.

### Payload shape per event

```jsonc
{
  "eventName": "product_click",
  "pageUrl": "https://globalshelfbd.com/products/foo",
  "pageTitle": "Foo — GlobalShelfBD",
  "pagePath": "/products/foo",      // auto-derived if omitted
  "referrer": "https://google.com/", // for first event of a session
  "elementId": "add-to-cart-btn",
  "elementName": "AddToCartButton",
  "buttonLabel": "Add to Cart",
  "productId": "<ObjectId>",
  "categoryId": "<ObjectId>",
  "deviceType": "mobile",            // optional; falls back to UA parse
  "browser": "Chrome",               // optional; falls back to UA parse
  "operatingSystem": "iOS",
  "country": "BD", "city": "Dhaka",  // optional, from geo-IP if you have one
  "utmSource": "facebook",
  "utmMedium": "cpc",
  "utmCampaign": "winter-sale",
  "metadata": {                       // flat key/value, numbers/strings/bool only
    "query": "nesquik",
    "resultCount": 3,
    "revenue": 1200                   // for internal events, never to overwrite server purchase
  }
}
```

### PII safety

`metadata` is sanitized server-side. Any key whose name matches one of
`password, otp, token, apikey, secret, cardnumber, cvv, email, phone,
address, ssn, nid, passport, …` is dropped before insert. Values are
truncated to 500 chars; at most 25 metadata entries per event.

### Dedupe

Same `(eventName, visitorId, anchor)` within 5s collapses to one row. Anchor
is `productId` for product events, `elementId`/`buttonLabel` for click
events, `pagePath` otherwise.

---

## 5. Admin endpoints

All require `authenticate` + `requirePermission("analytics.view")`, except
`/export` which needs `analytics.export`.

Date range: pass `?preset=today|yesterday|last7d|last30d|last90d|thisMonth|lastMonth`
OR `?from=ISO&to=ISO`. Max span capped by `ANALYTICS_MAX_RANGE_DAYS`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/analytics/overview` | Dashboard cards (visitors, sessions, pageviews, orders, revenue, bounce, conversion, cart abandonment) |
| GET | `/api/admin/analytics/pages` | Page-level stats + entries/exits/bounce; `?page&limit&sort&direction` |
| GET | `/api/admin/analytics/clicks` | Click events grouped by element |
| GET | `/api/admin/analytics/clicks/top-elements` | Top N clicked elements |
| GET | `/api/admin/analytics/products` | Product analytics list |
| GET | `/api/admin/analytics/products/:productId` | Single product deep-dive |
| GET | `/api/admin/analytics/visitors` | Visitor list; `?search` |
| GET | `/api/admin/analytics/visitors/:visitorId` | Visitor + their sessions + recent events |
| GET | `/api/admin/analytics/active-visitors` | Live visitors (`lastActivity >= idleCutoff`) |
| GET | `/api/admin/analytics/sessions` | Session list; `?active=true` to filter live |
| GET | `/api/admin/analytics/sessions/:sessionId` | Session + its event timeline |
| GET | `/api/admin/analytics/trends` | Daily summary timeseries |
| GET | `/api/admin/analytics/funnel` | 7-stage funnel with drop-off |
| GET | `/api/admin/analytics/journeys` | Top session paths (first 5 pages) |
| GET | `/api/admin/analytics/sources` | Traffic source breakdown |
| GET | `/api/admin/analytics/devices` | Device / browser / OS breakdown |
| GET | `/api/admin/analytics/locations` | Country / city breakdown |
| GET | `/api/admin/analytics/searches` | Search queries + no-result rate |
| GET | `/api/admin/analytics/cart` | Add/remove/abandon stats + top added products |
| GET | `/api/admin/analytics/checkout` | Checkout funnel + payment method mix (server-verified) |
| GET | `/api/admin/analytics/customers` | Identified users' event footprint |
| GET | `/api/admin/analytics/export` | CSV of raw events; `?limit` up to 100k |

### Response shape

```jsonc
{
  "success": true,
  "message": "Analytics overview retrieved successfully",
  "data": { /* endpoint-specific */ },
  "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
}
```

---

## 6. Frontend integration guide

### Visitor + session id generation

```ts
// src/lib/analytics.ts (frontend)
function getVisitorId(): string {
  let id = localStorage.getItem("gs_visitorId");
  if (!id) {
    id = `v-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    localStorage.setItem("gs_visitorId", id);
  }
  return id;
}

function getSessionId(): string {
  let id = sessionStorage.getItem("gs_sessionId");
  const started = Number(sessionStorage.getItem("gs_sessionStartedAt") || 0);
  // Fresh id per browser tab-session OR after 30 min idle.
  if (!id || Date.now() - started > 30 * 60 * 1000) {
    id = `s-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    sessionStorage.setItem("gs_sessionId", id);
  }
  sessionStorage.setItem("gs_sessionStartedAt", String(Date.now()));
  return id;
}
```

### App boot

```ts
await fetch("/api/analytics/session/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    visitorId: getVisitorId(),
    sessionId: getSessionId(),
    pageUrl: window.location.href,
    referrer: document.referrer,
    utmSource: new URLSearchParams(location.search).get("utm_source") || "",
    utmMedium: new URLSearchParams(location.search).get("utm_medium") || "",
    utmCampaign: new URLSearchParams(location.search).get("utm_campaign") || "",
  }),
});
```

### Page view on route change

```ts
await fetch("/api/analytics/page-view", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    visitorId: getVisitorId(),
    sessionId: getSessionId(),
    pageUrl: window.location.href,
    pageTitle: document.title,
    referrer: document.referrer,
  }),
});
```

### Batched engagement events (preferred for click bursts)

```ts
const queue: unknown[] = [];
function trackEvent(eventName: string, payload: Record<string, unknown> = {}) {
  queue.push({ eventName, pageUrl: location.href, pagePath: location.pathname, ...payload });
}
setInterval(() => {
  if (queue.length === 0) return;
  const events = queue.splice(0, 50);
  fetch("/api/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({ visitorId: getVisitorId(), sessionId: getSessionId(), events }),
  }).catch(() => queue.unshift(...events));
}, 3000);
```

### Heartbeat (keeps session live without an event)

```ts
setInterval(() => {
  fetch("/api/analytics/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
      pageUrl: location.href,
    }),
  }).catch(() => {});
}, 30_000);
```

### Session end

```ts
window.addEventListener("pagehide", () => {
  navigator.sendBeacon(
    "/api/analytics/session/end",
    new Blob(
      [JSON.stringify({ visitorId: getVisitorId(), sessionId: getSessionId(), exitPage: location.href })],
      { type: "application/json" }
    )
  );
});
```

### Common patterns

```ts
// Product view (in product detail page)
trackEvent("product_view", { productId, categoryId });

// Add to cart
trackEvent("add_to_cart", { productId, metadata: { quantity, price } });

// Search
trackEvent("search", { metadata: { query, resultCount } });

// Checkout step
trackEvent("checkout_start");
trackEvent("payment_initiated", { metadata: { paymentMethod } });
// NB: payment_success here is a UX-only signal. The REAL purchase row is
// created server-side via recordServerPurchase() when the Order is verified.
```

---

## 7. Security & integrity notes

- `purchase` events are server-only — client claims are silently dropped.
- `metadata` is sanitized on every write; PII keys never land in Mongo.
- Visitor/session ids are opaque strings validated with a strict regex.
- Rate limiters cap ingestion per IP.
- Export endpoint requires a separately-grantable permission.
- All admin endpoints share the existing `authenticate` + `requirePermission` pipeline.

---

## 8. Files added

```
src/models/AnalyticsEvent.ts
src/models/AnalyticsVisitor.ts
src/models/AnalyticsSession.ts
src/models/AnalyticsDailySummary.ts
src/utils/analytics.ts
src/controllers/analyticsIngestController.ts
src/controllers/analyticsAdminController.ts
src/routes/analyticsRoutes.ts
docs/ANALYTICS.md
```

Edits:
```
src/config/permissions.ts   — added analytics.view + analytics.export; granted to Manager
src/server.ts               — mounted /api/analytics + /api/admin/analytics
```

No existing business logic was modified.
