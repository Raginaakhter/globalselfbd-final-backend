import SiteSetting from "../models/SiteSetting";
import type { PreOrderSource } from "../models/Product";
import { PRE_ORDER } from "../config/orderOptions";

export const PREORDER_KEY = "preorder";

export interface PreorderConfig {
  // When true, a product whose available stock drops to 0 auto-switches to
  // isPreOrder=true (source=AUTO) unless the admin turned pre-order off for it
  // (source=DISABLED). Products the admin enabled (MANUAL) pre-order whenever
  // they are out of stock, regardless of this setting.
  autoEnableOnStockOut: boolean;
  // Minimum delivery window applied when auto-enabling pre-order. Floored at
  // PRE_ORDER.MIN_DELIVERY_DAYS by the model validator; the admin may raise it.
  defaultPreOrderDays: number;
}

export const defaultPreorderConfig = (): PreorderConfig => ({
  autoEnableOnStockOut: true,
  defaultPreOrderDays: PRE_ORDER.MIN_DELIVERY_DAYS,
});

export const getPreorderConfig = async (): Promise<PreorderConfig> => {
  const doc = await SiteSetting.findOne({ key: PREORDER_KEY }).lean();
  return { ...defaultPreorderConfig(), ...((doc?.value || {}) as Partial<PreorderConfig>) };
};

export const clampPreOrderDays = (days: number): number =>
  Math.min(Math.max(Math.round(days) || 0, PRE_ORDER.MIN_DELIVERY_DAYS), PRE_ORDER.MAX_DELIVERY_DAYS);

// May this product sell as pre-order when it runs out of stock?
export const isPreOrderEligible = (
  source: PreOrderSource | null | undefined,
  config: Pick<PreorderConfig, "autoEnableOnStockOut">
): boolean => {
  if (source === "MANUAL") return true;
  if (source === "DISABLED") return false;
  return config.autoEnableOnStockOut;
};

// Apply the admin's pre-order switch to a product (before saving). The switch says
// whether the product MAY sell as pre-order; whether it is in pre-order mode right
// now is decided afterwards by syncPreOrderState from available stock.
//   enabled=true  → MANUAL (the admin's delivery days are kept across restocks)
//   enabled=false → DISABLED when it would otherwise be eligible, so the site-wide
//                   auto rule doesn't switch it back on; delivery days reset to 0.
export const applyPreOrderChoice = (
  product: { isPreOrder: boolean; preOrderSource?: PreOrderSource | null; preOrderMinDays: number },
  enabled: boolean,
  config: PreorderConfig
): void => {
  if (enabled) {
    product.preOrderSource = "MANUAL";
    return;
  }
  if (isPreOrderEligible(product.preOrderSource, config)) product.preOrderSource = "DISABLED";
  product.isPreOrder = false;
  product.preOrderMinDays = 0;
};
