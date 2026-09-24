import type { ErrorRequestHandler } from "express";

interface HandledError {
  message?: string;
  name?: string;
  code?: number;
  path?: string;
  type?: string;
  statusCode?: number;
  isOperational?: boolean;
  keyValue?: Record<string, unknown>;
  keyPattern?: Record<string, unknown>;
  errors?: Record<string, { message: string }>;
}

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const err = error as HandledError;

  // Expected errors (AppError) are not noise; log only unexpected ones in full
  if (!err.isOperational) {
    console.error("❌ Error:", error);
  }

  // Mongoose bad ObjectId
  if (err.name === "CastError") {
    res.status(400).json({ success: false, message: `Invalid ${err.path}` });
    return;
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || err.keyPattern || { value: 1 })[0];
    res.status(409).json({ success: false, message: `Duplicate value for '${field}'. This ${field} already exists.` });
    return;
  }

  // Mongoose validation error
  if (err.name === "ValidationError" && err.errors) {
    const messages = Object.values(err.errors).map((val) => val.message);
    res.status(400).json({ success: false, message: messages.join(", ") });
    return;
  }

  // Invalid JSON body
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ success: false, message: "Invalid JSON in request body" });
    return;
  }

  // Body too large
  if (err.type === "entity.too.large") {
    res.status(413).json({ success: false, message: "Request body is too large" });
    return;
  }

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    // Hide internal error details from clients
    message: statusCode === 500 ? "Internal Server Error" : err.message,
  });
};

export default errorHandler;
