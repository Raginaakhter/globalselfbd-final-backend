import express from "express";
const router = express.Router();
import { getCart, addToCart, updateCartItem, removeCartItem, clearCart } from "../controllers/cartController";
import { authenticate, requirePermission } from "../middleware/auth";

// A user can only ever reach their own cart
router.use(authenticate, requirePermission("cart.manage"));

router.get("/", getCart);
router.post("/", addToCart);
router.delete("/", clearCart);
router.put("/:itemId", updateCartItem);
router.delete("/:itemId", removeCartItem);

export default router;
