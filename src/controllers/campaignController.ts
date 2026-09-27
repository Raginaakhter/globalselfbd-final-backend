import type { Request, Response } from "express";
import type { Types } from "mongoose";
import NewsletterCampaign, {
  CAMPAIGN_LIMITS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  type CampaignType,
  type INewsletterCampaign,
  type NewsletterCampaignDocument,
} from "../models/NewsletterCampaign";
import NewsletterSubscriber from "../models/NewsletterSubscriber";
import Product from "../models/Product";
import AppError from "../utils/AppError";
import { getAuthUser } from "../middleware/auth";
import { getVisibleCategoryIds } from "../utils/categoryTree";
import { isEmailConfigured, sendEmail, sendEmailBatch } from "../utils/sendEmail";
import { renderCampaignEmail, type CampaignProduct } from "../utils/campaignEmail";
import {
  assertObjectId,
  getPagination,
  isNonEmptyString,
  isValidLink,
  optionalText,
  queryString,
} from "../utils/validators";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const BATCH_SIZE = 100; // Resend batch limit
const BATCH_PAUSE_MS = 600; // stay under Resend's requests-per-second limit
const PRODUCT_FIELDS = "productTitle slug thumbnail customerSellPrice customerSpecialPrice status categoryId";

const isCampaignType = (v: unknown): v is CampaignType =>
  typeof v === "string" && (CAMPAIGN_TYPES as readonly string[]).includes(v);

const findCampaignOr404 = async (id: unknown): Promise<NewsletterCampaignDocument> => {
  assertObjectId(id, "campaign ID");
  const campaign = await NewsletterCampaign.findById(id);
  if (!campaign) throw new AppError("Campaign not found", 404);
  return campaign;
};

// Products that can be advertised: exist, ACTIVE, in a visible category
const loadSellableProducts = async (ids: (Types.ObjectId | string)[]) => {
  if (ids.length === 0) return [];
  const visible = new Set((await getVisibleCategoryIds()).map(String));
  const products = await Product.find({ _id: { $in: ids } }).select(PRODUCT_FIELDS).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  // Keep the order the admin chose
  return ids
    .map((id) => byId.get(String(id)))
    .filter((p): p is NonNullable<typeof p> => Boolean(p) && p!.status === "ACTIVE" && visible.has(String(p!.categoryId)));
};

const parseCampaignFields = async (body: Body, creating: boolean): Promise<Partial<INewsletterCampaign>> => {
  const fields: Partial<INewsletterCampaign> = {};

  if (creating || body.type !== undefined) {
    if (!isCampaignType(body.type)) throw new AppError(`type must be one of: ${CAMPAIGN_TYPES.join(", ")}`, 400);
    fields.type = body.type;
  }
  if (creating || body.subject !== undefined) {
    if (!isNonEmptyString(body.subject)) throw new AppError("Email subject is required", 400);
    if (body.subject.trim().length > CAMPAIGN_LIMITS.SUBJECT_MAX) {
      throw new AppError(`Subject cannot exceed ${CAMPAIGN_LIMITS.SUBJECT_MAX} characters`, 400);
    }
    fields.subject = body.subject.trim();
  }
  const heading = optionalText(body.heading, "Heading", CAMPAIGN_LIMITS.HEADING_MAX);
  if (heading !== undefined) fields.heading = heading;
  const message = optionalText(body.message, "Message", CAMPAIGN_LIMITS.MESSAGE_MAX);
  if (message !== undefined) fields.message = message;
  const buttonText = optionalText(body.buttonText, "Button text", CAMPAIGN_LIMITS.BUTTON_TEXT_MAX);
  if (buttonText !== undefined) fields.buttonText = buttonText;
  if (body.buttonLink !== undefined) {
    if (body.buttonLink === null || body.buttonLink === "") fields.buttonLink = "";
    else if (!isValidLink(body.buttonLink)) throw new AppError('Button link must be a path like "/offers" or a full http(s) URL', 400);
    else fields.buttonLink = body.buttonLink.trim();
  }

  if (body.productIds !== undefined) {
    if (!Array.isArray(body.productIds)) throw new AppError("productIds must be an array of product IDs", 400);
    if (body.productIds.length > CAMPAIGN_LIMITS.PRODUCTS_MAX) {
      throw new AppError(`You can feature at most ${CAMPAIGN_LIMITS.PRODUCTS_MAX} products in one email`, 400);
    }
    body.productIds.forEach((id) => assertObjectId(id, "product ID"));
    const unique = [...new Set(body.productIds as string[])];
    const sellable = await loadSellableProducts(unique);
    if (sellable.length !== unique.length) {
      throw new AppError("Every product must exist and be ACTIVE (in an active category)", 400);
    }
    fields.productIds = sellable.map((p) => p._id);
  }
  return fields;
};

