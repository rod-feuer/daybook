// Shared domain types. Amounts are in dollars: negative = expense, positive = income.

export type Category = {
  id: number;
  name: string;
  color: string; // hex
  icon: string; // emoji, kept simple for the prototype
  kind: "expense" | "income";
  excludeFromTotals: 0 | 1; // when set, its transactions are omitted from totals
};

export type Transaction = {
  id: number;
  date: string; // ISO yyyy-mm-dd
  merchant: string;
  amount: number;
  categoryId: number | null;
  account: string;
  effectiveDate: string | null; // user overlay: the month this charge counts in (null = posted date)
  pending: 0 | 1;
  excluded: 0 | 1; // mirrors Copilot's "excluded" + internal transfers; omitted from totals
  recurringId: number | null;
  source: string; // "seed" | "csv" | "mcp"
  note: string | null; // free-text per-transaction memo (null = none)
  pendingAmount?: number | null; // what it showed while pending, when it posted for another amount
  hash: string; // dedupe key
};

export type TransactionWithCategory = Transaction & {
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  categoryExcluded: number; // 1 if the category is flagged excludeFromTotals
  displayName: string; // alias-resolved name for the UI (raw merchant otherwise)
};

// A learned merchant -> category mapping. Written once when Claude (or a human)
// classifies a new merchant, then reused for free forever after. (CLAUDE.md Rule 6)
export type Rule = {
  id: number;
  pattern: string; // lowercased merchant substring
  categoryId: number;
  origin: string; // "seed" | "claude" | "user"
};

export type Recurring = {
  id: number;
  merchant: string;
  categoryId: number | null;
  avgAmount: number;
  cadence: "weekly" | "biweekly" | "monthly" | "bimonthly" | "quarterly" | "semiannual" | "yearly";
  lastDate: string;
  nextDate: string;
  count: number;
};
