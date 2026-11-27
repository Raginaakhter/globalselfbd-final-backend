// Product form options. To support a new size or unit, add it here (no other change needed).
import { STATUSES } from "../types/common";

export const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "FREE"] as const;
export type Size = (typeof SIZES)[number];

export const UNITS = ["KG", "GM", "Liter", "ML", "Meter", "CM", "Piece"] as const;
export type Unit = (typeof UNITS)[number];

export { STATUSES };

export const AVAILABILITY = {
  IN_STOCK: "IN_STOCK",
  OUT_OF_STOCK: "OUT_OF_STOCK",
} as const;
export type Availability = (typeof AVAILABILITY)[keyof typeof AVAILABILITY];

// Three-way storefront state. `availability` above stays two-valued for API
// compatibility (pre-order counts as IN_STOCK = purchasable).
export const AVAILABILITY_STATUS = {
  IN_STOCK: "IN_STOCK",
  PRE_ORDER: "PRE_ORDER",
  OUT_OF_STOCK: "OUT_OF_STOCK",
} as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUS)[keyof typeof AVAILABILITY_STATUS];

// Limits used by validation
export const LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 5000,
  CATEGORY_NAME_MAX: 100,
  CATEGORY_DESCRIPTION_MAX: 1000,
  SLUG_MAX: 120,
  GALLERY_MAX: 10,
  URL_MAX: 2048,
  CATEGORY_DEPTH_MAX: 5,
} as const;
