import { splitDriftFor, splitRules, splitRulesFor, type SplitDrift } from "./splits";
import { isSeriesKey, seriesVendor, seriesKey, amountLabel, dayLabel, SERIES_SEP } from "./series";
import { displayMerchant, merchantKey } from "./merchant";
import {
  getDb,
  ensureRecurringSettings,
  ensureMerchantLinks,
  ensureRecurringTxExclusions,
  ensureRecurringTxInclusions,
} from "./db";
import type { TransactionWithCategory, Recurring, Category } from "./types";
import { nameAffinity, LOW_MATCH } from "./similarity";
import { CADENCE_DAYS, PER_YEAR, monthlyFactor, medianGap, type Cadence } from "./cadence";

// ---- Merchant linking ----------------------------------------------------
// User-declared "these descriptors are the same vendor" (e.g. a gas bill whose
// payment descriptor changed). Folds aliases onto a primary everywhere we group
// by merchant. See canonicalMerchant / linkedAliases.
export function getMerchantLinks(): Record<string, string> {
  const db = getDb();
  ensureMerchantLinks(db);
  const rows = db
    .prepare("SELECT alias, primaryMerchant FROM merchant_links")
    .all() as { alias: string; primaryMerchant: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.alias] = r.primaryMerchant;
  return out;
}

// Resolve a merchant to its canonical (primary) name, following the link chain
// with a guard so a cycle/long chain can't loop forever.
export function canonicalMerchant(m: string, links: Record<string, string>): string {
  let cur = m;
  for (let i = 0; i < 10 && links[cur] && links[cur] !== cur; i++) cur = links[cur];
  return cur;
}

// All merchant strings that resolve to `primary` (the primary itself + aliases).
export function linkedAliases(primary: string, links: Record<string, string>): string[] {
  const out = [primary];
  for (const alias of Object.keys(links))
    if (alias !== primary && canonicalMerchant(alias, links) === primary) out.push(alias);
  return out;
}

export function linkMerchant(alias: string, primary: string) {
  const db = getDb();
  ensureMerchantLinks(db);
  const links = getMerchantLinks();
  const target = canonicalMerchant(primary, links); // flatten chains
  if (!alias || !target || alias === target) return;
  db.prepare(
    `INSERT INTO merchant_links (alias, primaryMerchant) VALUES (?, ?)
     ON CONFLICT(alias) DO UPDATE SET primaryMerchant = excluded.primaryMerchant`
  ).run(alias, target);
}

export function unlinkMerchant(alias: string) {
  const db = getDb();
  ensureMerchantLinks(db);
  db.prepare("DELETE FROM merchant_links WHERE alias = ?").run(alias);
}

// The single source of truth for what a merchant is *called* in the UI: the
// user's name for its vendor, else the vendor's own name. Used by the drawer,
// transactions list, and dashboard recent so a rename or a combine shows
// everywhere. "Its vendor" is the point: a combined bank name that fell back to
// itself kept reading "Young Mens Chris" beside the "Ymca" rows it had joined,
// so a combine that worked looked like one that failed.
export function merchantDisplayName(
  merchant: string,
  settings: Record<string, RecurringSettings>,
  links: Record<string, string>
): string {
  const vendor = canonicalMerchant(merchant, links);
  return settings[vendor]?.alias ?? displayMerchant(vendor);
}

// The names the user gave to plans that share a bank descriptor, by plan id.
// "In 529 Dir Ach Contrib" carries two plans — $200 for one child, $300 for the
// other — each named on the Recurrings page. A charge is linked to its plan, so
// it can carry that name; naming it by vendor alone made both read as the bank
// string on every page but Recurrings. Only names the user set: the detector's
// own label ("… · $200") beside a $200.00 amount says the same thing twice.
export function planNames(settings: Record<string, RecurringSettings>): Map<number, string> {
  const out = new Map<number, string>();
  const named = Object.keys(settings).filter((k) => isSeriesKey(k) && settings[k].alias);
  if (!named.length) return out;
  const rows = getDb()
    .prepare(`SELECT id, merchant FROM recurrings WHERE merchant IN (${named.map(() => "?").join(",")})`)
    .all(...named) as { id: number; merchant: string }[];
  for (const r of rows) out.set(r.id, settings[r.merchant].alias as string);
  return out;
}

// What a CHARGE is called: its plan's name when the user gave it one, else its
// vendor's. (A vendor is still called by merchantDisplayName: the vendor
// picker lists vendors, not charges.)
export function chargeDisplayName(
  row: { merchant: string; recurringId: number | null },
  settings: Record<string, RecurringSettings>,
  links: Record<string, string>,
  plans: Map<number, string>
): string {
  return (row.recurringId != null ? plans.get(row.recurringId) : undefined) ?? merchantDisplayName(row.merchant, settings, links);
}

// Distinct merchant strings with transaction counts — powers the link picker.
export function distinctMerchants(): { merchant: string; count: number }[] {
  return getDb()
    .prepare(
      "SELECT merchant, COUNT(*) AS count FROM transactions GROUP BY merchant ORDER BY count DESC"
    )
    .all() as { merchant: string; count: number }[];
}