// A campaign needs something to say: a message or at least one product
const assertHasContent = (c: Pick<INewsletterCampaign, "message" | "productIds" | "buttonText" | "buttonLink">) => {
  if (!c.message && c.productIds.length === 0) {
    throw new AppError("Add a message or at least one product", 400);
  }
  if (Boolean(c.buttonText) !== Boolean(c.buttonLink)) {
    throw new AppError("Button text and button link must be set together", 400);
  }
};

const withProducts = async (campaign: NewsletterCampaignDocument) => {
  const products = await Product.find({ _id: { $in: campaign.productIds } })
    .select("productTitle slug thumbnail customerSellPrice customerSpecialPrice status")
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return { ...campaign.toObject(), products: campaign.productIds.map((id) => byId.get(String(id))).filter(Boolean) };
};

// @desc    Create a campaign draft (new products / offer / announcement)
// @route   POST /api/newsletter/campaigns
// @access  newsletter.send
export const createCampaign = async (req: Request, res: Response) => {
  const fields = await parseCampaignFields((req.body || {}) as Body, true);
  const draft = { heading: "", message: "", productIds: [], buttonText: "", buttonLink: "", ...fields };
  assertHasContent(draft);
  const campaign = await NewsletterCampaign.create({ ...draft, createdBy: getAuthUser(req)._id });
  res.status(201).json({ success: true, message: "Campaign draft created", data: await withProducts(campaign) });
};

