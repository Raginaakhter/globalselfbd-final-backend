import express from "express";
import { getPublicCategories, getPublicProducts, getPublicProduct } from "../controllers/publicController";
import { getPublicBanners } from "../controllers/bannerController";
import { getPublicBrands } from "../controllers/brandController";
import { getPublicFooter } from "../controllers/settingsController";

const router = express.Router();

// Customer-facing storefront (no login)
router.get("/categories", getPublicCategories);
router.get("/products", getPublicProducts);
router.get("/products/:slug", getPublicProduct);

// Landing page content
router.get("/banners", getPublicBanners);
router.get("/brands", getPublicBrands);
router.get("/footer", getPublicFooter);

export default router;