// One entry per VENDOR (canonical merchant, descriptors folded together) with its
// friendly display name — for the combine picker, so it lists "Central Indiana
// Academy of Dance" once instead of every raw bank descriptor.
export function distinctVendors(): { merchant: string; displayName: string; count: number }[] {
  const db = getDb();
  const links = getMerchantLinks();
  const settings = getRecurringSettings();
  const rows = db
    .prepare("SELECT merchant, COUNT(*) AS count FROM transactions GROUP BY merchant")
    .all() as { merchant: string; count: number }[];
  const byCanon = new Map<string, number>();
  for (const r of rows) {
    const canon = canonicalMerchant(r.merchant, links);
    byCanon.set(canon, (byCanon.get(canon) ?? 0) + r.count);
  }
  return [...byCanon.entries()]
    .map(([merchant, count]) => ({
      merchant,
      displayName: merchantDisplayName(merchant, settings, links),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName));
}

export type MatchRule = {
  matchMode: "exact" | "contains";
  matchText: string | null;
  amountTolerance: number | null; // fraction (0.05 = ±5%); null = any amount
};

// All per-recurring user settings (keyed by merchant). null = unset / use default.
export type RecurringSettings = {
  matchMode: "exact" | "contains" | null;
  matchText: string | null;
  amountTolerance: number | null;
  alias: string | null;
  expectedAmount: number | null; // go-forward expected magnitude (positive)
  cadence: Recurring["cadence"] | null;
  nextDate: string | null;
  endedDate: string | null; // user marked the subscription ended/canceled on this date
};
const EMPTY_SETTINGS: RecurringSettings = {
  matchMode: null,
  matchText: null,
  amountTolerance: null,
  alias: null,
  expectedAmount: null,
  cadence: null,
  nextDate: null,
  endedDate: null,
};

// A recurring is "ended" when the user marked it canceled AND no charge has
// landed since that date. A later charge (resubscribed, or a final clear)
// auto-reactivates it — never silently hide a real future charge.
export function recurringEnded(
  endedDate: string | null | undefined,
  lastDate: string
): boolean {
  return !!endedDate && lastDate <= endedDate;
}

export function getRecurringSettings(): Record<string, RecurringSettings> {
  const db = getDb();
  ensureRecurringSettings(db);
  const rows = db
    .prepare(
      "SELECT merchant, matchMode, matchText, amountTolerance, alias, expectedAmount, cadence, nextDate, endedDate FROM recurring_settings"
    )
    .all() as ({ merchant: string } & RecurringSettings)[];
  const out: Record<string, RecurringSettings> = {};
  for (const r of rows) {
    const { merchant, ...rest } = r;
    out[merchant] = rest;
  }
  return out;
}

// Merge a partial patch into a merchant's settings (upsert). Deletes the row
// once every field is back to null so the table doesn't accrue empty rows.
export function setRecurringSetting(merchant: string, patch: Partial<RecurringSettings>) {
  const db = getDb();
  ensureRecurringSettings(db);
  const cur = (db
    .prepare("SELECT * FROM recurring_settings WHERE merchant = ?")
    .get(merchant) as RecurringSettings | undefined) ?? EMPTY_SETTINGS;
  const merged = { ...EMPTY_SETTINGS, ...cur, ...patch, merchant };
  const allNull = Object.entries(merged).every(([k, v]) => k === "merchant" || v == null);
  if (allNull) {
    db.prepare("DELETE FROM recurring_settings WHERE merchant = ?").run(merchant);
    return;
  }
  db.prepare(
    `INSERT INTO recurring_settings
       (merchant, matchMode, matchText, amountTolerance, alias, expectedAmount, cadence, nextDate, endedDate)
     VALUES (@merchant, @matchMode, @matchText, @amountTolerance, @alias, @expectedAmount, @cadence, @nextDate, @endedDate)
     ON CONFLICT(merchant) DO UPDATE SET
       matchMode = excluded.matchMode, matchText = excluded.matchText,
       amountTolerance = excluded.amountTolerance, alias = excluded.alias,
       expectedAmount = excluded.expectedAmount, cadence = excluded.cadence,
       nextDate = excluded.nextDate, endedDate = excluded.endedDate`
  ).run(merged);
}

// "Reset all" on a recurring: drop every user override (rename, amount, cadence,
// next-due, matching) but NOT endedDate. Ended is a fact about the subscription,
// not a tuning of its detection — wiping it would silently reactivate a
// canceled bill and put it back into expected outflow.
export function resetRecurringOverrides(merchant: string) {
  setRecurringSetting(merchant, {
    alias: null,
    expectedAmount: null,
    cadence: null,
    nextDate: null,
    matchMode: null,
    matchText: null,
    amountTolerance: null,
  });
}

// Confirm a plan: freeze it as it stands now, from its live recurrings row.
// A plan key that could be rebuilt differently needs it: one split off a
// vendor ("V · 25th"), or a vendor's bare key while it carries other plans.
// A single-plan vendor's bare key is its own name and already stable, so it
// is left derived. Confirming twice keeps the first: a confirmed plan
// changes only through its own edits. False when there is nothing to confirm.
export function confirmPlan(key: string): boolean {
  const db = getDb();
  const live = db
    .prepare("SELECT merchant, avgAmount, cadence, lastDate FROM recurrings WHERE merchant = ?")
    .get(key) as { merchant: string; avgAmount: number; cadence: string; lastDate: string } | undefined;
  if (!live) return false;
  const links = getMerchantLinks();
  const vendor = canonicalMerchant(seriesVendor(key), links);
  if (!isSeriesKey(key)) {
    const siblings = (db.prepare("SELECT merchant FROM recurrings").all() as { merchant: string }[]).filter(
      (r) => canonicalMerchant(seriesVendor(r.merchant), links) === vendor
    ).length;
    if (siblings < 2) return false;
  }
  const added = db
    .prepare(
      `INSERT OR IGNORE INTO plans (key, vendor, amount, day, cadence, categoryId, anchorDate)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(key, vendor, Number(live.avgAmount.toFixed(2)), Number(live.lastDate.slice(8, 10)), live.cadence, live.lastDate).changes;
  // Its charges as they stand: the plan keeps them whatever they cost. Not a
  // charge of the other sign the detector let in (a refund at a bill's price
  // posted near its day): a refund is not the bill.
  if (added)
    db.prepare(
      `INSERT OR IGNORE INTO plan_charges (hash, key)
       SELECT t.hash, ? FROM transactions t JOIN recurrings r ON r.id = t.recurringId
       WHERE r.merchant = ? AND (t.amount < 0) = (r.avgAmount < 0)`
    ).run(key, key);
  return true;
}

// Undo a confirmation (Not recurring, Reset all): the plan is derived again.
export function unconfirmPlan(key: string) {
  const db = getDb();
  db.prepare("DELETE FROM plans WHERE key = ?").run(key);
  db.prepare("DELETE FROM plan_charges WHERE key = ?").run(key);
}

// "Not recurring" on a plan un-confirms that plan; on a vendor, every plan of
// it (a muted vendor's confirmed plans would otherwise keep their charges).
export function unconfirmPlansFor(merchant: string) {
  const db = getDb();
  const keys = isSeriesKey(merchant)
    ? [merchant]
    : (db.prepare("SELECT key FROM plans WHERE vendor = ?").all(canonicalMerchant(merchant, getMerchantLinks())) as { key: string }[]).map((r) => r.key);
  for (const k of keys) unconfirmPlan(k);
}

// The user put a charge in a plan: that confirms it. When the charge is the
// plan's newest, the plan follows it to its price (a rise's first charge), so
// next month's charge at the new price joins on its own.
export function planTookCharge(key: string, txId: number) {
  if (!confirmPlan(key)) return;
  const db = getDb();
  const t = db
    .prepare("SELECT COALESCE(effectiveDate, date) AS date, amount FROM transactions WHERE id = ?")
    .get(txId) as { date: string; amount: number } | undefined;
  if (t) db.prepare("UPDATE plans SET amount = ? WHERE key = ? AND anchorDate <= ?").run(t.amount, key, t.date);
}

// Merchant strings to match for a text search: every descriptor of any vendor
// whose own name, original bank descriptor (rawMerchant), canonical name, or
// user alias contains the query — then expanded across linked variants so a
// combined vendor matches as one unit (and you can search by the friendly name
// you set, not just the raw descriptor).
function vendorSearchMerchants(ql: string): string[] {
  const db = getDb();
  const links = getMerchantLinks();
  const settings = getRecurringSettings();
  const rows = db
    .prepare("SELECT DISTINCT merchant, rawMerchant FROM transactions")
    .all() as { merchant: string; rawMerchant: string | null }[];
  const matched = new Set<string>();
  for (const r of rows) {
    const canon = canonicalMerchant(r.merchant, links);
    const alias = settings[canon]?.alias ?? "";
    if (
      r.merchant.toLowerCase().includes(ql) ||
      (r.rawMerchant ?? "").toLowerCase().includes(ql) ||
      canon.toLowerCase().includes(ql) ||
      alias.toLowerCase().includes(ql)
    )
      matched.add(canon);
  }
  if (matched.size === 0) return [];
  const out: string[] = [];
  for (const r of rows)
    if (matched.has(canonicalMerchant(r.merchant, links))) out.push(r.merchant);
  return out;
}

export type TxFilter = {
  month?: string;
  categoryId?: number | "none";
  q?: string;
  vendor?: string;
  type?: "income" | "expense";
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  recurring?: boolean;
};

// Shared WHERE builder for the transactions list and its summary, so the paged
// rows and the count/net total always filter on byte-identical criteria.
function buildTxFilter(opts: TxFilter): { whereSql: string; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.month) {
    where.push("substr(COALESCE(t.effectiveDate, t.date),1,7) = @month");
    params.month = opts.month;
  }
  if (opts.categoryId === "none") where.push("t.categoryId IS NULL");
  else if (typeof opts.categoryId === "number") {
    where.push("t.categoryId = @cat");
    params.cat = opts.categoryId;
  }
  if (opts.q) {
    // Vendor-aware text match: include transactions whose vendor matches the
    // query by any of its descriptor variants, its canonical name, or the
    // alias/display name you've set — expanded across linked descriptors, so a
    // combined vendor (e.g. AT&T's several descriptors folded into one) matches
    // as a whole. An amount match is added when the query contains digits.
    const digits = opts.q.replace(/[^0-9.]/g, "");
    const hasText = /[a-z]/i.test(opts.q);
    const clauses: string[] = [];
    if (hasText) {
      const merchants = vendorSearchMerchants(opts.q.toLowerCase());
      if (merchants.length) {
        const ph = merchants.map((_, i) => `@sm${i}`);
        merchants.forEach((m, i) => (params[`sm${i}`] = m));
        clauses.push(`t.merchant IN (${ph.join(",")})`);
      }
      // A plan's own name finds that plan's charges — "Henry" finds the $200
      // contributions and not the $300 ones under the same bank name.
      const planIds = [...planNames(getRecurringSettings())].filter(([, name]) => name.toLowerCase().includes(opts.q!.toLowerCase())).map(([id]) => id);
      if (planIds.length) {
        const ph = planIds.map((_, i) => `@sp${i}`);
        planIds.forEach((id, i) => (params[`sp${i}`] = id));
        clauses.push(`t.recurringId IN (${ph.join(",")})`);
      }
      if (!merchants.length && !planIds.length) clauses.push("0"); // text was given but matched nothing
    }
    if (digits) {
      clauses.push("CAST(ABS(t.amount) AS TEXT) LIKE @qn");
      params.qn = `%${digits}%`;
    }
    if (clauses.length) where.push(`(${clauses.join(" OR ")})`);
  }
  if (opts.vendor) {
    // Match every descriptor variant of the vendor, so this shows the same set
    // the drawer rolled up (not just a substring of the clicked name).
    const vs = merchantVariants(opts.vendor);
    where.push(`t.merchant IN (${vs.map((_, i) => `@v${i}`).join(",")})`);
    vs.forEach((v, i) => {
      params[`v${i}`] = v;
    });
  }
  if (opts.type === "income") where.push("t.amount >= 0");
  else if (opts.type === "expense") where.push("t.amount < 0");
  if (opts.account) {
    where.push("t.account = @account");
    params.account = opts.account;
  }
  if (opts.minAmount != null) {
    where.push("ABS(t.amount) >= @minA");
    params.minA = opts.minAmount;
  }
  if (opts.maxAmount != null) {
    where.push("ABS(t.amount) <= @maxA");
    params.maxA = opts.maxAmount;
  }
  if (opts.recurring === true) where.push("t.recurringId IS NOT NULL");
  else if (opts.recurring === false) where.push("t.recurringId IS NULL");
  return { whereSql: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

// One list row as the UI receives it: the joined transaction plus the two
// per-charge flags computed in the SELECT. The pages alias this rather than
// re-declaring it, so a field added here reaches them at compile time.
export type TransactionRow = TransactionWithCategory & {
  splitMissed: boolean; // a split rule for this vendor missed this charge by a price change
  recurringExcluded: 0 | 1; // this charge was excluded from its vendor's series
  splitParts: number; // >0 when this charge is a split parent (its parts are child rows)
};

export function listTransactions(
  opts: TxFilter & {
    sort?: "date" | "amount" | "merchant";
    dir?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }
): TransactionRow[] {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  const { whereSql, params } = buildTxFilter(opts);
  // Whitelisted sort column + direction (never interpolate user strings).
  const sortCol =
    opts.sort === "amount"
      ? "ABS(t.amount)"
      : opts.sort === "merchant"
      ? "LOWER(t.merchant)"
      : "COALESCE(t.effectiveDate, t.date)";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  let pagination = "";
  if (opts.limit != null) {
    // Parameterized LIMIT/OFFSET (id tiebreak keeps the page boundary stable).
    pagination = "LIMIT @__lim OFFSET @__off";
    params.__lim = opts.limit;
    params.__off = opts.offset ?? 0;
  }
  const sql = `
    SELECT t.*, c.name AS categoryName, c.color AS categoryColor, c.icon AS categoryIcon,
           COALESCE(c.excludeFromTotals, 0) AS categoryExcluded,
           (t.hash IN (SELECT hash FROM recurring_tx_exclusions)) AS recurringExcluded,
           (SELECT COUNT(*) FROM transactions s WHERE s.hash LIKE t.hash || ':s%') AS splitParts
    FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
    ${whereSql}
    ORDER BY ${sortCol} ${dir}, t.id DESC
    ${pagination}`;
  const rows = db.prepare(sql).all(params) as (TransactionWithCategory & {
    recurringExcluded: 0 | 1;
    splitParts: number; // >0 when this charge is a split parent (its parts are child rows)
  })[];
  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  const plans = planNames(settings);
  const rules = splitRules();
  return rows.map((r) => ({
    ...r,
    displayName: chargeDisplayName(r, settings, links, plans),
    splitMissed: rules.length > 0 && splitDriftFor(r, rules) != null,
  }));
}

// Spend by calendar year, newest first (the current year reads as "so far").
// One query for the vendor's shelf and the charge's, so the two can't disagree.
function spendByYear(scope: string, args: (string | number)[]): { year: string; spent: number }[] {
  return (
    getDb()
      .prepare(
        `SELECT substr(COALESCE(effectiveDate, date),1,4) AS year,
           COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent
         FROM transactions WHERE ${scope} AND excluded = 0
         GROUP BY year ORDER BY year DESC LIMIT 4`
      )
      .all(...args) as { year: string; spent: number }[]
  ).map((r) => ({ year: r.year, spent: Number(r.spent.toFixed(2)) }));
}

// One charge, for its shelf: the list row's fields plus its plan — the plan it
// is linked to, else the vendor's most recently charged plan (the one "In
// plan" would put it into) — and the plan's display name.
export type ChargeDetail = TransactionRow & {
  recurringIncluded: 0 | 1;
  planKey: string | null;
  planName: string | null;
  // The last few charges that answer "is this amount the usual one?". One
  // plan under the vendor: every descriptor. Several plans: only this plan,
  // so the other plan's charges don't read as this one.
  recent: { id: number; date: string; amount: number; excluded: 0 | 1; recurringId: number | null }[];
  scopedToPlan: boolean;
  vendorCount: number;
  // What the vendor costs a year: read-only evidence, the same figures as the
  // vendor's shelf. The vendor's controls stay on the vendor's shelf.
  byYear: { year: string; spent: number }[];
  // A split rule for this vendor that missed this charge by a price change,
  // with its parts scaled to this amount (see splits.ts).
  splitDrift: SplitDrift | null;
};
export function transactionById(id: number): ChargeDetail | null {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  ensureRecurringTxInclusions(db);
  const row = db
    .prepare(
      `SELECT t.*, c.name AS categoryName, c.color AS categoryColor, c.icon AS categoryIcon,
         COALESCE(c.excludeFromTotals, 0) AS categoryExcluded,
         (t.hash IN (SELECT hash FROM recurring_tx_exclusions)) AS recurringExcluded,
         (t.hash IN (SELECT hash FROM recurring_tx_inclusions)) AS recurringIncluded,
         (SELECT COUNT(*) FROM transactions s WHERE s.hash LIKE t.hash || ':s%') AS splitParts
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id WHERE t.id = ?`
    )
    .get(id) as (TransactionWithCategory & { recurringExcluded: 0 | 1; recurringIncluded: 0 | 1; splitParts: number }) | undefined;
  if (!row) return null;
  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  const variants = merchantVariants(row.merchant);
  const ph = variants.map(() => "?").join(",");
  const plan =
    (row.recurringId != null
      ? (db.prepare("SELECT merchant FROM recurrings WHERE id = ?").get(row.recurringId) as { merchant: string } | undefined)
      : undefined) ??
    (db
      .prepare(
        `SELECT merchant FROM recurrings
         WHERE id IN (SELECT DISTINCT recurringId FROM transactions WHERE merchant IN (${ph}) AND recurringId IS NOT NULL)
         ORDER BY lastDate DESC LIMIT 1`
      )
      .get(...variants) as { merchant: string } | undefined);
  const notParent = "NOT EXISTS (SELECT 1 FROM transactions s WHERE s.hash LIKE t.hash || ':s%')";
  // A vendor with several plans: this charge's list is its plan. The other
  // plan, and charges in no plan, stay on the vendor shelf.
  const planCount = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT recurringId) AS n FROM transactions
         WHERE merchant IN (${ph}) AND recurringId IS NOT NULL`
      )
      .get(...variants) as { n: number }
  ).n;
  const scopedToPlan = row.recurringId != null && planCount > 1;
  const scopeSql = scopedToPlan ? `t.merchant IN (${ph}) AND t.recurringId = ?` : `t.merchant IN (${ph})`;
  const scopeArgs: (string | number)[] = scopedToPlan ? [...variants, row.recurringId as number] : [...variants];
  const recent = db
    .prepare(
      `SELECT t.id, COALESCE(t.effectiveDate, t.date) AS date, t.amount, t.excluded, t.recurringId
       FROM transactions t WHERE ${scopeSql} AND ${notParent}
       ORDER BY COALESCE(t.effectiveDate, t.date) DESC, t.id DESC LIMIT 5`
    )
    .all(...scopeArgs) as ChargeDetail["recent"];
  const vendorCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${scopeSql} AND ${notParent}`).get(...scopeArgs) as { n: number }
  ).n;
  return {
    ...row,
    displayName: chargeDisplayName(row, settings, links, planNames(settings)),
    planKey: plan?.merchant ?? null,
    planName: plan ? (settings[plan.merchant]?.alias ?? displayMerchant(plan.merchant)) : null,
    recent,
    scopedToPlan,
    vendorCount,
    byYear: spendByYear(`merchant IN (${ph})`, variants),
    splitDrift: splitDriftFor(row),
    splitMissed: splitDriftFor(row) != null,
  };
}

// Count and net total over the FULL filtered set. The list is paged, so the
// header's "N shown" and net figure can't be derived from the loaded rows.
// Net mirrors the dashboard: excluded rows and excluded-from-totals categories
// don't count.
export function transactionsSummary(opts: TxFilter): {
  count: number;
  net: number;
  vendorName?: string;
  categoryShared?: boolean;
} {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  const { whereSql, params } = buildTxFilter(opts);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN t.excluded = 1 OR COALESCE(c.excludeFromTotals, 0) = 1
                          THEN 0 ELSE t.amount END), 0) AS net,
        COUNT(DISTINCT COALESCE(t.categoryId, -1)) AS categories
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
       ${whereSql}`
    )
    .get(params) as { count: number; net: number; categories: number };
  // The statement lists the vendor. Its heading is the vendor's name — the
  // same one as the vendor shelf — not the newest charge's plan.
  if (!opts.vendor) return { count: row.count, net: Number(row.net.toFixed(2)) };
  return {
    count: row.count,
    net: Number(row.net.toFixed(2)),
    vendorName: merchantDisplayName(opts.vendor, getRecurringSettings(), getMerchantLinks()),
    // The heading names a category only when every listed charge has it.
    // Ben Franklin's two houses split its charges; naming the commoner one
    // said all 24 were Lake Home. Counted here, not from the loaded page:
    // the statement loads 60 rows at a time.
    categoryShared: row.categories <= 1,
  };
}

