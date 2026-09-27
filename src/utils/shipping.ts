import SiteSetting from "../models/SiteSetting";
import { SHIPPING } from "../config/orderOptions";

export const SHIPPING_KEY = "shipping";

export interface ShippingConfig {
  // Delivery charge (BDT) when the city is Dhaka
  insideDhaka: number;
  // Delivery charge (BDT) for every other city
  outsideDhaka: number;
  // Orders at or above this product total ship free; 0 = never free
  freeShippingMinimum: number;
}

// Values from .env (or code defaults) until an admin saves new ones
export const defaultShippingConfig = (): ShippingConfig => ({
  insideDhaka: SHIPPING.INSIDE_DHAKA,
  outsideDhaka: SHIPPING.OUTSIDE_DHAKA,
  freeShippingMinimum: SHIPPING.FREE_SHIPPING_MIN,
});

// Current delivery charges: saved settings over the defaults
export const getShippingConfig = async (): Promise<ShippingConfig> => {
  const doc = await SiteSetting.findOne({ key: SHIPPING_KEY }).lean();
  return { ...defaultShippingConfig(), ...((doc?.value || {}) as Partial<ShippingConfig>) };
};

export const isInsideDhaka = (city: string): boolean =>
  SHIPPING.DHAKA_CITIES.includes(String(city).trim().toLowerCase());

// Delivery charge for a city; free when the product total reaches the free-shipping minimum
export const calculateShippingCharge = (config: ShippingConfig, city: string, subtotal: number): number => {
  if (config.freeShippingMinimum > 0 && subtotal >= config.freeShippingMinimum) return 0;
  return isInsideDhaka(city) ? config.insideDhaka : config.outsideDhaka;
};
