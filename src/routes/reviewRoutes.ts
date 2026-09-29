import express from "express";
import {
  createReview,
  getReviewEligibility,
  getMyReviews,
  getHomepageReviews,
  getAdminReviews,
  getAdminReview,
  updateReviewStatus,
  updateReviewHomepage,
  updateReviewProducts,
  deleteReview,
} from "../controllers/reviewController";
import { authenticate, requirePermission } from "../middleware/auth";

// Customer + public: /api/reviews
export const reviewRouter = express.Router();

reviewRouter.get("/homepage", getHomepageReviews);
reviewRouter.get("/eligibility", authenticate, getReviewEligibility);
reviewRouter.get("/my", authenticate, getMyReviews);
reviewRouter.post("/", authenticate, requirePermission("reviews.create"), createReview);

// Admin panel: /api/admin/reviews
export const adminReviewRouter = express.Router();

adminReviewRouter.use(authenticate);
adminReviewRouter.get("/", requirePermission("reviews.view"), getAdminReviews);
adminReviewRouter.get("/:id", requirePermission("reviews.view"), getAdminReview);
adminReviewRouter.patch("/:id/status", requirePermission("reviews.update"), updateReviewStatus);
adminReviewRouter.patch("/:id/homepage", requirePermission("reviews.update"), updateReviewHomepage);
adminReviewRouter.put("/:id/products", requirePermission("reviews.update"), updateReviewProducts);
adminReviewRouter.delete("/:id", requirePermission("reviews.delete"), deleteReview);
