import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const CONTACT_STATUSES = ["NEW", "READ", "REPLIED"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

// Messages sent from the website's Contact Us form
export interface IContactMessage {
  name: string;
  email: string;
  phone: string;
  subject: string;
  message: string;
  status: ContactStatus;
  // Set when a logged-in customer sent it
  userId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ContactMessageDocument = HydratedDocument<IContactMessage>;

const contactMessageSchema = new Schema<IContactMessage>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 100 },
    phone: { type: String, trim: true, maxlength: 20, default: "" },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    message: { type: String, required: true, trim: true, maxlength: 3000 },
    status: { type: String, enum: CONTACT_STATUSES, default: "NEW", index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
  }
);

contactMessageSchema.index({ createdAt: -1 });

const ContactMessage = model<IContactMessage>("ContactMessage", contactMessageSchema);
export default ContactMessage;
