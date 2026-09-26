import type { Request, Response } from "express";
import AppError from "../utils/AppError";
import { detectImageType } from "../utils/imageValidation";
import { storeImage, isCloudinaryConfigured } from "../utils/imageStorage";
import { queryString } from "../utils/validators";
import User from "../models/User";
import { getAuthUser } from "../middleware/auth";

const FOLDERS = ["products", "categories", "banners", "brands", "site"];

// @desc    Upload images and get their URLs (use the URLs in product/category forms)
// @route   POST /api/uploads/images?folder=products
// @access  products, categories, banners, brands or settings create/update
export const uploadImages = async (req: Request, res: Response) => {
  const folder = queryString(req.query.folder) || "products";
  if (!FOLDERS.includes(folder)) {
    throw new AppError(`folder must be one of: ${FOLDERS.join(", ")}`, 400);
  }
  const uploaded = Array.isArray(req.files) ? req.files : [];
  if (uploaded.length === 0) {
    throw new AppError('Please select at least one image (field name: "images")', 400);
  }

  // Check real file content before storing anything
  const files = uploaded.map((file) => {
    const detected = detectImageType(file.buffer);
    if (!detected) {
      throw new AppError(`${file.originalname} is not a valid image file`, 400);
    }
    return { buffer: file.buffer, mimeType: detected, originalName: file.originalname, size: file.size };
  });

  const images: { url: string; originalName: string; size: number; type: string }[] = [];
  for (const file of files) {
    const url = await storeImage({ buffer: file.buffer, mimeType: file.mimeType, folder }, req);
    images.push({ url, originalName: file.originalName, size: file.size, type: file.mimeType });
  }

  res.status(201).json({
    success: true,
    message: `${images.length} image(s) uploaded successfully`,
    data: {
      storage: isCloudinaryConfigured() ? "cloudinary" : "local",
      urls: images.map((img) => img.url),
      images,
    },
  });
};

// @desc    Upload my profile picture and set it on my account (one image)
// @route   POST /api/uploads/avatar
// @access  Private (any logged-in user)
export const uploadAvatar = async (req: Request, res: Response) => {
  const uploaded = Array.isArray(req.files) ? req.files : [];
  if (uploaded.length !== 1) {
    throw new AppError('Please select exactly one image (field name: "images")', 400);
  }
  const file = uploaded[0];
  const mimeType = detectImageType(file.buffer);
  if (!mimeType) throw new AppError(`${file.originalname} is not a valid image file`, 400);

  const url = await storeImage({ buffer: file.buffer, mimeType, folder: "avatars" }, req);
  await User.updateOne({ _id: getAuthUser(req)._id }, { $set: { avatarUrl: url } });

  res.status(201).json({
    success: true,
    message: "Profile picture updated successfully",
    data: { avatarUrl: url },
  });
};
