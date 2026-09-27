import type { Request, Response } from "express";
import ContactMessage, { CONTACT_STATUSES, type ContactStatus } from "../models/ContactMessage";
import AppError from "../utils/AppError";
import {
  assertObjectId,
  escapeRegex,
  getPagination,
  isNonEmptyString,
  optionalText,
  queryString,
} from "../utils/validators";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const PHONE_REGEX = /^\+?[\d\s-]{6,20}$/;

const isContactStatus = (value: unknown): value is ContactStatus =>
  typeof value === "string" && (CONTACT_STATUSES as readonly string[]).includes(value);

const requiredText = (value: unknown, label: string, min: number, max: number): string => {
  if (!isNonEmptyString(value)) throw new AppError(`${label} is required`, 400);
  const text = value.trim();
  if (text.length < min) throw new AppError(`${label} must be at least ${min} characters`, 400);
  if (text.length > max) throw new AppError(`${label} cannot exceed ${max} characters`, 400);
  return text;
};

// @desc    Send a message from the website's Contact Us form
// @route   POST /api/contact
// @access  Public (rate limited). A logged-in customer is linked to the message.
export const createContactMessage = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const name = requiredText(body.name, "Name", 2, 100);
  if (!isNonEmptyString(body.email) || !EMAIL_REGEX.test(body.email.trim()) || body.email.trim().length > 100) {
    throw new AppError("Please provide a valid email", 400);
  }
  const phone = optionalText(body.phone, "Phone", 20) ?? "";
  if (phone && !PHONE_REGEX.test(phone)) throw new AppError("Please provide a valid phone number", 400);
  const subject = requiredText(body.subject, "Subject", 2, 150);
  const message = requiredText(body.message, "Message", 10, 3000);

  await ContactMessage.create({ name, email: body.email.trim(), phone, subject, message, userId: req.user?._id ?? null });
  res.status(201).json({ success: true, message: "Thank you! Your message has been received.", data: null });
};

// @desc    List contact messages (search, status filter, pagination) with counts per status
// @route   GET /api/contact-messages
// @access  contactMessages.view
export const getContactMessages = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter: Record<string, unknown> = {};
  const status = queryString(req.query.status);
  const search = queryString(req.query.search);
  if (status) {
    if (!isContactStatus(status)) throw new AppError(`status must be one of: ${CONTACT_STATUSES.join(", ")}`, 400);
    filter.status = status;
  }
  if (isNonEmptyString(search)) {
    const re = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ name: re }, { email: re }, { phone: re }, { subject: re }];
  }

  const [messages, total, counts] = await Promise.all([
    ContactMessage.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ContactMessage.countDocuments(filter),
    ContactMessage.aggregate<{ _id: ContactStatus; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const count = (s: ContactStatus) => counts.find((c) => c._id === s)?.count || 0;

  res.status(200).json({
    success: true,
    message: "Contact messages fetched successfully",
    data: messages,
    summary: { new: count("NEW"), read: count("READ"), replied: count("REPLIED"), total: count("NEW") + count("READ") + count("REPLIED") },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// @desc    Mark a message as NEW, READ or REPLIED
// @route   PATCH /api/contact-messages/:id/status
// @access  contactMessages.update
export const updateContactMessageStatus = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "Message ID");
  const { status } = (req.body || {}) as Body;
  if (!isContactStatus(status)) throw new AppError(`status must be one of: ${CONTACT_STATUSES.join(", ")}`, 400);

  const message = await ContactMessage.findByIdAndUpdate(req.params.id, { status }, { returnDocument: "after" });
  if (!message) throw new AppError("Message not found", 404);
  res.status(200).json({ success: true, message: `Message marked as ${status.toLowerCase()}`, data: message });
};

// @desc    Delete a contact message
// @route   DELETE /api/contact-messages/:id
// @access  contactMessages.delete
export const deleteContactMessage = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "Message ID");
  const message = await ContactMessage.findByIdAndDelete(req.params.id);
  if (!message) throw new AppError("Message not found", 404);
  res.status(200).json({ success: true, message: "Message deleted successfully", data: { _id: message._id } });
};
