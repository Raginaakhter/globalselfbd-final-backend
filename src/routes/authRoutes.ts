import express from "express";
import rateLimit from "express-rate-limit";
const router = express.Router();
import {
  register,
  login,
  refreshToken,
  logout,
  getMe,
  updateMe,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  requestLoginOtp,
  verifyLoginOtp,
} from "../controllers/authController";
import { authenticate } from "../middleware/auth";

// Brute-force protection for login/register/password endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts, please try again after 15 minutes" },
});

// Passwordless customer flow (OTP via email; phone/SMS OTP is temporarily commented out)
router.post("/request-otp", authLimiter, requestLoginOtp);
router.post("/verify-otp", authLimiter, verifyLoginOtp);

// Legacy password-based endpoints: kept for admin accounts (seeded with passwords).
// Customers created through the OTP flow log in with email OTP.
// Phone registration is commented out; email login is active.
router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/refresh-token", refreshToken);
router.post("/logout", logout);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/verify-reset-otp", authLimiter, verifyResetOtp);
router.post("/reset-password", authLimiter, resetPassword);
router.get("/me", authenticate, getMe);
router.put("/me", authenticate, updateMe);

export default router;
