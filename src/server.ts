// Must be the first import: loads .env before any module reads process.env
import "dotenv/config";

import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import connectDB from "./config/db";
import { seedDatabase } from "./config/seed";
import errorHandler from "./middleware/errorHandler";
import { UPLOAD_DIR } from "./utils/imageStorage";
import authRoutes from "./routes/authRoutes";
import roleRoutes from "./routes/roleRoutes";
import userRoutes from "./routes/userRoutes";
import permissionRoutes from "./routes/permissionRoutes";
import activityLogRoutes from "./routes/activityLogRoutes";
import categoryRoutes from "./routes/categoryRoutes";
import productRoutes from "./routes/productRoutes";
import uploadRoutes from "./routes/uploadRoutes";
import publicRoutes from "./routes/publicRoutes";
import cartRoutes from "./routes/cartRoutes";
import orderRoutes from "./routes/orderRoutes";
import adminOrderRoutes from "./routes/adminOrderRoutes";
import bannerRoutes from "./routes/bannerRoutes";
import brandRoutes from "./routes/brandRoutes";
import settingsRoutes from "./routes/settingsRoutes";
import reportRoutes from "./routes/reportRoutes";
import newsletterRoutes from "./routes/newsletterRoutes";
import { contactRouter, contactMessagesRouter } from "./routes/contactRoutes";
import couponRoutes from "./routes/couponRoutes";
import comboRoutes from "./routes/comboRoutes";
import offerRoutes from "./routes/offerRoutes";
import invoiceRoutes from "./routes/invoiceRoutes";
import { reviewRouter, adminReviewRouter } from "./routes/reviewRoutes";

// docs/ sits next to src/ and dist/, so this path works in dev and after build
const swaggerDocument = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "swagger.json"), "utf8"));

const app = express();

// Behind a hosting proxy (Render, Railway, Nginx) set TRUST_PROXY=1 so each visitor's real IP
// is used for rate limits and logs. Leave it unset when the app is reached directly.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

// ----- Middleware -----
// Frontend URLs allowed to call the API, comma-separated in CLIENT_URL
// (e.g. "http://localhost:5173,http://localhost:3000,https://globalshelfbd.com")
const allowedOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    // Requests without an Origin header (Postman, server-to-server, Swagger on the same host) are allowed
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true, // allow the refresh token cookie
  })
);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(cookieParser());

// HTTP request logger (dev only)
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// ----- Routes -----
// Security headers for the API (Swagger UI needs its own inline assets, so it is excluded)
app.use("/api", helmet());
app.use("/api/auth", authRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/users", userRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/activity-logs", activityLogRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin/orders", adminOrderRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api/brands", brandRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/contact", contactRouter);
app.use("/api/contact-messages", contactMessagesRouter);
app.use("/api/coupons", couponRoutes);
app.use("/api/combos", comboRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/reviews", reviewRouter);
app.use("/api/admin/reviews", adminReviewRouter);

// Locally stored images (used only when Cloudinary is not configured)
app.use(
  "/uploads",
  helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }),
  express.static(UPLOAD_DIR, { index: false, dotfiles: "deny", maxAge: "7d" })
);

// API docs (Swagger UI)
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocument, {
    swaggerOptions: { persistAuthorization: true },
  })
);

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "🚀 GlobalSelfBD API is running",
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.originalUrl}`,
  });
});

// Error handler
app.use(errorHandler);

// ----- Start Server -----
// Connect + seed roles/permissions before accepting requests
const start = async (): Promise<void> => {
  await connectDB();
  await seedDatabase();

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  });
};

start().catch((error: Error) => {
  console.error("❌ Failed to start server:", error.message);
  process.exit(1);
});