// Recurring-detection overrides (merchant -> 'force' | 'mute'), applied by
// detectRecurrings so user choices survive its rebuilds.
export function getRecurringOverrides(): Record<string, "force" | "mute"> {
  const rows = getDb()
    .prepare("SELECT merchant, status FROM recurring_overrides")
    .all() as { merchant: string; status: "force" | "mute" }[];
  const out: Record<string, "force" | "mute"> = {};
  for (const r of rows) out[r.merchant] = r.status;
  return out;
}

export function setRecurringOverride(merchant: string, status: "force" | "mute") {
  getDb()
    .prepare(
      `INSERT INTO recurring_overrides (merchant, status) VALUES (?, ?)
       ON CONFLICT(merchant) DO UPDATE SET status = excluded.status`
    )
    .run(merchant, status);
}

export function clearRecurringOverride(merchant: string) {
  getDb().prepare("DELETE FROM recurring_overrides WHERE merchant = ?").run(merchant);
}

// Transaction hashes flagged as one-offs (excluded from their merchant's
// recurring series). Read by detectRecurrings so the exclusion survives rebuilds.
export function getRecurringTxExclusions(): Set<string> {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  const rows = db.prepare("SELECT hash FROM recurring_tx_exclusions").all() as {
    hash: string;
  }[];
  return new Set(rows.map((r) => r.hash));
}

// Flag/unflag a single transaction as a one-off. Keyed by the transaction's
// stable hash so it persists across re-imports. Callers re-run detectRecurrings
// to recompute the series (and clear/restore this charge's recurringId).
export function setTransactionRecurringExcluded(id: number, excluded: boolean) {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  const row = db.prepare("SELECT hash FROM transactions WHERE id = ?").get(id) as
    | { hash: string }
    | undefined;
  if (!row) return;
  if (excluded) {
    db.prepare("INSERT OR IGNORE INTO recurring_tx_exclusions (hash) VALUES (?)").run(row.hash);
    // Out means out: a charge the user once put in is no longer pinned in.
    ensureRecurringTxInclusions(db);
    db.prepare("DELETE FROM recurring_tx_inclusions WHERE hash = ?").run(row.hash);
  } else db.prepare("DELETE FROM recurring_tx_exclusions WHERE hash = ?").run(row.hash);
}

// Charges the user put into a plan the detector left out: hash → the plan's
// series name. Read by detectRecurrings, which adds each to its plan on rebuild.
export function getRecurringTxInclusions(): Map<string, string> {
  const db = getDb();
  ensureRecurringTxInclusions(db);
  const rows = db.prepare("SELECT hash, plan FROM recurring_tx_inclusions").all() as { hash: string; plan: string }[];
  return new Map(rows.map((r) => [r.hash, r.plan]));
}

// Pin a single charge into a plan (or unpin it). Pinning also lifts a one-off
// flag on the same charge — in means in. Callers re-run detectRecurrings.
export function setTransactionRecurringIncluded(id: number, plan: string | null) {
  const db = getDb();
  ensureRecurringTxInclusions(db);
  ensureRecurringTxExclusions(db);
  const row = db.prepare("SELECT hash FROM transactions WHERE id = ?").get(id) as { hash: string } | undefined;
  if (!row) return;
  if (plan) {
    db.prepare("INSERT OR REPLACE INTO recurring_tx_inclusions (hash, plan) VALUES (?, ?)").run(row.hash, plan);
    db.prepare("DELETE FROM recurring_tx_exclusions WHERE hash = ?").run(row.hash);
  } else db.prepare("DELETE FROM recurring_tx_inclusions WHERE hash = ?").run(row.hash);
}

// The plan a charge would start: "<vendor> · $10.69", the vendor being the
// charge's combined name. Null for a charge that can't be a bill: a split
// parent (its parts are the charges), or one excluded from totals.
export function startPlanKey(id: number): string | null {
  const db = getDb();
  const row = db.prepare("SELECT merchant, amount, excluded, hash FROM transactions WHERE id = ?").get(id) as
    | { merchant: string; amount: number; excluded: 0 | 1; hash: string }
    | undefined;
  if (!row || row.excluded === 1) return null;
  const parent = db.prepare("SELECT 1 FROM transactions WHERE hash LIKE ? || ':s%' LIMIT 1").get(row.hash);
  if (parent) return null;
  return seriesKey(canonicalMerchant(row.merchant, getMerchantLinks()), amountLabel(row.amount));
}

// Clear every per-charge "one-off" exclusion for a merchant. Used when a vendor
// is marked not-recurring: with no series, an "excluded from the series" flag is
// meaningless and would otherwise linger as a ghost marker on the charge.
export function clearRecurringTxExclusionsForMerchant(merchant: string) {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  ensureRecurringTxInclusions(db);
  db.prepare(
    "DELETE FROM recurring_tx_exclusions WHERE hash IN (SELECT hash FROM transactions WHERE merchant = ?)"
  ).run(merchant);
  db.prepare(
    "DELETE FROM recurring_tx_inclusions WHERE hash IN (SELECT hash FROM transactions WHERE merchant = ?)"
  ).run(merchant);
}

// merchantKey lives in ./merchant (pure, no database) so client components can
// share it; re-exported here for the callers that always imported it from queries.
export { merchantKey } from "./merchant";

// All distinct stored merchant strings that normalize to the same vendor as
// `merchant`. Falls back to the exact name when the key is empty (e.g. all
// digits) so we never group unrelated rows. Exported so write/navigation paths
// (recategorize, recurring override, transactions vendor filter) operate on the
// whole vendor, consistent with the drawer's read rollup.
export function merchantVariants(merchant: string): string[] {
  // Resolve through user links first so a linked vendor is treated as one.
  const links = getMerchantLinks();
  const canonical = canonicalMerchant(merchant, links);
  const linked = new Set(linkedAliases(canonical, links));
  const key = merchantKey(canonical);
  if (key) {
    const all = (
      getDb().prepare("SELECT DISTINCT merchant FROM transactions").all() as {
        merchant: string;
      }[]
    ).map((r) => r.merchant);
    // Include normalized-key matches of the canonical, and key-matches of any
    // linked alias, so the whole vendor rolls up.
    for (const m of all)
      if (merchantKey(m) === key || linked.has(canonicalMerchant(m, links))) linked.add(m);
  }
  linked.add(merchant);
  return [...linked];
}

// Recategorize ONE series of a descriptor that carries several (a split
// "Netflix · 26th"): only its linked charges move, so the sibling keeps its
// category. Vendor-wide recategorize (setMerchantCategory) would move both.
export function setSeriesCategory(recurringId: number, categoryId: number | null) {
  const db = getDb();
  db.prepare("UPDATE transactions SET categoryId = ? WHERE recurringId = ?").run(categoryId, recurringId);
  db.prepare("UPDATE recurrings SET categoryId = ? WHERE id = ?").run(categoryId, recurringId);
}

// Roll a recurring's projected charge date forward by whole cadence steps until
// it lands on/after today, so the drawer's "next due" never shows a past date
// when a charge is late or the series has paused. Display-only: the stored
// nextDate is left alone (the dashboard's "upcoming" filter relies on it).
// Advance a UTC date in place by one cadence period.
function advanceByCadence(d: Date, cadence: string): void {
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "biweekly") d.setUTCDate(d.getUTCDate() + 14);
  else if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "bimonthly") d.setUTCMonth(d.getUTCMonth() + 2);
  else if (cadence === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (cadence === "semiannual") d.setUTCMonth(d.getUTCMonth() + 6);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
}

// Next due one cadence period after a base date (YYYY-MM-DD). Used to re-derive a
// recurring's next-due when the user corrects its cadence.
function nextAfter(baseDate: string, cadence: string): string {
  const d = new Date(baseDate + "T00:00:00Z");
  advanceByCadence(d, cadence);
  return d.toISOString().slice(0, 10);
}

function nextDueFromToday(nextDate: string, cadence: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (nextDate >= today) return nextDate;
  const d = new Date(nextDate + "T00:00:00Z");
  let guard = 0;
  while (d.toISOString().slice(0, 10) < today && guard++ < 600) advanceByCadence(d, cadence);
  return d.toISOString().slice(0, 10);
}

// Whether a recurring of `cadence` anchored in `anchorMonth` (1-12) is expected
// in calendar month `mm` (1-12). Weekly/biweekly/monthly land every month;
// periodic cadences only when the month distance is a whole number of periods.
function expectedInMonth(cadence: string, anchorMonth: number, mm: number): boolean {
  const period =
    cadence === "yearly" ? 12 : cadence === "semiannual" ? 6 : cadence === "quarterly" ? 3 : cadence === "bimonthly" ? 2 : 0;
  if (period === 0) return true;
  return ((((mm - anchorMonth) % period) + period) % period) === 0;
}

