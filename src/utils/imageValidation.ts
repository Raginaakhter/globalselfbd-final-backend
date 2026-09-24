import { LIMITS } from "../config/productOptions";

// Allowed upload types. SVG is excluded on purpose (it can contain scripts).
export const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;
export type ImageMimeType = keyof typeof IMAGE_TYPES;

export const isImageMimeType = (value: string): value is ImageMimeType => value in IMAGE_TYPES;

// Detect the real image type from the file's first bytes (the client's mimetype can lie)
export const detectImageType = (buffer: Buffer | undefined): ImageMimeType | null => {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  return null;
};

// Image URLs saved in the database must be absolute http(s) URLs
export const isValidImageUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.trim() || value.length > LIMITS.URL_MAX) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};
