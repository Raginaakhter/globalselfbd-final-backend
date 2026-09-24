import express from "express";
import rateLimit from "express-rate-limit";
const router = express.Router();
import { register, login, refreshToken, logout, getMe, forgotPassword, verifyResetOtp, resetPassword } from "../controllers/authController";
import { authenticate } from "../middleware/auth";

// Brute-force protection for login/register/password endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts, please try again after 15 minutes" },
});

router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/refresh-token", refreshToken);
router.post("/logout", logout);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/verify-reset-otp", authLimiter, verifyResetOtp);
router.post("/reset-password", authLimiter, resetPassword);
router.get("/me", authenticate, getMe);

export default router;