// Vendor-centric summary for the detail drawer: spend, frequency, dominant
// category, recurring status, and recent transactions. Aggregates across all
// descriptor variants of the vendor (see merchantVariants) so a sparse variant
// no longer shows an empty history.
// `series` scopes the summary to ONE plan of a vendor that carries several
// ("In 529 Dir Ach Contrib · $200"): figures, next due, the price-change check,
// by-year, and the charge list come from that plan's own linked charges, and
// overrides read/write under the plan's key. Without it (or for a vendor with
// one plan) the summary is the whole vendor, as before.
export function merchantSummary(merchant: string, series?: string | null) {
  const db = getDb();
  const variants = merchantVariants(merchant);
  const ph = variants.map(() => "?").join(",");
  const links = getMerchantLinks();
  const seriesHit = series
    ? (db
        .prepare("SELECT id, merchant, categoryId, cadence, avgAmount, nextDate, lastDate FROM recurrings WHERE merchant = ?")
        .get(series) as { id: number; merchant: string; categoryId: number | null; cadence: string; avgAmount: number; nextDate: string; lastDate: string } | undefined)
    : undefined;
  // A plan whose key is the vendor's own name (the 8th, beside "· $11.99")
  // is still one plan. Scoping used to require the "·" marker, so opening it
  // showed the whole vendor and a category edit moved both houses.
  const seriesRow =
    seriesHit &&
    canonicalMerchant(seriesVendor(seriesHit.merchant), links) === canonicalMerchant(merchant, links)
      ? seriesHit
      : undefined;
  const seriesId = seriesRow?.id ?? null;
  // Scope: the vendor's descriptors, and — for one plan — only its linked charges.
  const scope = seriesId != null ? `merchant IN (${ph}) AND recurringId = ?` : `merchant IN (${ph})`;
  const scopeT = seriesId != null ? `t.merchant IN (${ph}) AND t.recurringId = ?` : `t.merchant IN (${ph})`;
  const scopeArgs: (string | number)[] = seriesId != null ? [...variants, seriesId] : [...variants];
  // The descriptor variants with per-name counts. canUnlink is true only for
  // explicit merchant_links aliases (those can be split off); the canonical and
  // the automatic first-2-token key-rollups have no link to remove.
  const settings = getRecurringSettings();
  // Per-vendor settings (alias, expected amount, cadence) live on the canonical
  // merchant, so they read consistently no matter which descriptor opened the
  // shelf. Keying on the raw `merchant` here split the alias from the displayed
  // name when the shelf was opened on a folded-in variant.
  const settingsKey = seriesRow ? (series as string) : canonicalMerchant(merchant, links);
  const sett = settings[settingsKey] ?? null;
  const variantCounts = db
    .prepare(`SELECT merchant, COUNT(*) n FROM transactions WHERE merchant IN (${ph}) GROUP BY merchant`)
    .all(...variants) as { merchant: string; n: number }[];
  const countByName: Record<string, number> = Object.fromEntries(
    variantCounts.map((r) => [r.merchant, r.n])
  );
  const names = variants
    .map((v) => ({ name: v, count: countByName[v] ?? 0, canUnlink: links[v] != null }))
    .sort((a, b) => b.count - a.count);
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS n,
         COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent,
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS received,
         COUNT(DISTINCT substr(COALESCE(effectiveDate, date),1,7)) AS months,
         MAX(CASE WHEN recurringId IS NOT NULL THEN 1 ELSE 0 END) AS recurring
       FROM transactions WHERE ${scope} AND excluded = 0`
    )
    .get(...scopeArgs) as {
    n: number;
    spent: number;
    received: number;
    months: number;
    recurring: number | null;
  };
  // The vendor's category: the series' own (the detector's modal over its
  // members) when there is one; otherwise the most common category among
  // the charges that count. Excluded charges (split parents) don't vote —
  // they tipped Chubb to "Carmel Home" over its Lake Home plan.
  const modalCat = db
    .prepare(
      `SELECT c.id, c.name, c.color, c.icon, COUNT(*) AS n
       FROM transactions t JOIN categories c ON t.categoryId = c.id
       WHERE ${scopeT} AND t.excluded = 0 GROUP BY t.categoryId ORDER BY n DESC LIMIT 1`
    )
    .get(...scopeArgs) as
    | { id: number; name: string; color: string; icon: string }
    | undefined;
  const recent = db
    .prepare(
      `SELECT t.id, COALESCE(t.effectiveDate, t.date) AS date, t.merchant, t.amount, t.account, t.excluded,
         COALESCE(c.excludeFromTotals, 0) AS categoryExcluded, c.name AS categoryName,
         t.categoryId, t.recurringId,
         (t.hash IN (SELECT hash FROM recurring_tx_exclusions)) AS recurringExcluded,
         (t.hash IN (SELECT hash FROM recurring_tx_inclusions)) AS recurringIncluded
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
       WHERE ${
         seriesId != null
           ? // A plan's list: its own charges plus the vendor's charges in no
             // plan (so one can be pulled in or flagged out), never a charge
             // in another plan or one excluded from totals, which can't join.
             `t.merchant IN (${ph}) AND t.excluded = 0 AND (t.recurringId = ? OR t.recurringId IS NULL)`
           : `t.merchant IN (${ph})`
       }
         -- A split parent is not a charge any more: its parts are, and they
         -- live under their own descriptors ("Chubb — Carmel Home"). On the
         -- Chubb shelf the $1,115.55 parents read as "not counted" noise
         -- between the plan's own charges.
         AND NOT EXISTS (SELECT 1 FROM transactions s WHERE s.hash LIKE t.hash || ':s%')
       ORDER BY COALESCE(t.effectiveDate, t.date) DESC LIMIT 8`
    )
    .all(...scopeArgs) as {
    id: number;
    date: string;
    merchant: string; // the descriptor this charge posted under
    amount: number;
    account: string;
    excluded: 0 | 1;
    categoryExcluded: 0 | 1;
    categoryName: string | null;
    categoryId: number | null;
    recurringId: number | null;
    recurringExcluded: 0 | 1; // the user took it out of its plan
    recurringIncluded: 0 | 1; // the user put it into a plan the detector left out
  }[];

  // Trailing-12-months spend + count (the drawer's box row uses this window).
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const t12 = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS t,
         COUNT(*) AS n
       FROM transactions WHERE ${scope} AND excluded = 0
         AND COALESCE(effectiveDate, date) >= ?`
    )
    .get(...scopeArgs, cutoff.toISOString().slice(0, 10)) as { t: number; n: number };
  const trailing12 = t12.t;
  const count12 = t12.n;

  // First time we ever saw this merchant (clarifies the all-time count's scope).
  const firstSeen =
    (
      db
        .prepare(
          `SELECT MIN(COALESCE(effectiveDate, date)) AS f
           FROM transactions WHERE ${scope} AND excluded = 0`
        )
        .get(...scopeArgs) as { f: string | null }
    ).f ?? null;

  const byYear = spendByYear(scope, scopeArgs);

  // Recurring detail (via the linked recurring, even if its name drifted).
  // A vendor whose descriptor changed carries two series (WSJ: "D J*wsj"
  // through May, "D J" since). The page folds them and takes the newer
  // one's dates; the shelf must agree, so the most recently charged series
  // speaks for the vendor — not whichever row a LIMIT 1 found first.
  const rec =
    seriesRow ??
    (db
      .prepare(
        `SELECT id, merchant, categoryId, cadence, avgAmount, nextDate, lastDate FROM recurrings
         WHERE id IN (SELECT DISTINCT recurringId FROM transactions
                      WHERE merchant IN (${ph}) AND recurringId IS NOT NULL)
         ORDER BY lastDate DESC LIMIT 1`
      )
      .get(...variants) as
      | { id: number; merchant: string; categoryId: number | null; cadence: string; avgAmount: number; nextDate: string; lastDate: string }
      | undefined);
  const cat =
    (rec && "categoryId" in rec && rec.categoryId != null
      ? (db.prepare("SELECT id, name, color, icon FROM categories WHERE id = ?").get(rec.categoryId) as
          | { id: number; name: string; color: string; icon: string }
          | undefined)
      : undefined) ?? modalCat;
  // recurringDetail reflects the EFFECTIVE schedule (a cadence correction wins and
  // re-derives next-due), so the shelf's metrics match what the user just set.
  // detectedCadence (raw) is exposed separately so the correction UI can show
  // "detected X" and an auto/edited state.
  const effCadence = rec ? sett?.cadence ?? rec.cadence : null;
  const recurringDetail =
    rec && effCadence
      ? {
          cadence: effCadence,
          perCharge: Number(Math.abs(rec.avgAmount).toFixed(2)),
          annualized: Number((Math.abs(rec.avgAmount) * (PER_YEAR[effCadence as Cadence] ?? 12)).toFixed(2)),
          nextDate: nextDueFromToday(
            sett?.nextDate ?? nextAfter(rec.lastDate, effCadence),
            effCadence
          ),
        }
      : null;

  // Price-change detection — only meaningful for recurring fixed-price vendors
  // (variable merchants like coffee shops would flag spurious "changes").
  // Walk charges oldest→newest, find where the current amount run began.
  // The walk is over the SERIES' charges: a vendor whose usage top-ups were
  // left unlinked (Anthropic) must not read a $15 top-up as a price change.
  const charges = recurringDetail
    ? (db
        .prepare(
          `SELECT COALESCE(effectiveDate, date) AS date, amount FROM transactions
           WHERE merchant IN (${ph}) AND recurringId = ? AND amount < 0 AND excluded = 0
           ORDER BY COALESCE(effectiveDate, date) ASC`
        )
        .all(...variants, (rec as { id: number }).id) as { date: string; amount: number }[])
    : [];
  let priceChange: { from: number; to: number; since: string } | null = null;
  if (charges.length >= 2) {
    const latest = Math.abs(charges[charges.length - 1].amount);
    let i = charges.length - 1;
    while (
      i > 0 &&
      Math.abs(Math.abs(charges[i - 1].amount) - latest) <= Math.max(0.5, latest * 0.01)
    )
      i--;
    // News, not history: after three charges at the new price the change is
    // the price, and the banner would be a permanent stripe about the past.
    const runLength = charges.length - i;
    if (i > 0 && runLength <= 3)
      priceChange = {
        from: Number(Math.abs(charges[i - 1].amount).toFixed(2)),
        to: Number(latest.toFixed(2)),
        since: charges[i].date,
      };
  }

  // How many plans the vendor carries (a shelf on one of several says so).
  const plans = (
    db.prepare("SELECT merchant FROM recurrings").all() as { merchant: string }[]
  ).filter((r) => canonicalMerchant(seriesVendor(r.merchant), links) === canonicalMerchant(merchant, links)).length;
  // Every plan this vendor's charges belong to, for a shelf about the vendor
  // rather than one plan: Apple carries six subscriptions, and the shelf that
  // borrowed the most recent one's cards read "$128 per year" for a vendor
  // that costs $790. `day` is the pill that tells the plans apart — the day
  // each one bills, plus the amount when two share a day. `name` stays the
  // user's name for the plan's own shelf. `monthly` is what the live plans
  // add up to.
  const planRows = seriesRow
    ? []
    : (db
        .prepare(
          `SELECT id, merchant, cadence, avgAmount, lastDate FROM recurrings
           WHERE id IN (SELECT DISTINCT recurringId FROM transactions WHERE merchant IN (${ph}) AND recurringId IS NOT NULL)
           ORDER BY lastDate DESC`
        )
        .all(...variants) as { id: number; merchant: string; cadence: string; avgAmount: number; lastDate: string }[]);
  const planDay = new Map((db.prepare("SELECT key, day FROM plans").all() as { key: string; day: number | null }[]).map((p) => [p.key, p.day]));
  const dayNum = (merchant: string, lastDate: string) => {
    // A confirmed plan keeps its key when its bill moves ("· 25th" billing
    // the 27th): its own day, not the key's, is the one it bills.
    const firm = planDay.get(merchant);
    if (firm != null) return firm;
    // The key carries the day when the detector split on it ("· 26th").
    // A plan that kept the vendor's name, or was split on an amount both
    // plans share ("· $11.99"), is told apart by the day it last billed.
    if (isSeriesKey(merchant)) {
      const first = merchant.slice(seriesVendor(merchant).length + SERIES_SEP.length).split(SERIES_SEP)[0];
      const m = /^(\d+)(?:st|nd|rd|th)$/.exec(first);
      if (m) return Number(m[1]);
    }
    return Number(lastDate.slice(8, 10));
  };
  const dayCount = new Map<number, number>();
  for (const r of planRows) {
    const d = dayNum(r.merchant, r.lastDate);
    dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  }
  const planList = planRows.map((r) => {
    const s = settings[r.merchant];
    const cadence = s?.cadence ?? r.cadence;
    const qualifier = isSeriesKey(r.merchant) ? r.merchant.slice(seriesVendor(r.merchant).length + SERIES_SEP.length) : displayMerchant(r.merchant);
    const amount = s?.expectedAmount ?? Number(Math.abs(r.avgAmount).toFixed(2));
    const d = dayNum(r.merchant, r.lastDate);
    return {
      id: r.id,
      key: r.merchant,
      name: s?.alias ?? qualifier,
      day: (dayCount.get(d) ?? 0) > 1 ? `${dayLabel(d)} · ${amountLabel(amount)}` : dayLabel(d),
      amount,
      cadence,
      nextDate: nextDueFromToday(s?.nextDate ?? nextAfter(r.lastDate, cadence), cadence),
      ended: recurringEnded(s?.endedDate, r.lastDate),
    };
  });
  const monthly = Number(planList.filter((p) => !p.ended).reduce((a, p) => a + (p.amount * (PER_YEAR[p.cadence as Cadence] ?? 12)) / 12, 0).toFixed(2));
  // Which plan a Recent row belongs to. The day pill says which one; the
  // name stays available for a shelf that still speaks the plan's name.
  const planById = new Map(planList.map((p) => [p.id, p]));
  const recentNamed = recent.map((r) => ({
    ...r,
    planName: r.recurringId != null ? (planById.get(r.recurringId)?.name ?? null) : null,
    planDay: r.recurringId != null ? (planById.get(r.recurringId)?.day ?? null) : null,
  }));
  // Charges in no plan, outside the mixed last-8. Six monthly plans fill that
  // window, and a device purchase from last month never appears. Their own
  // short list — only on the vendor shelf, never on one plan's.
  const otherCharges =
    seriesRow || planList.length < 2
      ? []
      : (db
          .prepare(
            `SELECT t.id, COALESCE(t.effectiveDate, t.date) AS date, t.merchant, t.amount, t.account, t.excluded,
               COALESCE(c.excludeFromTotals, 0) AS categoryExcluded, c.name AS categoryName,
               t.categoryId, t.recurringId,
               (t.hash IN (SELECT hash FROM recurring_tx_exclusions)) AS recurringExcluded,
               (t.hash IN (SELECT hash FROM recurring_tx_inclusions)) AS recurringIncluded
             FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
             WHERE t.merchant IN (${ph}) AND t.excluded = 0 AND t.recurringId IS NULL
               ${recent.some((r) => r.recurringId == null) ? `AND t.id NOT IN (${recent.filter((r) => r.recurringId == null).map(() => "?").join(",")})` : ""}
               AND NOT EXISTS (SELECT 1 FROM transactions s WHERE s.hash LIKE t.hash || ':s%')
             ORDER BY COALESCE(t.effectiveDate, t.date) DESC LIMIT 8`
          )
          .all(
            ...variants,
            ...recent.filter((r) => r.recurringId == null).map((r) => r.id)
          ) as typeof recent).map((r) => ({ ...r, planName: null as string | null, planDay: null as string | null }));
  return {
    merchant,
    series: seriesRow ? (series as string) : null, // the plan this summary is scoped to, if any
    seriesId,
    planKey: rec?.merchant ?? null, // the plan a charge on this shelf is put into

    settingsKey, // where alias / expected / cadence / ended / match live for this shelf
    plans,
    planList,
    monthly,
    displayName: seriesRow ? (sett?.alias ?? displayMerchant(series as string)) : merchantDisplayName(merchant, settings, links),
    // Current per-merchant overrides, so the shelf can prefill its editors and
    // distinguish a user-set value from the detected one (null = no override).
    alias: sett?.alias ?? null,
    expectedAmount: sett?.expectedAmount ?? null,
    cadence: sett?.cadence ?? null, // cadence override (null = using detected)
    detectedCadence: rec?.cadence ?? null, // what detection found, for "detected X"
    nextDate: sett?.nextDate ?? null, // next-due override (null = derived from the last charge)
    matchRule: sett?.matchMode
      ? { matchMode: sett.matchMode, matchText: sett.matchText, amountTolerance: sett.amountTolerance }
      : null,
    // Any override at all — so the shelf can offer "Reset all" (endedDate is
    // not an override and survives a reset; see resetRecurringOverrides).
    hasSettings: !!(
      sett &&
      (sett.alias != null || sett.expectedAmount != null || sett.cadence != null ||
        sett.nextDate != null || sett.matchMode != null)
    ),
    nameVariants: variants.length,
    names,
    count: agg.n,
    spent: Number(agg.spent.toFixed(2)),
    received: Number(agg.received.toFixed(2)),
    months: agg.months,
    monthlyAvg: agg.months ? Number((agg.spent / agg.months).toFixed(2)) : 0,
    trailing12: Number(trailing12.toFixed(2)),
    count12,
    firstSeen,
    recurring: !!recurringDetail,
    // Whether the user marked this recurring ended/canceled (and nothing has
    // charged since), plus the date — so the shelf can show the same toggle.
    ended: rec ? recurringEnded(sett?.endedDate, rec.lastDate) : false,
    endedDate: sett?.endedDate ?? null,
    recurringDetail,
    byYear,
    priceChange,
    // Split rules acting on this vendor's own descriptors (a part-vendor's
    // rows are all parts, so it lists none).
    splitRules: splitRulesFor(
      (db.prepare(`SELECT DISTINCT merchant FROM transactions WHERE merchant IN (${ph}) AND hash NOT LIKE '%:s%'`).all(...variants) as { merchant: string }[]).map((r) => r.merchant)
    ),
    categoryId: cat?.id ?? null,
    categoryName: cat?.name ?? null,
    categoryColor: cat?.color ?? null,
    categoryIcon: cat?.icon ?? null,
    // The vendor's plans sit in different categories (houses). The vendor
    // shelf must not offer one category for all of them.
    categoryMixed: plansDisagree(variants),
    recent: recentNamed,
    otherCharges,
  };
}

