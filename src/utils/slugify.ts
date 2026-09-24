import type { Model, Types } from "mongoose";

// "Men's Clothing & Shoes" -> "mens-clothing-and-shoes"
// Unicode letters (e.g. Bangla) are kept so non-English names still get a slug.
export const slugify = (text: unknown): string =>
  String(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");

const SLUG_REGEX = /^[\p{Ll}\p{Lo}\p{N}\p{M}]+(?:-[\p{Ll}\p{Lo}\p{N}\p{M}]+)*$/u;

export const isValidSlug = (slug: unknown): boolean =>
  typeof slug === "string" && slug.length <= 120 && SLUG_REGEX.test(slug);

// Find a free slug: "t-shirt", then "t-shirt-2", "t-shirt-3", ...
export const uniqueSlug = async <T>(Model: Model<T>, base: string, excludeId?: Types.ObjectId): Promise<string> => {
  const root = base || "item";
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? root : `${root}-${i}`;
    const filter: Record<string, unknown> = { slug: candidate };
    if (excludeId) filter._id = { $ne: excludeId };
    if (!(await Model.exists(filter))) return candidate;
  }
  return `${root}-${Date.now()}`;
};