// @desc    List campaigns (newest first)
// @route   GET /api/newsletter/campaigns
// @access  newsletter.view
export const getCampaigns = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter: Record<string, unknown> = {};
  const status = queryString(req.query.status);
  if (status) {
    if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(`status must be one of: ${CAMPAIGN_STATUSES.join(", ")}`, 400);
    }
    filter.status = status;
  }
  const [campaigns, total] = await Promise.all([
    NewsletterCampaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    NewsletterCampaign.countDocuments(filter),
  ]);
  res.status(200).json({
    success: true,
    message: "Campaigns fetched successfully",
    data: campaigns,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    One campaign with its products
// @route   GET /api/newsletter/campaigns/:id
// @access  newsletter.view
export const getCampaign = async (req: Request, res: Response) => {
  const campaign = await findCampaignOr404(req.params.id);
  res.status(200).json({ success: true, message: "Campaign fetched successfully", data: await withProducts(campaign) });
};

// @desc    Edit a draft (sent campaigns cannot be changed)
// @route   PUT /api/newsletter/campaigns/:id
// @access  newsletter.send
export const updateCampaign = async (req: Request, res: Response) => {
  const campaign = await findCampaignOr404(req.params.id);
  if (campaign.status !== "DRAFT") throw new AppError(`A ${campaign.status} campaign cannot be edited`, 409);
  const fields = await parseCampaignFields((req.body || {}) as Body, false);
  campaign.set(fields);
  assertHasContent(campaign);
  await campaign.save();
  res.status(200).json({ success: true, message: "Campaign updated", data: await withProducts(campaign) });
};

// @desc    Delete a campaign (not while it is being sent)
// @route   DELETE /api/newsletter/campaigns/:id
// @access  newsletter.send
export const deleteCampaign = async (req: Request, res: Response) => {
  const campaign = await findCampaignOr404(req.params.id);
  if (campaign.status === "SENDING") throw new AppError("This campaign is being sent right now", 409);
  await campaign.deleteOne();
  res.status(200).json({ success: true, message: "Campaign deleted", data: { _id: campaign._id } });
};

// @desc    See the email exactly as subscribers will get it
// @route   GET /api/newsletter/campaigns/:id/preview
// @access  newsletter.view
export const previewCampaign = async (req: Request, res: Response) => {
  const campaign = await findCampaignOr404(req.params.id);
  const products = (await loadSellableProducts(campaign.productIds)) as CampaignProduct[];
  const email = renderCampaignEmail(campaign, products, "preview");
  res.status(200).json({
    success: true,
    message: "Campaign preview",
    data: { subject: email.subject, html: email.html, text: email.text, products: products.length },
  });
};

// @desc    Send the campaign to one address (yours by default) to check it
// @route   POST /api/newsletter/campaigns/:id/test
// @access  newsletter.send
export const sendTestCampaign = async (req: Request, res: Response) => {
  if (!isEmailConfigured()) throw new AppError("Email service is not configured", 503);
  const campaign = await findCampaignOr404(req.params.id);
  const { email } = (req.body || {}) as Body;
  const to = email === undefined ? getAuthUser(req).email : email;
  if (typeof to !== "string" || !EMAIL_REGEX.test(to)) throw new AppError("Please provide a valid email", 400);

  const products = (await loadSellableProducts(campaign.productIds)) as CampaignProduct[];
  // A subscriber gets their real unsubscribe link; anyone else gets a "test" link the website explains
  const subscriber = await NewsletterSubscriber.findOne({ email: to.trim().toLowerCase() }).select("+unsubscribeToken").lean();
  const message = renderCampaignEmail(campaign, products, subscriber?.unsubscribeToken ?? "test");
  await sendEmail({ to, subject: `[TEST] ${message.subject}`, html: message.html, text: message.text });
  res.status(200).json({ success: true, message: `Test email sent to ${to}`, data: { to } });
};

// Send to every subscriber in batches, then record the result
const deliverCampaign = async (campaignId: Types.ObjectId): Promise<void> => {
  let sent = 0;
  let failed = 0;
  try {
    const campaign = await NewsletterCampaign.findById(campaignId);
    if (!campaign) return;
    const products = (await loadSellableProducts(campaign.productIds)) as CampaignProduct[];
    const cursor = NewsletterSubscriber.find({ status: "SUBSCRIBED" }).select("email +unsubscribeToken").lean().cursor();

    let batch: { email: string; unsubscribeToken: string }[] = [];
    const flush = async () => {
      const result = await sendEmailBatch(
        batch.map((s) => ({ to: s.email, ...renderCampaignEmail(campaign, products, s.unsubscribeToken) }))
      );
      sent += result.sent;
      failed += result.failed;
      batch = [];
      await NewsletterCampaign.updateOne({ _id: campaignId }, { $set: { sentCount: sent, failedCount: failed } });
      await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    };
    for await (const subscriber of cursor) {
      batch.push(subscriber);
      if (batch.length === BATCH_SIZE) await flush();
    }
    if (batch.length) await flush();
  } catch (error) {
    console.error("❌ Campaign sending stopped:", (error as Error).message);
  }
  await NewsletterCampaign.updateOne(
    { _id: campaignId },
    { $set: { status: sent > 0 ? "SENT" : "FAILED", sentCount: sent, failedCount: failed, sentAt: new Date() } }
  );
};

// @desc    Send the campaign to all subscribers (runs in the background; poll GET /:id for progress)
// @route   POST /api/newsletter/campaigns/:id/send
// @access  newsletter.send
export const sendCampaign = async (req: Request, res: Response) => {
  if (!isEmailConfigured()) throw new AppError("Email service is not configured", 503);
  assertObjectId(req.params.id, "campaign ID");

  const recipients = await NewsletterSubscriber.countDocuments({ status: "SUBSCRIBED" });
  if (recipients === 0) throw new AppError("There are no subscribers yet", 400);

  // Only a DRAFT can start sending, and only once (double clicks do nothing)
  const campaign = await NewsletterCampaign.findOneAndUpdate(
    { _id: req.params.id, status: "DRAFT" },
    { $set: { status: "SENDING", recipients, sentCount: 0, failedCount: 0, sentBy: getAuthUser(req)._id } },
    { returnDocument: "after" }
  );
  if (!campaign) {
    const exists = await NewsletterCampaign.findById(req.params.id).select("status");
    if (!exists) throw new AppError("Campaign not found", 404);
    throw new AppError(`This campaign is already ${exists.status}`, 409);
  }

  setImmediate(() => void deliverCampaign(campaign._id));
  res.status(200).json({
    success: true,
    message: `Sending to ${recipients} subscriber(s). Check the campaign for progress.`,
    data: campaign,
  });
};