// The shelf's vendor data, as merchantSummary returns it (inferred, so a field
// added to the return reaches the shelf at compile time).
export type MerchantSummary = ReturnType<typeof merchantSummary>;

export function distinctAccounts(): string[] {
  return (
    getDb()
      .prepare("SELECT DISTINCT account FROM transactions ORDER BY account")
      .all() as { account: string }[]
  ).map((r) => r.account);
}

export function setTransactionCategory(id: number, categoryId: number | null) {
  getDb()
    .prepare("UPDATE transactions SET categoryId = ? WHERE id = ?")
    .run(categoryId, id);
}

// Per-transaction free-text note (e.g. what a generic Venmo charge was for).
// null/empty clears it. Survives Plaid re-sync — the importer's upsert never
// touches this column, like effectiveDate.
export function setTransactionNote(id: number, note: string | null) {
  const trimmed = note?.trim() || null;
  getDb()
    .prepare("UPDATE transactions SET note = ? WHERE id = ?")
    .run(trimmed, id);
}

// Exclude/include a single transaction from all totals (the dashboard net, the
// transactions-page net, category and day subtotals all skip excluded rows).
// A manual one-off counterpart to a category's excludeFromTotals — e.g. a
// reimbursed charge or a transfer the user doesn't want counted. Survives Plaid
// re-sync because the upsert never touches the excluded column.
export function setTransactionExcluded(id: number, excluded: boolean) {
  getDb()
    .prepare("UPDATE transactions SET excluded = ? WHERE id = ?")
    .run(excluded ? 1 : 0, id);
}

// Recategorize every transaction of a merchant (used when editing a recurring's
// category on the Recurrings page). Returns the rows changed.
export function setMerchantCategory(merchant: string, categoryId: number | null) {
  return getDb()
    .prepare("UPDATE transactions SET categoryId = ? WHERE merchant = ?")
    .run(categoryId, merchant).changes;
}

// Houses under one vendor: several plans whose charges sit in more than one
// category (Ben Franklin's Carmel and Lake plans). One category for the
// vendor would pull them into one bucket. A stray one-off, or one plan whose
// charges disagree, is not that: the vendor still moves as a whole.
function plansDisagree(variants: string[]): boolean {
  const ph = variants.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT recurringId) AS plans, COUNT(DISTINCT COALESCE(categoryId, -1)) AS categories
       FROM transactions WHERE merchant IN (${ph}) AND recurringId IS NOT NULL AND excluded = 0`
    )
    .get(...variants) as { plans: number; categories: number };
  return row.plans > 1 && row.categories > 1;
}

// A category edit, from the vendor or from one of its plans. "plan" moves
// that plan's charges: a vendor with several plans recategorizes one at a
// time. "vendor" moves every charge. "refused" is a vendor-wide edit that
// would pull houses into one bucket, unless the user asked for exactly that
// (`force`: Combine's "one category for both").
export function applyRecategorize(
  merchant: string,
  categoryId: number | null,
  recurringId?: number | null,
  force = false
): "vendor" | "plan" | "refused" {
  const db = getDb();
  const variants = merchantVariants(merchant);
  const ph = variants.map(() => "?").join(",");
  const plans = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT recurringId) AS n FROM transactions
         WHERE merchant IN (${ph}) AND recurringId IS NOT NULL`
      )
      .get(...variants) as { n: number }
  ).n;
  if (plans > 1 && recurringId != null) {
    setSeriesCategory(recurringId, categoryId);
    // A category set on one plan is the user's word on it: confirm it.
    const key = db.prepare("SELECT merchant FROM recurrings WHERE id = ?").get(recurringId) as { merchant: string } | undefined;
    if (key) confirmPlan(key.merchant);
    return "plan";
  }
  if (!force && plansDisagree(variants)) return "refused";
  for (const v of variants) setMerchantCategory(v, categoryId);
  if (recurringId != null)
    db.prepare("UPDATE recurrings SET categoryId = ? WHERE id = ?").run(categoryId, recurringId);
  return "vendor";
}

// Override the accounting month/day of a transaction (e.g. a mortgage that
// posts a day early). null reverts to the bank's posted date. Survives Plaid
// re-sync because the upsert never touches effectiveDate.
export function setTransactionEffectiveDate(
  id: number,
  effectiveDate: string | null
) {
  getDb()
    .prepare("UPDATE transactions SET effectiveDate = ? WHERE id = ?")
    .run(effectiveDate, id);
}

export function availableMonths(): string[] {
  return (
    getDb()
      .prepare(
        "SELECT DISTINCT substr(COALESCE(effectiveDate,date),1,7) AS m FROM transactions ORDER BY m DESC"
      )
      .all() as { m: string }[]
  ).map((r) => r.m);
}

export function listRecurrings(): (Recurring & {
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  categoryExcluded: 0 | 1;
})[] {
  return getDb()
    .prepare(
      `SELECT r.*, c.name AS categoryName, c.color AS categoryColor, c.icon AS categoryIcon,
              COALESCE(c.excludeFromTotals, 0) AS categoryExcluded
       FROM recurrings r LEFT JOIN categories c ON r.categoryId = c.id
       ORDER BY r.nextDate`
    )
    .all() as never;
}

