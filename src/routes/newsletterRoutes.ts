import express from "express";
import rateLimit from "express-rate-limit";
import {
  subscribe,
  unsubscribe,
  getSubscribers,
  exportSubscribers,
  deleteSubscriber,
} from "../controllers/newsletterController";
import {
  createCampaign,
  getCampaigns,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  previewCampaign,
  sendTestCampaign,
  sendCampaign,
} from "../controllers/campaignController";
import { authenticate, optionalAuthenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

// Stop bots from filling the list: 10 submits per IP per 15 minutes
const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.NEWSLETTER_RATE_LIMIT) || 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts, please try again later" },
});

// Website form (no login needed)
router.post("/", newsletterLimiter, optionalAuthenticate, subscribe);
router.post("/unsubscribe", newsletterLimiter, unsubscribe);

// Admin panel
router.get("/subscribers", authenticate, requirePermission("newsletter.view"), getSubscribers);
router.get("/subscribers/export", authenticate, requirePermission("newsletter.view"), exportSubscribers);
router.delete("/subscribers/:id", authenticate, requirePermission("newsletter.delete"), deleteSubscriber);

// Campaigns: marketing emails to subscribers (new products, offers, news)
router.get("/campaigns", authenticate, requirePermission("newsletter.view"), getCampaigns);
router.post("/campaigns", authenticate, requirePermission("newsletter.send"), createCampaign);
router.get("/campaigns/:id", authenticate, requirePermission("newsletter.view"), getCampaign);
router.put("/campaigns/:id", authenticate, requirePermission("newsletter.send"), updateCampaign);
router.delete("/campaigns/:id", authenticate, requirePermission("newsletter.send"), deleteCampaign);
router.get("/campaigns/:id/preview", authenticate, requirePermission("newsletter.view"), previewCampaign);
router.post("/campaigns/:id/test", authenticate, requirePermission("newsletter.send"), sendTestCampaign);
router.post("/campaigns/:id/send", authenticate, requirePermission("newsletter.send"), sendCampaign);

export default router;
