import express from "express";
import {
  getPublicCategories,
  getPublicProducts,
  getPublicProduct,
  getPublicCombos,
  getPublicCombo,
  getPublicOffers,
  getPublicOffer,
} from "../controllers/publicController";
import { getPublicBanners } from "../controllers/bannerController";
import { getPublicBrands } from "../controllers/brandController";
import { getPublicFooter, getPublicShipping } from "../controllers/settingsController";

const router = express.Router();

// Customer-facing storefront (no login)
router.get("/categories", getPublicCategories);
router.get("/products", getPublicProducts);
router.get("/products/:slug", getPublicProduct);

// Combos
router.get("/combos", getPublicCombos);
router.get("/combos/:slug", getPublicCombo);

// Offer campaigns
router.get("/offers", getPublicOffers);
router.get("/offers/:slug", getPublicOffer);

// Landing page content
router.get("/banners", getPublicBanners);
router.get("/brands", getPublicBrands);
router.get("/footer", getPublicFooter);
router.get("/shipping", getPublicShipping);

export default router;
