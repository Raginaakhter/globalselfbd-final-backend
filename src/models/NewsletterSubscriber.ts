import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const SUBSCRIBER_STATUSES = ["SUBSCRIBED", "UNSUBSCRIBED"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

// Emails collected from the "Subscribe to our Newsletter" form (marketing, not order emails)
export interface INewsletterSubscriber {
  email: string;
  status: SubscriberStatus;
  // Where the form was ("footer", "popup", ...)
  source: string;
  // Set when a logged-in customer subscribed
  userId: Types.ObjectId | null;
  // Secret used in the unsubscribe link of future marketing emails
  unsubscribeToken: string;
  subscribedAt: Date;
  unsubscribedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewsletterSubscriberDocument = HydratedDocument<INewsletterSubscriber>;

const newsletterSubscriberSchema = new Schema<INewsletterSubscriber>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 100,
    },
    status: {
      type: String,
      enum: SUBSCRIBER_STATUSES,
      default: "SUBSCRIBED",
      index: true,
    },
    source: { type: String, trim: true, maxlength: 30, default: "footer" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    unsubscribeToken: { type: String, required: true, unique: true, select: false },
    subscribedAt: { type: Date, default: Date.now },
    unsubscribedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

newsletterSubscriberSchema.index({ subscribedAt: -1 });

const NewsletterSubscriber = model<INewsletterSubscriber>("NewsletterSubscriber", newsletterSubscriberSchema);
export default NewsletterSubscriber;
