import express from "express";
const router = express.Router();
import { getProductOptions, createProduct, getProducts, getProduct, updateProduct, updateProductStatus, updateProductStock, updateProductGallery, deleteProduct } from "../controllers/productController";
import { authenticate, optionalAuthenticate, requirePermission, requireAnyPermission } from "../middleware/auth";

// Must be before "/:id"
router.get("/options", authenticate, requireAnyPermission("products.create", "products.update"), getProductOptions);

// Browsing works for guests too (customer view: ACTIVE only, no stock/cost).
// Logged-in users see more depending on their permissions.
router.get("/", optionalAuthenticate, getProducts);
router.get("/:id", optionalAuthenticate, getProduct);

router.post("/", authenticate, requirePermission("products.create"), createProduct);
router.put("/:id", authenticate, requirePermission("products.update"), updateProduct);
router.patch("/:id/status", authenticate, requirePermission("products.update"), updateProductStatus);
router.patch("/:id/stock", authenticate, requirePermission("inventory.update"), updateProductStock);
router.patch("/:id/gallery", authenticate, requirePermission("products.update"), updateProductGallery);
router.delete("/:id", authenticate, requirePermission("products.delete"), deleteProduct);

export default router;
