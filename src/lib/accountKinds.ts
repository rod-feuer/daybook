// The kinds the owner keeps by hand. Kept apart from accounts.ts, which
// reads the database, so the Accounts page (a client component) can list them.
export const MANUAL_KINDS = ["property", "vehicle", "cash", "investment", "other", "loan"] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];
