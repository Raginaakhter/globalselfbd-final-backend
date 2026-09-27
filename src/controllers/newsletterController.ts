import crypto from "crypto";
import type { Request, Response } from "express";
import NewsletterSubscriber, {
  SUBSCRIBER_STATUSES,
  type SubscriberStatus,
} from "../models/NewsletterSubscriber";
import AppError from "../utils/AppError";
import {
  assertObjectId,
  escapeRegex,
  getPagination,
  isNonEmptyString,
  queryString,
} from "../utils/validators";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const SOURCE_REGEX = /^[a-z0-9-]{1,30}$/;
const SUBSCRIBED_MESSAGE = "Thanks for subscribing! You will get our news and offers.";

const newToken = () => crypto.randomBytes(24).toString("hex");

const isSubscriberStatus = (value: unknown): value is SubscriberStatus =>
  typeof value === "string" && (SUBSCRIBER_STATUSES as readonly string[]).includes(value);

// @desc    Subscribe an email to the newsletter
// @route   POST /api/newsletter
// @access  Public (rate limited). A logged-in customer is linked to the subscription.
export const subscribe = async (req: Request, res: Response) => {
  const { email, source } = (req.body || {}) as Body;
  if (!isNonEmptyString(email) || !EMAIL_REGEX.test(email.trim()) || email.trim().length > 100) {
    throw new AppError("Please enter a valid email address", 400);
  }
  const cleanSource = typeof source === "string" && SOURCE_REGEX.test(source) ? source : "footer";
  const normalized = email.trim().toLowerCase();

  const existing = await NewsletterSubscriber.findOne({ email: normalized });
  if (!existing) {
    await NewsletterSubscriber.create({
      email: normalized,
      source: cleanSource,
      userId: req.user?._id ?? null,
      unsubscribeToken: newToken(),
    }).catch((error: { code?: number }) => {
      // Two submits at the same moment: the other one already saved it
      if (error.code !== 11000) throw error;
    });
  } else if (existing.status === "UNSUBSCRIBED") {
    existing.status = "SUBSCRIBED";
    existing.subscribedAt = new Date();
    existing.unsubscribedAt = null;
    existing.source = cleanSource;
    await existing.save();
  }

  // Same answer whether the email was new or already on the list
  res.status(200).json({ success: true, message: SUBSCRIBED_MESSAGE, data: null });
};

// @desc    Unsubscribe using the token from a newsletter email's unsubscribe link
// @route   POST /api/newsletter/unsubscribe
// @access  Public
export const unsubscribe = async (req: Request, res: Response) => {
  const { token } = (req.body || {}) as Body;
  if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) {
    throw new AppError("Unsubscribe link is invalid", 400);
  }
  const subscriber = await NewsletterSubscriber.findOne({ unsubscribeToken: token }).select("+unsubscribeToken");
  if (!subscriber) throw new AppError("Unsubscribe link is invalid", 404);

  if (subscriber.status === "SUBSCRIBED") {
    subscriber.status = "UNSUBSCRIBED";
    subscriber.unsubscribedAt = new Date();
    await subscriber.save();
  }
  res.status(200).json({ success: true, message: "You have been unsubscribed from our newsletter", data: null });
};

const listFilter = (req: Request): Record<string, unknown> => {
  const filter: Record<string, unknown> = {};
  const status = queryString(req.query.status);
  const search = queryString(req.query.search);
  if (status) {
    if (!isSubscriberStatus(status)) throw new AppError("status must be SUBSCRIBED or UNSUBSCRIBED", 400);
    filter.status = status;
  }
  if (isNonEmptyString(search)) filter.email = new RegExp(escapeRegex(search.trim()), "i");
  return filter;
};

// @desc    List newsletter subscribers (search, status filter, pagination) with totals
// @route   GET /api/newsletter/subscribers
// @access  newsletter.view
export const getSubscribers = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = listFilter(req);

  const [subscribers, total, counts] = await Promise.all([
    NewsletterSubscriber.find(filter).sort({ subscribedAt: -1 }).skip(skip).limit(limit),
    NewsletterSubscriber.countDocuments(filter),
    NewsletterSubscriber.aggregate<{ _id: SubscriberStatus; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const count = (s: SubscriberStatus) => counts.find((c) => c._id === s)?.count || 0;

  res.status(200).json({
    success: true,
    message: "Subscribers fetched successfully",
    data: subscribers,
    summary: { subscribed: count("SUBSCRIBED"), unsubscribed: count("UNSUBSCRIBED"), total: count("SUBSCRIBED") + count("UNSUBSCRIBED") },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// Spreadsheet apps run cells that start with = + - @ as formulas; prefix those with '
const csvCell = (value: unknown): string => {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

// @desc    Download subscribers as a CSV file (for a mailing tool)
// @route   GET /api/newsletter/subscribers/export?status=SUBSCRIBED
// @access  newsletter.view
export const exportSubscribers = async (req: Request, res: Response) => {
  const filter = listFilter(req);
  const rows = await NewsletterSubscriber.find(filter).sort({ subscribedAt: -1 }).lean();
  const lines = [
    ["email", "status", "source", "subscribedAt", "unsubscribedAt"].join(","),
    ...rows.map((r) => [r.email, r.status, r.source, r.subscribedAt, r.unsubscribedAt].map(csvCell).join(",")),
  ];
  const date = new Date().toISOString().slice(0, 10);
  res
    .status(200)
    .type("text/csv")
    .attachment(`newsletter-subscribers-${date}.csv`)
    .send(lines.join("\n"));
};

// @desc    Remove a subscriber completely
// @route   DELETE /api/newsletter/subscribers/:id
// @access  newsletter.delete
export const deleteSubscriber = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "subscriber ID");
  const subscriber = await NewsletterSubscriber.findByIdAndDelete(req.params.id);
  if (!subscriber) throw new AppError("Subscriber not found", 404);
  res.status(200).json({
    success: true,
    message: "Subscriber deleted successfully",
    data: { _id: subscriber._id, email: subscriber.email },
  });
};