// Recurrings enriched for a specific month: did the expected charge already post
// (paid + actual amount), and on what day is it due. Powers the Copilot-style
// "paid so far / left to pay" monthly bills view. Matches by merchant (the same
// key detection groups on, so it's consistent for true recurrings).
export type RecurringForMonth = Recurring & {
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  // A plan in a category that is not counted (Transfers: a card autopay is
  // money already spent on the card) is neither a bill nor income. The
  // detector still tracks it; the lists and the digest leave it out.
  categoryExcluded: 0 | 1;
  vendor: string; // the bank descriptor behind the series (= merchant unless split by day)
  expectedThisMonth: boolean;
  paid: boolean;
  paidAmount: number | null;
  paidTimes: number; // how many of this month's charges were the bill itself (2 = charged twice)
  // A plan charged every week or two is paid more than once a month. The
  // charges still to come this month, from its next due date to the month's
  // end (Precision Cutz on the 29th, after four already paid). 0 for a plan
  // charged once a month or less: its one charge is paid or it isn't.
  chargesStillDue: number;
  dueDate: string;
  matchRule: MatchRule | null;
  linkedMerchants: string[]; // descriptor aliases folded into this recurring
  displayName: string;
  expectedAmount: number; // effective expected magnitude (override or detected)
  ended: boolean; // user marked it canceled and nothing has charged since
  endedDate: string | null;
  settings: RecurringSettings | null;
};
export function recurringsForMonth(month: string): RecurringForMonth[] {
  const db = getDb();

  // 1. De-duplicate near-identical recurrings. Bank descriptor drift (e.g. a
  // mortgage labeled 3 different ways month to month) makes the detector create
  // clones; collapse them by category + cadence + ~amount, keeping the one with
  // the most history.
  // Greedy grouping: same category + cadence + amount within ~2% (or $5) are
  // treated as one bill; keep the variant with the most history as the face.
  // The two rows must also be the same VENDOR — Combined by the user, or sharing
  // the coarse vendor key ("D J*wsj" / "D J", "Better Bodies Inc" / "Better
  // Bodies"). Without that test the price band alone folded distinct bills:
  // on real data Hulu ($19.99) swallowed 27 other $15–$20 subscriptions and
  // X Corp ($40) swallowed the $38.99 WSJ once it was categorized alike — 57
  // of 60 folds were different vendors, and their charges then "paid" the face.
  const recs: RecurringForMonth[] = [];
  const dedupeLinks = getMerchantLinks();
  // Split series ("Netflix · 23rd" / "Netflix · 26th") are distinct bills by
  // construction and never fold.
  // Nor does a confirmed plan: the user said it is a bill of its own.
  const firmKeys = new Set((db.prepare("SELECT key FROM plans").all() as { key: string }[]).map((p) => p.key));
  const sameVendor = (a: string, b: string) =>
    !isSeriesKey(a) &&
    !isSeriesKey(b) &&
    !firmKeys.has(a) &&
    !firmKeys.has(b) &&
    (canonicalMerchant(a, dedupeLinks) === canonicalMerchant(b, dedupeLinks) ||
      (merchantKey(a) !== "" && merchantKey(a) === merchantKey(b)));
  // A fold MERGES the clone into the face: the face keeps its key (settings,
  // alias, links live there) but takes the newest clone's last/next charge and
  // the combined count. The bank only ever sends the newest descriptor again,
  // so a face frozen on its own old lastDate reads as "stopped" the moment the
  // descriptor changes (WSJ: 19 charges as "D J*wsj" through May, then "D J").
  // Paid-matching below treats a charge on any folded key as the face's.
  const clonesOf = new Map<string, Set<string>>();
  const sorted = (listRecurrings() as RecurringForMonth[])
    .slice()
    .sort((a, b) => b.count - a.count);
  for (const r of sorted) {
    const dup = recs.find(
      (p) =>
        p.categoryId === r.categoryId &&
        p.cadence === r.cadence &&
        Math.abs(Math.abs(p.avgAmount) - Math.abs(r.avgAmount)) <=
          Math.max(5, Math.abs(p.avgAmount) * 0.02) &&
        sameVendor(p.merchant, r.merchant)
    );
    if (!dup) {
      recs.push(r);
      clonesOf.set(r.merchant, new Set([r.merchant]));
      continue;
    }
    clonesOf.get(dup.merchant)!.add(r.merchant);
    dup.count += r.count;
    if (r.lastDate > dup.lastDate) {
      dup.lastDate = r.lastDate;
      dup.nextDate = r.nextDate;
    }
  }

  // 2. This month's transactions, matched to recurrings: exact merchant first,
  // then a category + amount-within-5% fallback so a paid bill is recognized
  // even when the bank relabels it. Each transaction is attributed once.
  const txns = db
    .prepare(
      `SELECT merchant, categoryId, amount, recurringId FROM transactions
       WHERE substr(COALESCE(effectiveDate,date),1,7) = ? AND excluded = 0`
    )
    .all(month) as { merchant: string; categoryId: number | null; amount: number; recurringId: number | null }[];

  const consumed = new Set<number>();
  const actual = new Array(recs.length).fill(0);
  const matched = new Array(recs.length).fill(false);
  // Every charge a plan claimed this month. A plan that charges once a month or
  // less is paid by ONE of them (see below), not by their sum.
  const claimed: number[][] = recs.map(() => []);
  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  const canon = (m: string) => canonicalMerchant(m, links);
  const matchRuleFor = (m: string): MatchRule | null => {
    const s = settings[m];
    return s && s.matchMode
      ? { matchMode: s.matchMode, matchText: s.matchText, amountTolerance: s.amountTolerance }
      : null;
  };
  // Presentation overrides: effective cadence / next-due replace the detected
  // values on the rec (amount/alias are applied in the return map below).
  recs.forEach((r) => {
    const s = settings[r.merchant];
    // A cadence correction flows into expectedThisMonth below (which anchors on
    // the last charge), so the bill lands in the right months automatically.
    if (s?.cadence) r.cadence = s.cadence;
    if (s?.nextDate) r.nextDate = s.nextDate;
  });

  // Pass 0 — recurrings with a user match rule: the rule fully governs (merchant
  // exact/contains + amount tolerance, or any). No fallback applies to these.
  recs.forEach((r, ri) => {
    const rule = matchRuleFor(r.merchant);
    if (!rule) return;
    const expense = r.avgAmount < 0;
    const needle = (rule.matchText ?? "").toLowerCase();
    txns.forEach((t, i) => {
      if (consumed.has(i)) return;
      if (expense ? t.amount >= 0 : t.amount <= 0) return;
      const merchOk =
        rule.matchMode === "contains"
          ? needle !== "" && t.merchant.toLowerCase().includes(needle)
          : canon(t.merchant) === r.merchant;
      if (!merchOk) return;
      const amtOk =
        rule.amountTolerance == null ||
        Math.abs(Math.abs(t.amount) - Math.abs(r.avgAmount)) <=
          rule.amountTolerance * Math.abs(r.avgAmount);
      if (!amtOk) return;
      consumed.add(i);
      actual[ri] += Math.abs(t.amount);
      claimed[ri].push(Math.abs(t.amount));
      matched[ri] = true;
    });
  });

  // Pass 1 — exact merchant (recurrings without a custom rule).
  recs.forEach((r, ri) => {
    if (matchRuleFor(r.merchant)) return;
    const expense = r.avgAmount < 0;
    txns.forEach((t, i) => {
      if (consumed.has(i)) return;
      // A split series shares its descriptor with a sibling, so only the
      // charges the detector linked to it are its own; a whole-descriptor
      // series claims every charge on its key (or a folded clone's) plus the
      // charges the detector linked to it under a renamed descriptor.
      const key = canon(t.merchant);
      const ours = isSeriesKey(r.merchant)
        ? t.recurringId === r.id
        : key === r.merchant || t.recurringId === r.id || clonesOf.get(r.merchant)?.has(key);
      if (ours && (expense ? t.amount < 0 : t.amount > 0)) {
        consumed.add(i);
        actual[ri] += Math.abs(t.amount);
        claimed[ri].push(Math.abs(t.amount));
        matched[ri] = true;
      }
    });
  });
  // A weekly or biweekly plan is paid several times a month, so its month is the
  // sum. Any slower plan is paid once: of the charges it claimed, the bill is the
  // one nearest its expected amount. Summed, a $20 subscription and a separate
  // $200 purchase from the same vendor read as a $220 bill, "$200 more than
  // expected"; and a bill that posted on the 1st and the 31st read as doubled.
  // How many of the claimed charges were the bill itself: the paid one and any
  // other for the same amount (to 1%, or 50 cents). 2 means it was charged twice
  // this month — a duplicate, or next month's payment going out on the 31st —
  // which the single paid amount would otherwise hide. The same amount, not a
  // similar one: a $9.99 and a $10.69 subscription from one vendor are two bills.
  const paidTimes = new Array(recs.length).fill(0);
  recs.forEach((r, ri) => {
    const once = r.cadence !== "weekly" && r.cadence !== "biweekly";
    if (!once || claimed[ri].length < 2) return void (paidTimes[ri] = claimed[ri].length);
    const expected = settings[r.merchant]?.expectedAmount ?? Math.abs(r.avgAmount);
    const bill = claimed[ri].reduce((best, a) => (Math.abs(a - expected) < Math.abs(best - expected) ? a : best));
    actual[ri] = bill;
    paidTimes[ri] = claimed[ri].filter((a) => Math.abs(a - bill) <= Math.max(0.5, 0.01 * bill)).length;
  });
  // Pass 2 — the bank relabeled the bill: a charge on the same vendor key (the
  // shelf's rollup: first two words, processor prefixes stripped) within 5% of
  // the amount, not yet claimed (no custom rule, still unmatched). This used to
  // be any charge of the same category and amount, from any vendor — and in
  // three months it paid four bills with strangers (Rosy's $240 cleaning with
  // a $249 irrigation bill, X Corp with the WSJ, an RH renewal with a Target
  // run) and never once found a real relabel the vendor key would not.
  // Skip INACTIVE recurrings here so a long-stale recurring can't claim a
  // look-alike (the renamed-salon ghost: a 2023 "Mdg Carmel Hair…" grabbing a
  // 2026 "Mdg Salons" charge). Exact-merchant passes above still let a real
  // resume through.
  recs.forEach((r, ri) => {
    if (matched[ri] || matchRuleFor(r.merchant)) return;
    if (!isRecurringActive(r.lastDate, r.cadence)) return;
    const vendor = seriesVendor(r.merchant);
    const vendorKey = merchantKey(vendor);
    const expense = r.avgAmount < 0;
    const tol = Math.max(1, Math.abs(r.avgAmount) * 0.05);
    let bestIdx = -1;
    let bestDiff = Infinity;
    txns.forEach((t, i) => {
      if (consumed.has(i)) return;
      if (vendorKey === "" || merchantKey(t.merchant) !== vendorKey) return;
      if (expense ? t.amount >= 0 : t.amount <= 0) return;
      const diff = Math.abs(Math.abs(t.amount) - Math.abs(r.avgAmount));
      if (diff <= tol && diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) {
      consumed.add(bestIdx);
      actual[ri] = Math.abs(txns[bestIdx].amount);
      matched[ri] = true;
    }
  });

  const [yy, mm] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const stillDue = (r: (typeof recs)[number], s: RecurringSettings | null) => {
    if (r.cadence !== "weekly" && r.cadence !== "biweekly") return 0;
    const step = CADENCE_DAYS[r.cadence] * 86_400_000;
    let n = 0;
    for (let d = Date.parse(s?.nextDate ?? r.nextDate); d <= Date.parse(monthEnd); d += step)
      if (d >= Date.parse(`${month}-01`)) n++;
    return n;
  };
  return recs.map((r, ri) => {
    const s = settings[r.merchant] ?? null;
    const dayBasis = s?.nextDate ?? r.lastDate;
    const day = Math.min(Number(dayBasis.slice(8, 10)) || 1, daysInMonth);
    return {
      ...r,
      // Weekly/biweekly/monthly recur every month. Periodic cadences only land
      // in months whose distance from the anchor month is a whole number of
      // periods (quarterly every 3, semiannual every 6, yearly every 12).
      expectedThisMonth: expectedInMonth(r.cadence, Number(dayBasis.slice(5, 7)), mm),
      paid: actual[ri] > 0.005,
      paidAmount: actual[ri] > 0.005 ? Number(actual[ri].toFixed(2)) : null,
      paidTimes: paidTimes[ri],
      chargesStillDue: stillDue(r, s),
      dueDate: `${month}-${String(day).padStart(2, "0")}`,
      matchRule: matchRuleFor(r.merchant),
      vendor: seriesVendor(r.merchant),
      linkedMerchants: linkedAliases(seriesVendor(r.merchant), links).filter((m) => m !== seriesVendor(r.merchant)),
      displayName: s?.alias ?? displayMerchant(r.merchant),
      expectedAmount: s?.expectedAmount ?? Number(Math.abs(r.avgAmount).toFixed(2)),
      ended: recurringEnded(s?.endedDate, r.lastDate),
      endedDate: s?.endedDate ?? null,
      settings: s,
    };
  });
}

// Recurring expenses due within [from, to] (inclusive ISO dates), soonest first.
// Drives the dashboard's forward-looking "upcoming bills" summary. Applies
// per-recurring overrides: effective next-due (filter/sort) and expected amount
// (avgAmount is returned as the effective magnitude, so callers see the override).
export function upcomingRecurringExpenses(
  from: string,
  to: string
): (Recurring & {
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  displayName: string;
})[] {
  const settings = getRecurringSettings();
  const rows = getDb()
    .prepare(
      `SELECT r.*, c.name AS categoryName, c.color AS categoryColor, c.icon AS categoryIcon
       FROM recurrings r LEFT JOIN categories c ON r.categoryId = c.id
       WHERE r.avgAmount < 0 AND COALESCE(c.excludeFromTotals, 0) = 0`
    )
    .all() as (Recurring & {
    categoryName: string | null;
    categoryColor: string | null;
    categoryIcon: string | null;
  })[];
  return rows
    // A canceled (ended) subscription is no longer an upcoming bill.
    .filter((r) => !recurringEnded(settings[r.merchant]?.endedDate, r.lastDate))
    // The same liveness rule the category baseline and the shelf apply: a series
    // that has gone quiet is not an upcoming bill, even if a next-due or cadence
    // override would land it in the window.
    .filter((r) => isRecurringActive(r.lastDate, r.cadence))
    .map((r) => {
      const s = settings[r.merchant];
      // A cadence correction re-derives next-due from the last charge (so the
      // dashboard's upcoming list follows it), unless next-due was set explicitly.
      const nextDate = s?.nextDate ?? (s?.cadence ? nextAfter(r.lastDate, s.cadence) : r.nextDate);
      const mag = s?.expectedAmount ?? Math.abs(r.avgAmount);
      return { ...r, cadence: s?.cadence ?? r.cadence, nextDate, avgAmount: -mag, displayName: s?.alias ?? displayMerchant(r.merchant) };
    })
    .filter((r) => r.nextDate >= from && r.nextDate <= to)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

export type BudgetPeriod = "monthly" | "annual";

// Full budget config per category: the amount and whether it's a monthly or
// annual limit. Keyed by categoryId.
export function getBudgetsFull(): Record<number, { amount: number; period: BudgetPeriod }> {
  const rows = getDb()
    .prepare("SELECT categoryId, amount, period FROM budgets")
    .all() as { categoryId: number; amount: number; period: string }[];
  const out: Record<number, { amount: number; period: BudgetPeriod }> = {};
  for (const r of rows)
    out[r.categoryId] = { amount: r.amount, period: r.period === "annual" ? "annual" : "monthly" };
  return out;
}

// Monthly-EQUIVALENT budget per category (an annual budget counts as amount/12),
// so single-month consumers (dashboard, category shelf) put every budget on one
// comparable basis. categoriesWithTotals uses getBudgetsFull, so the categories page
// gets period-aware budgets from it.
export function getBudgets(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [id, b] of Object.entries(getBudgetsFull()))
    out[Number(id)] = b.period === "annual" ? Number((b.amount / 12).toFixed(2)) : b.amount;
  return out;
}

export function setBudget(categoryId: number, amount: number, period: BudgetPeriod = "monthly") {
  getDb()
    .prepare(
      `INSERT INTO budgets (categoryId, amount, period) VALUES (?, ?, ?)
       ON CONFLICT(categoryId) DO UPDATE SET amount = excluded.amount, period = excluded.period`
    )
    .run(categoryId, amount, period === "annual" ? "annual" : "monthly");
}

export function deleteBudget(categoryId: number) {
  getDb().prepare("DELETE FROM budgets WHERE categoryId = ?").run(categoryId);
}

// Toggle whether a category's transactions are omitted from all totals (e.g. a
// "Work Expenses" reimbursement category). Respected at query time by the
// dashboard aggregation and the transactions-page net.
export function setCategoryExcluded(categoryId: number, excluded: boolean) {
  getDb()
    .prepare("UPDATE categories SET excludeFromTotals = ? WHERE id = ?")
    .run(excluded ? 1 : 0, categoryId);
}

// Detected recurring expenses normalized to a monthly figure, summed per
// category. This is the "known recurring" baseline shown when setting a budget,
// so the user can size the discretionary (ad-hoc) portion. Same cadence factors
// as the Recurrings screen.

// A recurring is "active" if it charged within ~1.5 cycles (+5d grace). When a
// vendor stops or is renamed (its descriptor drifts to a new merchant), the old
// series goes silent and should stop counting toward "upcoming" projections and
// category recurring baselines — otherwise it double-counts with its successor.
// Shared by categorySummary (the shelf) and recurringMonthlyByCategory (the
// category-row baseline) so the two views never disagree.
export function isRecurringActive(
  lastDate: string,
  cadence: string,
  now = Date.now()
): boolean {
  const days =
    (now - new Date(lastDate + "T00:00:00Z").getTime()) / 86_400_000;
  return days <= (CADENCE_DAYS[cadence as Cadence] ?? 30) * 1.5 + 5;
}

export function recurringMonthlyByCategory(): Record<number, number> {
  const rows = getDb()
    .prepare(
      "SELECT merchant, categoryId, cadence, avgAmount, lastDate FROM recurrings WHERE avgAmount < 0 AND categoryId IS NOT NULL"
    )
    .all() as {
    merchant: string;
    categoryId: number;
    cadence: string;
    avgAmount: number;
    lastDate: string;
  }[];
  const settings = getRecurringSettings();
  const out: Record<number, number> = {};
  for (const r of rows) {
    if (!isRecurringActive(r.lastDate, r.cadence)) continue;
    // A canceled (ended) subscription stops counting toward expected outflow now.
    if (recurringEnded(settings[r.merchant]?.endedDate, r.lastDate)) continue;
    out[r.categoryId] =
      (out[r.categoryId] ?? 0) + Math.abs(r.avgAmount) * monthlyFactor(r.cadence);
  }
  return out;
}

export type CategoryWithTotals = Category & {
  total: number;
  txCount: number;
  budget: number | null;
  budgetPeriod: BudgetPeriod;
  ytdSpent: number;
  recurringBaseline: number;
  suggestedBudget: number;
  suggestedAnnualBudget: number;
};

export function categoriesWithTotals(month?: string): CategoryWithTotals[] {
  const db = getDb();
  const monthFilter = month ? "AND substr(COALESCE(t.effectiveDate, t.date),1,7) = @month" : "";
  const rows = db
    .prepare(
      // Total = spending magnitude, consistent with the dashboard breakdown:
      // expense categories count outflows (amount < 0); income categories count
      // inflows (amount > 0). This keeps the two screens in agreement even when a
      // category holds mixed-sign rows (e.g. large transfers parked in "Other").
      `SELECT c.*,
        COALESCE(SUM(
          CASE
            WHEN c.kind = 'expense' AND t.amount < 0 THEN -t.amount
            WHEN c.kind = 'income'  AND t.amount > 0 THEN  t.amount
            ELSE 0
          END), 0) AS total,
        COUNT(t.id) AS txCount
       FROM categories c
       LEFT JOIN transactions t ON t.categoryId = c.id AND t.excluded = 0 ${monthFilter}
       GROUP BY c.id
       -- Excluded-from-totals categories (e.g. Transfers) sink to the bottom of
       -- their section instead of floating to the top on their large raw total.
       ORDER BY c.kind DESC, COALESCE(c.excludeFromTotals, 0) ASC, total DESC`
    )
    .all({ month }) as (Category & { total: number; txCount: number })[];
  const budgets = getBudgetsFull();
  const baseline = recurringMonthlyByCategory();

  // Calendar year-to-date spend per category — the comparison basis for annual
  // budgets ("$X of $Y this year"). Same sign convention as `total` above.
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;
  const ytdRows = db
    .prepare(
      `SELECT t.categoryId AS id,
        COALESCE(SUM(
          CASE
            WHEN c.kind = 'expense' AND t.amount < 0 THEN -t.amount
            WHEN c.kind = 'income'  AND t.amount > 0 THEN  t.amount
            ELSE 0
          END), 0) AS spent
       FROM transactions t JOIN categories c ON c.id = t.categoryId
       WHERE t.excluded = 0 AND COALESCE(t.effectiveDate, t.date) >= @yearStart
       GROUP BY t.categoryId`
    )
    .all({ yearStart }) as { id: number; spent: number }[];
  const ytdById = new Map(ytdRows.map((r) => [r.id, r.spent]));

  // Suggested budget = the trailing-12-month average monthly spend (total spend
  // over the window ÷ 12, so an annual or sporadic expense smooths into a
  // sensible monthly figure), to the nearest $5. Drives the one-tap
  // "use" on unbudgeted categories. Window is "now", independent of the viewed
  // month, so the suggestion reflects real recent behaviour.
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
    .toISOString()
    .slice(0, 10);
  // Spend AND the number of months the category was actually active. The average
  // is per-active-month, NOT per-12: a $259/mo bill we've only seen once should
  // suggest $259, not $259/12. Months counts only months with qualifying spend.
  const avgRows = db
    .prepare(
      `SELECT t.categoryId AS id,
        COALESCE(SUM(
          CASE
            WHEN c.kind = 'expense' AND t.amount < 0 THEN -t.amount
            WHEN c.kind = 'income'  AND t.amount > 0 THEN  t.amount
            ELSE 0
          END), 0) AS spent,
        COUNT(DISTINCT CASE
            WHEN (c.kind = 'expense' AND t.amount < 0) OR (c.kind = 'income' AND t.amount > 0)
            THEN substr(COALESCE(t.effectiveDate, t.date), 1, 7)
          END) AS months
       FROM transactions t JOIN categories c ON c.id = t.categoryId
       WHERE t.excluded = 0 AND COALESCE(t.effectiveDate, t.date) >= @cutoff
       GROUP BY t.categoryId`
    )
    .all({ cutoff }) as { id: number; spent: number; months: number }[];
  const avgById = new Map(avgRows.map((r) => [r.id, r.months > 0 ? r.spent / r.months : 0]));
  // Trailing-12 total spend per category — the basis for an annual suggestion.
  const trailing12ById = new Map(avgRows.map((r) => [r.id, r.spent]));

  return rows.map((c) => {
    // Prefer the known recurring monthly cost (cadence-aware); else the average
    // over the months actually spent. Round to the nearest dollar so it reflects
    // the real figure. "Uncategorized" is a catch-all, never a budget line.
    const baselineAmt = baseline[c.id] ?? 0;
    const monthly = baselineAmt > 0 ? baselineAmt : avgById.get(c.id) ?? 0;
    const isBudgetable = c.name !== "Uncategorized";
    const suggestedBudget = isBudgetable && monthly >= 5 ? Math.round(monthly) : 0;
    // Annual suggestion = trailing-12 actual spend (a recurring monthly baseline
    // implies 12× that), to the nearest dollar.
    const annual = baselineAmt > 0 ? baselineAmt * 12 : trailing12ById.get(c.id) ?? 0;
    const suggestedAnnualBudget = isBudgetable && annual >= 5 ? Math.round(annual) : 0;
    const b = budgets[c.id];
    return {
      ...c,
      budget: b?.amount ?? null,
      budgetPeriod: b?.period ?? "monthly",
      ytdSpent: Number((ytdById.get(c.id) ?? 0).toFixed(2)),
      recurringBaseline: Number(baselineAmt.toFixed(2)),
      suggestedBudget,
      suggestedAnnualBudget,
    };
  });
}

export function createCategory(c: {
  name: string;
  color: string;
  icon: string;
  kind: "expense" | "income";
}) {
  return getDb()
    .prepare(
      "INSERT INTO categories (name, color, icon, kind) VALUES (@name, @color, @icon, @kind)"
    )
    .run(c);
}

// Update a category's editable attributes (icon/color/name/kind). Only the keys
// present in `patch` are changed. Kind (expense↔income) is editable as a
// correction — it re-buckets the category and flips how its rows are summed
// (outflow vs inflow); the route validates the value.
export function updateCategory(
  id: number,
  patch: { icon?: string; color?: string; name?: string; kind?: "expense" | "income" }
) {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.icon !== undefined) (sets.push("icon = ?"), vals.push(patch.icon));
  if (patch.color !== undefined) (sets.push("color = ?"), vals.push(patch.color));
  if (patch.name !== undefined) (sets.push("name = ?"), vals.push(patch.name));
  if (patch.kind !== undefined) (sets.push("kind = ?"), vals.push(patch.kind));
  if (!sets.length) return;
  vals.push(id);
  getDb()
    .prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
}

export function deleteCategory(id: number) {
  const db = getDb();
  db.prepare("UPDATE transactions SET categoryId = NULL WHERE categoryId = ?").run(id);
  // recurrings.categoryId also FK-references categories — clear it too, or the
  // DELETE below fails the foreign-key check (e.g. a stale recurring with no
  // remaining transactions still pinning the category).
  db.prepare("UPDATE recurrings SET categoryId = NULL WHERE categoryId = ?").run(id);
  db.prepare("DELETE FROM rules WHERE categoryId = ?").run(id);
  db.prepare("DELETE FROM budgets WHERE categoryId = ?").run(id);
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
}

// Common subscription / bill name signals — used only to suggest brand-new
// merchants (1-2 charges) that have no timing pattern yet (e.g. a first Roku
// charge). Deterministic and intentionally generous; the user confirms each.
const SUBSCRIPTION_HINT =
  /\b(netflix|hulu|disney|spotify|hbo|max|paramount|peacock|youtube|roku|appletv|apple\.com|icloud|prime video|audible|patreon|substack|medium|nyt|nytimes|wsj|economist|peloton|gym|fitness|membership|subscription|insurance|premium|energy|electric|electricity|water|sewer|gas|utility|utilities|internet|wireless|mobile|fiber|wifi|broadband|cloud|storage|vpn|chatgpt|openai|anthropic|claude|adobe|dropbox|notion|github|linkedin|hosting|domain)\b/i;

// Recurrings the strict auto-detector won't claim, surfaced for one-tap
// confirmation (Rule 5: code finds candidates; the user adjudicates):
//   - "variable": regular timing but amounts too variable for auto (CV > 0.6) —
//     usage-based bills like gas/phone (e.g. Vectren, Ooma).
//   - "new": only 1-2 charges so far but the name reads like a subscription/bill
//     and it charged recently — too little history to detect a cadence.
// Excludes anything already recurring, force-d, or previously dismissed (muted).
export type RecurringSuggestion = {
  merchant: string; // the canonical descriptor — the key for settings / Add
  displayName: string; // alias override if set, else merchant
  reason: "variable" | "new";
  cadence: string | null;
  avgAmount: number; // expected-amount override if set, else stable current price / median if variable
  count: number;
  lastDate: string;
  category: { name: string; color: string; icon: string } | null;
  aliases: string[]; // other descriptors of the same vendor, folded in on Add
};

export function suggestedRecurrings(): RecurringSuggestion[] {
  const db = getDb();
  const overrides = getRecurringOverrides();
  const settings = getRecurringSettings(); // per-merchant alias / expected-amount overrides
  const cats = new Map(
    (db.prepare("SELECT id, name, color, icon FROM categories").all() as Category[]).map(
      (c) => [c.id, c]
    )
  );
  const rows = db
    .prepare(
      `SELECT merchant, COALESCE(effectiveDate, date) AS d, amount, categoryId
       FROM transactions
       WHERE amount < 0 AND excluded = 0 AND recurringId IS NULL
       ORDER BY merchant, d`
    )
    .all() as { merchant: string; d: string; amount: number; categoryId: number | null }[];

  // Group by canonical merchant so user-linked descriptors suggest as one.
  const links = getMerchantLinks();
  const byMerchant = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = canonicalMerchant(r.merchant, links);
    const a = byMerchant.get(key) ?? [];
    a.push(r);
    byMerchant.set(key, a);
  }

  const cadenceOf = (g: number): string | null =>
    Math.abs(g - 7) <= 2
      ? "weekly"
      : Math.abs(g - 14) <= 3
      ? "biweekly"
      : g >= 26 && g <= 35
      ? "monthly"
      : g >= 52 && g <= 70
      ? "bimonthly"
      : g >= 80 && g <= 100
      ? "quarterly"
      : g >= 165 && g <= 200
      ? "semiannual"
      : g >= 330 && g <= 400
      ? "yearly"
      : null;
  const todayMs = new Date().getTime();

  const out: Omit<RecurringSuggestion, "aliases" | "displayName">[] = [];

  for (const [merchant, txs] of byMerchant) {
    if (overrides[merchant]) continue; // already forced or dismissed
    const lastDate = txs[txs.length - 1].d;
    const amounts = txs.map((t) => Math.abs(t.amount));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    // Expected charge going forward (txs are date-ascending). A subscription whose
    // price stepped up still has a *stable* current price — its last two charges
    // agree — so use the most recent. A genuinely variable bill (consecutive
    // charges keep differing) uses the median, a steadier typical than the latest
    // swing. The plain average is wrong for both. `mean` is kept for the CV test.
    const last = amounts[amounts.length - 1];
    const prevAmt = amounts.length >= 2 ? amounts[amounts.length - 2] : last;
    const stableRun = Math.abs(last - prevAmt) <= 0.1 * Math.max(last, prevAmt);
    const sortedAmts = [...amounts].sort((a, b) => a - b);
    const mid = sortedAmts.length >> 1;
    const median =
      sortedAmts.length % 2 ? sortedAmts[mid] : (sortedAmts[mid - 1] + sortedAmts[mid]) / 2;
    const expected = amounts.length >= 3 && !stableRun ? median : last;
    const cId = txs[txs.length - 1].categoryId;
    const category = (cId && cats.get(cId)) || null;
    const base = {
      merchant,
      avgAmount: -Number(expected.toFixed(2)),
      count: txs.length,
      lastDate,
      category: category ? { name: category.name, color: category.color, icon: category.icon } : null,
    };

    if (txs.length >= 3) {
      const dates = txs.map((t) => new Date(t.d + "T00:00:00Z").getTime());
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86_400_000);
      const cadence = cadenceOf(medianGap(gaps));
      if (!cadence) continue;
      const period = CADENCE_DAYS[cadence as Cadence];
      const onGrid =
        gaps.filter((g) => Math.abs(g - Math.max(1, Math.round(g / period)) * period) <= 0.35 * period)
          .length / gaps.length;
      const sd = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length);
      const cv = mean ? sd / mean : 0;
      // Regular timing, but amount too variable for auto (and not absurd).
      if (onGrid >= 0.6 && cv > 0.6 && cv <= 1.5) {
        out.push({ ...base, reason: "variable", cadence });
      }
    } else if (
      SUBSCRIPTION_HINT.test(merchant) &&
      (todayMs - new Date(lastDate + "T00:00:00Z").getTime()) / 86_400_000 <= 120
    ) {
      out.push({ ...base, reason: "new", cadence: null });
    }
  }

  // Sort first so the highest-count descriptor of a vendor leads its cluster.
  out.sort(
    (a, b) =>
      (a.reason === b.reason ? 0 : a.reason === "variable" ? -1 : 1) ||
      b.count - a.count ||
      b.lastDate.localeCompare(a.lastDate)
  );

  // Cluster suggestions that are the same vendor under a drifted descriptor
  // (e.g. "2d Vectrenenergy Util Paymt" → "… Igc Ach Dr") before it ever became a
  // confirmed recurring — so they show as ONE suggestion whose Add folds in the
  // aliases. Greedy by name affinity; the first (highest-count) is the primary.
  const clustered: Omit<RecurringSuggestion, "displayName">[] = [];
  for (const s of out) {
    const hit = clustered.find((c) => nameAffinity(c.merchant, s.merchant) >= LOW_MATCH);
    if (hit) {
      hit.count += s.count;
      // Current price across the cluster = the amount of whichever descriptor
      // charged most recently (not a blend of the descriptors' prices).
      if (s.lastDate > hit.lastDate) {
        hit.lastDate = s.lastDate;
        hit.avgAmount = s.avgAmount;
      }
      hit.aliases.push(s.merchant);
    } else {
      clustered.push({ ...s, aliases: [] });
    }
  }

  // Apply per-merchant overrides: a user-set name (alias) and/or expected amount,
  // editable from the suggestion row before it's even Added.
  return clustered.map((s): RecurringSuggestion => {
    const st = settings[s.merchant];
    return {
      ...s,
      displayName: st?.alias ?? displayMerchant(s.merchant),
      avgAmount: st?.expectedAmount != null ? -Math.abs(st.expectedAmount) : s.avgAmount,
    };
  });
}

