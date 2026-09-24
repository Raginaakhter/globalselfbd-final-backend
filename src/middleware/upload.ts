import multer from "multer";
import type { RequestHandler } from "express";
import AppError from "../utils/AppError";
import { isImageMimeType } from "../utils/imageValidation";

export const MAX_FILE_SIZE_MB = Number(process.env.UPLOAD_MAX_FILE_SIZE_MB) || 5;
export const MAX_FILES = 10;

// Files stay in memory until their content is verified, then go to storage
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (!isImageMimeType(file.mimetype)) {
      return cb(new AppError(`Invalid file type: ${file.originalname}. Allowed: JPG, PNG, WEBP, GIF`, 400));
    }
    cb(null, true);
  },
}).array("images", MAX_FILES);

const MULTER_MESSAGES: Partial<Record<multer.ErrorCode, string>> = {
  LIMIT_FILE_SIZE: `Each image must be ${MAX_FILE_SIZE_MB}MB or smaller`,
  LIMIT_FILE_COUNT: `You can upload at most ${MAX_FILES} images at once`,
  LIMIT_UNEXPECTED_FILE: 'Images must be sent in the "images" field',
};

// Wrap multer so its errors use the standard { success, message } format
export const uploadImages: RequestHandler = (req, res, next) => {
  imageUpload(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      return next(new AppError(MULTER_MESSAGES[error.code] || error.message, 400));
    }
    next(error);
  });
};
