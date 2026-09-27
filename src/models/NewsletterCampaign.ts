import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const CAMPAIGN_TYPES = ["NEW_PRODUCT", "OFFER", "ANNOUNCEMENT"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

// DRAFT -> SENDING -> SENT (or FAILED when no email could be sent)
export const CAMPAIGN_STATUSES = ["DRAFT", "SENDING", "SENT", "FAILED"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_LIMITS = {
  SUBJECT_MAX: 150,
  HEADING_MAX: 150,
  MESSAGE_MAX: 3000,
  BUTTON_TEXT_MAX: 40,
  PRODUCTS_MAX: 6,
} as const;

// A marketing email to newsletter subscribers (new products, offers, news)
export interface INewsletterCampaign {
  type: CampaignType;
  subject: string;
  heading: string;
  message: string;
  // Products shown as cards in the email
  productIds: Types.ObjectId[];
  // Optional main button (e.g. "See all offers" -> /offers)
  buttonText: string;
  buttonLink: string;
  status: CampaignStatus;
  recipients: number;
  sentCount: number;
  failedCount: number;
  createdBy: Types.ObjectId;
  sentBy: Types.ObjectId | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewsletterCampaignDocument = HydratedDocument<INewsletterCampaign>;

const newsletterCampaignSchema = new Schema<INewsletterCampaign>(
  {
    type: { type: String, enum: CAMPAIGN_TYPES, required: true },
    subject: { type: String, required: true, trim: true, maxlength: CAMPAIGN_LIMITS.SUBJECT_MAX },
    heading: { type: String, trim: true, maxlength: CAMPAIGN_LIMITS.HEADING_MAX, default: "" },
    message: { type: String, trim: true, maxlength: CAMPAIGN_LIMITS.MESSAGE_MAX, default: "" },
    productIds: { type: [{ type: Schema.Types.ObjectId, ref: "Product" }], default: [] },
    buttonText: { type: String, trim: true, maxlength: CAMPAIGN_LIMITS.BUTTON_TEXT_MAX, default: "" },
    buttonLink: { type: String, trim: true, default: "" },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: "DRAFT", index: true },
    recipients: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sentBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    sentAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

newsletterCampaignSchema.index({ createdAt: -1 });

const NewsletterCampaign = model<INewsletterCampaign>("NewsletterCampaign", newsletterCampaignSchema);
export default NewsletterCampaign;
