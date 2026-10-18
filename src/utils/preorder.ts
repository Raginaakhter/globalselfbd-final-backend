import SiteSetting from "../models/SiteSetting";
import { PRE_ORDER } from "../config/orderOptions";

export const PREORDER_KEY = "preorder";

export interface PreorderConfig {
  // When true, a product whose available stock drops to 0 auto-switches to
  // isPreOrder=true (source=AUTO). Re-stock reverts the flag only for AUTO
  // pre-orders — a MANUAL pre-order is never overwritten.
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
