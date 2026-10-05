// The kinds the owner keeps by hand. Kept apart from accounts.ts, which
// reads the database, so the Accounts page (a client component) can list them.
export const MANUAL_KINDS = ["property", "vehicle", "cash", "investment", "other", "loan"] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];

// How many days of balances the net worth line waits for (accounts.ts uses it
// too; here so the page can say the day it starts).
export const TREND_MIN_DAYS = 14;

// An estimate is meant to be revisited: one more than a year old says so.
const YEAR_MS = 365 * 24 * 3600 * 1000;
export const olderThanAYear = (asOf: string, today: string) =>
  Date.parse(today + "T00:00:00Z") - Date.parse(asOf + "T00:00:00Z") > YEAR_MS;
