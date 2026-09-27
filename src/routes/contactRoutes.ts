import express from "express";
import rateLimit from "express-rate-limit";
import {
  createContactMessage,
  getContactMessages,
  updateContactMessageStatus,
  deleteContactMessage,
} from "../controllers/contactController";
import { authenticate, optionalAuthenticate, requirePermission } from "../middleware/auth";

// Website form: POST /api/contact
export const contactRouter = express.Router();

// Stop spam: 5 messages per IP per 15 minutes
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.CONTACT_RATE_LIMIT) || 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many messages, please try again later" },
});

contactRouter.post("/", contactLimiter, optionalAuthenticate, createContactMessage);

// Admin panel: /api/contact-messages
export const contactMessagesRouter = express.Router();

contactMessagesRouter.use(authenticate);
contactMessagesRouter.get("/", requirePermission("contactMessages.view"), getContactMessages);
contactMessagesRouter.patch("/:id/status", requirePermission("contactMessages.update"), updateContactMessageStatus);
contactMessagesRouter.delete("/:id", requirePermission("contactMessages.delete"), deleteContactMessage);
