export const STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type Status = (typeof STATUSES)[number];
