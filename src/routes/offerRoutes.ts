import express from "express";
import {
  getOffers,
  getOffer,
  createOffer,
  updateOffer,
  updateOfferStatus,
  deleteOffer,
  addProductsToOffer,
  removeProductFromOffer,
} from "../controllers/offerController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.get("/", authenticate, requirePermission("offers.view"), getOffers);
router.post("/", authenticate, requirePermission("offers.create"), createOffer);
router.get("/:id", authenticate, requirePermission("offers.view"), getOffer);
router.patch("/:id", authenticate, requirePermission("offers.update"), updateOffer);
router.patch("/:id/status", authenticate, requirePermission("offers.update"), updateOfferStatus);
router.delete("/:id", authenticate, requirePermission("offers.delete"), deleteOffer);

// Product membership
router.post(
  "/:id/products",
  authenticate,
  requirePermission("offers.update"),
  addProductsToOffer
);
router.delete(
  "/:id/products/:productId",
  authenticate,
  requirePermission("offers.update"),
  removeProductFromOffer
);

export default router;