// ---- Category shelf -------------------------------------------------------
// Month adjacent-helpers (UTC, "YYYY-MM").
function shiftMonth(month: string, deltaMonths: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + deltaMonths, 1)).toISOString().slice(0, 7);
}

export type CategorySummary = {
  id: number;
  name: string;
  icon: string;
  color: string;
  kind: "expense" | "income";
  excludeFromTotals: 0 | 1;
  month: string;
  spent: number; // magnitude this month (outflow for expense, inflow for income)
  txCount: number;
  prevSpent: number; // same, prior month (for the MoM card)
  monthlyAvg: number; // trailing-12 average magnitude (the "typical month" benchmark)
  budget: number | null;
  upcoming: { merchant: string; displayName: string; dueDate: string; amount: number }[];
  transactions: {
    id: number;
    date: string;
    merchant: string;
    displayName: string;
    amount: number;
    account: string;
    recurringId: number | null;
    excluded: 0 | 1; // shown but not counted in `spent` — the shelf marks it
    recurringExcluded: 0 | 1; // excluded from its vendor's series (the ↻ reads "out")
  }[];
};

// Everything the category shelf needs for a category in a given month. Mirrors
// merchantSummary; magnitude is sign-aware (expense=outflow, income=inflow),
// consistent with categoriesWithTotals and the dashboard.
export function categorySummary(categoryId: number, month: string): CategorySummary | null {
  const db = getDb();
  const cat = db
    .prepare(
      "SELECT id, name, icon, color, kind, COALESCE(excludeFromTotals,0) AS excludeFromTotals FROM categories WHERE id = ?"
    )
    .get(categoryId) as
    | { id: number; name: string; icon: string; color: string; kind: "expense" | "income"; excludeFromTotals: 0 | 1 }
    | undefined;
  if (!cat) return null;

  const magExpr =
    cat.kind === "income"
      ? "CASE WHEN amount > 0 THEN amount ELSE 0 END"
      : "CASE WHEN amount < 0 THEN -amount ELSE 0 END";

  const monthAgg = (m: string) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(${magExpr}), 0) AS s, COUNT(*) AS n
         FROM transactions
         WHERE categoryId = ? AND excluded = 0
           AND substr(COALESCE(effectiveDate, date),1,7) = ?`
      )
      .get(categoryId, m) as { s: number; n: number };

  const cur = monthAgg(month);
  const prev = monthAgg(shiftMonth(month, -1));
  const t12 = (
    db
      .prepare(
        `SELECT COALESCE(SUM(${magExpr}), 0) AS s
         FROM transactions
         WHERE categoryId = ? AND excluded = 0
           AND substr(COALESCE(effectiveDate, date),1,7) BETWEEN ? AND ?`
      )
      .get(categoryId, shiftMonth(month, -11), month) as { s: number }
  ).s;

  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  const txns = db
    .prepare(
      `SELECT id, COALESCE(effectiveDate, date) AS date, merchant, amount, account, recurringId, excluded,
              (hash IN (SELECT hash FROM recurring_tx_exclusions)) AS recurringExcluded
       FROM transactions
       WHERE categoryId = ? AND substr(COALESCE(effectiveDate, date),1,7) = ?
       ORDER BY COALESCE(effectiveDate, date) DESC, id DESC`
    )
    .all(categoryId, month) as {
    id: number;
    date: string;
    merchant: string;
    amount: number;
    account: string;
    recurringId: number | null;
    excluded: 0 | 1;
    recurringExcluded: 0 | 1;
  }[];

  // Recurrings tied to this category still expected this month (unpaid) — only
  // for the current month, and only ACTIVE ones (a stale/stopped recurring that
  // hasn't charged within ~1.5 cycles isn't "upcoming"; it's inactive).
  const currentMonth = new Date().toISOString().slice(0, 7);
  const upcoming =
    month !== currentMonth
      ? []
      : recurringsForMonth(month)
          .filter(
            (r) =>
              r.categoryId === categoryId &&
              r.avgAmount < 0 &&
              r.expectedThisMonth &&
              !r.paid &&
              isRecurringActive(r.lastDate, r.cadence)
          )
          .map((r) => ({
            merchant: r.merchant,
            displayName: r.displayName,
            dueDate: r.dueDate,
            amount: r.expectedAmount,
          }))
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate)); // soonest first

  const plans = planNames(settings);
  return {
    ...cat,
    month,
    spent: Number(cur.s.toFixed(2)),
    txCount: cur.n,
    prevSpent: Number(prev.s.toFixed(2)),
    monthlyAvg: Number((t12 / 12).toFixed(2)),
    budget: getBudgets()[cat.id] ?? null,
    upcoming,
    transactions: txns.map((t) => ({
      ...t,
      displayName: chargeDisplayName(t, settings, links, plans),
    })),
  };
}
