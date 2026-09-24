import express from "express";
const router = express.Router();
import { getPublicCategories, getPublicProducts, getPublicProduct } from "../controllers/publicController";

// Customer-facing storefront (no login)
router.get("/categories", getPublicCategories);
router.get("/products", getPublicProducts);
router.get("/products/:slug", getPublicProduct);

export default router;
