import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { Request } from "express";
import { v2 as cloudinary } from "cloudinary";
import { IMAGE_TYPES, type ImageMimeType } from "./imageValidation";

// Works from both src/utils (tsx) and dist/utils (compiled): <project>/uploads
export const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

export const isCloudinaryConfigured = (): boolean =>
  Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

const uploadToCloudinary = (buffer: Buffer, folder: string): Promise<string> => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `globalshelfbd/${folder}`, resource_type: "image" },
      (error, result) => (error || !result ? reject(error || new Error("Upload failed")) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
};

// Development fallback when Cloudinary is not configured: save under /uploads.
// Not for production (files are lost when the server's disk is reset).
const uploadToLocalDisk = async (buffer: Buffer, mimeType: ImageMimeType, folder: string, req: Request): Promise<string> => {
  const dir = path.join(UPLOAD_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${IMAGE_TYPES[mimeType]}`;
  await fs.writeFile(path.join(dir, fileName), buffer);
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  return `${baseUrl.replace(/\/+$/, "")}/uploads/${folder}/${fileName}`;
};

// Upload one validated image and return its public URL
export const storeImage = async (
  { buffer, mimeType, folder }: { buffer: Buffer; mimeType: ImageMimeType; folder: string },
  req: Request
): Promise<string> =>
  isCloudinaryConfigured() ? uploadToCloudinary(buffer, folder) : uploadToLocalDisk(buffer, mimeType, folder, req);
