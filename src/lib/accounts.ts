import { getDb, ensureAccounts } from "./db";
import type { PlaidAccount, PlaidItem } from "./plaid";
import type { ManualKind } from "./accountKinds";
import { TREND_MIN_DAYS, olderThanAYear } from "./accountKinds";

type Side = "asset" | "liability";
type Kind = "cash" | "card" | "loan" | "mortgage" | "investment" | "property" | "vehicle" | "other";

// Plaid's account type says which side of net worth an account sits on: a card
// or loan's balance is what is owed, everything else's is what is held.
function classify(a: PlaidAccount): { side: Side; kind: Kind } {
  switch (a.type) {
    case "depository":
      return { side: "asset", kind: "cash" };
    case "investment":
    case "brokerage":
      return { side: "asset", kind: "investment" };
    case "credit":
      return { side: "liability", kind: "card" };
    case "loan":
      return { side: "liability", kind: a.subtype === "mortgage" ? "mortgage" : "loan" };
    default:
      return { side: "asset", kind: "other" };
  }
}

// Record today's balance for every account a sync pulled: one row per account
// per day, a later sync the same day replacing it. A new account is added with
// the bank's name, which it keeps (the owner renames it, not the bank). A
// relinked bank issues new account ids for accounts already held, which would
// add each one a second time and count it twice in net worth; an unknown id
// takes over the one held account at the same institution with the same mask
// and subtype that this pull no longer carries. Returns the balances recorded.
export function recordBalances(items: PlaidItem[], asOf: string): number {
  const db = getDb();
  ensureAccounts(db);
  const pulled = new Set(items.flatMap((i) => i.accounts.map((a) => a.account_id)));
  const held = db
    .prepare("SELECT id, plaidAccountId, institution, mask, subtype FROM accounts WHERE source = 'plaid'")
    .all() as { id: number; plaidAccountId: string; institution: string | null; mask: string | null; subtype: string | null }[];
  const byPlaidId = new Map(held.map((h) => [h.plaidAccountId, h.id]));
  const orphans = held.filter((h) => !pulled.has(h.plaidAccountId));

  const rekey = db.prepare("UPDATE accounts SET plaidAccountId = ? WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO accounts (source, plaidAccountId, institution, mask, subtype, name, side, kind)
     VALUES ('plaid', @plaidAccountId, @institution, @mask, @subtype, @name, @side, @kind)`
  );
  const upsertBalance = db.prepare(
    `INSERT INTO balances (accountId, asOf, amount, source) VALUES (?, ?, ?, 'bank')
     ON CONFLICT(accountId, asOf) DO UPDATE SET amount = excluded.amount, source = excluded.source`
  );

  let recorded = 0;
  db.transaction(() => {
    for (const item of items) {
      const institution = item.institution ?? null;
      for (const a of item.accounts) {
        let id = byPlaidId.get(a.account_id);
        if (id === undefined) {
          const same = orphans.filter(
            (h) => h.institution === institution && h.mask === (a.mask ?? null) && h.subtype === (a.subtype ?? null)
          );
          if (same.length === 1) {
            id = same[0].id;
            rekey.run(a.account_id, id);
            orphans.splice(orphans.indexOf(same[0]), 1);
          } else {
            id = Number(
              insert.run({
                plaidAccountId: a.account_id,
                institution,
                mask: a.mask ?? null,
                subtype: a.subtype ?? null,
                name: a.name,
                ...classify(a),
              }).lastInsertRowid
            );
          }
          byPlaidId.set(a.account_id, id);
        }
        const current = a.balances?.current;
        if (current == null) continue; // no balance from the bank: keep the last one, dated
        upsertBalance.run(id, asOf, current);
        recorded++;
      }
    }
  })();
  return recorded;
}

// Net worth on a day: each counted account's latest balance on or before it.
// An account that hasn't reported since carries its last balance and says
// when (asOf), so a stale figure never passes for that day's. Accounts left
// out of net worth are listed too (`counted` false), so they can be counted
// again; only counted ones are summed.
export type NetWorth = {
  owned: number;
  owed: number;
  net: number;
  accounts: {
    id: number;
    name: string;
    side: Side;
    kind: Kind;
    origin: "plaid" | "manual";
    subtype: string | null;
    mask: string | null;
    counted: boolean;
    amount: number;
    asOf: string;
    source: "bank" | "owner" | "estimate";
    securedBy: number | null; // a loan: the asset it's against
  }[];
};
export function netWorth(asOf: string): NetWorth {
  const db = getDb();
  ensureAccounts(db);
  const accounts = (
    db
      .prepare(
        `SELECT a.id, a.name, a.side, a.kind, a.source AS origin, a.subtype, a.mask, a.inNetWorth AS counted, a.securedBy,
                b.amount, b.asOf, b.source
         FROM accounts a
         JOIN balances b ON b.accountId = a.id
          AND b.asOf = (SELECT MAX(asOf) FROM balances WHERE accountId = a.id AND asOf <= @asOf)
         WHERE a.hidden = 0
         ORDER BY a.side, a.position IS NULL, a.position, a.kind, a.name`
      )
      .all({ asOf }) as (Omit<NetWorth["accounts"][number], "counted"> & { counted: number })[]
  ).map((a) => ({ ...a, counted: a.counted === 1 }));
  const sum = (side: Side) => accounts.filter((a) => a.counted && a.side === side).reduce((t, a) => t + a.amount, 0);
  const owned = Number(sum("asset").toFixed(2));
  const owed = Number(sum("liability").toFixed(2));
  return { owned, owed, net: Number((owned - owed).toFixed(2)), accounts };
}

// What needs a look: the figures in net worth most likely to be wrong, each
// fixed from its account's shelf. An estimate over a year old; a linked
// account that hasn't reported for a week (its row has said "as of" since the
// first missed day); a mortgage tied to no home, whose equity can't be shown.
// Accounts left out of net worth are skipped: they can't mislead it. A plain
// loan against nothing isn't listed, since many are (a student loan).
export const SILENT_DAYS = 7;
export type LookItem = { id: number; reason: "untied-mortgage" | "silent" | "old-estimate"; days: number };
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);
export function needsALook(accounts: NetWorth["accounts"], today: string): LookItem[] {
  const counted = accounts.filter((a) => a.counted);
  // The page's day: the newest balance. A link is silent against that, not
  // against the clock, so a day without a sync doesn't flag every account.
  const latest = counted.reduce((m, a) => (a.asOf > m ? a.asOf : m), "");
  const items: LookItem[] = [];
  for (const a of counted) {
    if (a.kind === "mortgage" && a.securedBy == null) items.push({ id: a.id, reason: "untied-mortgage", days: 0 });
    else if (a.origin === "plaid" && daysBetween(a.asOf, latest) >= SILENT_DAYS) items.push({ id: a.id, reason: "silent", days: daysBetween(a.asOf, latest) });
    else if (a.source === "estimate" && a.side === "asset" && olderThanAYear(a.asOf, today)) items.push({ id: a.id, reason: "old-estimate", days: daysBetween(a.asOf, today) });
  }
  return items;
}

// The side each hand-kept kind sits on. A home or a vehicle is what the
// household owns; a loan the bank doesn't link is owed.
export { MANUAL_KINDS, type ManualKind } from "./accountKinds";
const sideOf = (kind: ManualKind): Side => (kind === "loan" ? "liability" : "asset");

// A value the owner sets: a bank balance they read off a statement ('owner')
// or a worth they judge, such as a home's ('estimate'). Dated, so a stale
// estimate says how old it is.
export type OwnerValue = { asOf: string; amount: number; estimate: boolean };

function account(id: number) {
  const db = getDb();
  ensureAccounts(db);
  return db.prepare("SELECT id, source, name, side, kind, inNetWorth FROM accounts WHERE id = ?").get(id) as
    | { id: number; source: "plaid" | "manual"; name: string; side: Side; kind: Kind; inNetWorth: number }
    | undefined;
}

// A new account the owner keeps by hand, with its first value.
export function createManualAccount(name: string, kind: ManualKind, value: OwnerValue): number {
  const db = getDb();
  ensureAccounts(db);
  return db.transaction(() => {
    const id = Number(
      db
        .prepare("INSERT INTO accounts (source, name, side, kind) VALUES ('manual', ?, ?, ?)")
        .run(name, sideOf(kind), kind).lastInsertRowid
    );
    setValue(id, value);
    return id;
  })();
}

// Record a value on a hand-kept account; a second one on the same day
// replaces it. A linked account's balance is the bank's: refused.
export function setValue(id: number, v: OwnerValue): boolean {
  const a = account(id);
  if (!a || a.source !== "manual") return false;
  // A loan's figure is a statement balance, never an estimate: its estimates
  // are the payments' (projectLoanPayments), recomputed from this anchor.
  const loan = a.side === "liability";
  getDb()
    .prepare(
      `INSERT INTO balances (accountId, asOf, amount, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(accountId, asOf) DO UPDATE SET amount = excluded.amount, source = excluded.source`
    )
    .run(id, v.asOf, v.amount, v.estimate && !loan ? "estimate" : "owner");
  if (loan) projectLoanPayments(id);
  return true;
}

// Remove one dated value from a hand-kept account, keeping at least one: an
// account with no value would vanish from the page, where it could be fixed.
export function removeValue(id: number, asOf: string): boolean {
  const a = account(id);
  if (!a || a.source !== "manual") return false;
  const db = getDb();
  const loan = a.side === "liability";
  // On a loan, the figures that count are the owner's; its estimates are
  // computed from them and can't be removed one by one.
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM balances WHERE accountId = ?${loan ? " AND source != 'estimate'" : ""}`).get(id) as { n: number }).n;
  if (n <= 1) return false;
  const gone = db.prepare(`DELETE FROM balances WHERE accountId = ? AND asOf = ?${loan ? " AND source != 'estimate'" : ""}`).run(id, asOf).changes > 0;
  if (gone && loan) projectLoanPayments(id);
  return gone;
}

// Rename any account, or count it in net worth or not. A linked account
// keeps the name it's given here across syncs (recordBalances never renames).
export function updateAccount(id: number, patch: { name?: string; counted?: boolean }): boolean {
  if (!account(id)) return false;
  const db = getDb();
  if (patch.name !== undefined) db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(patch.name, id);
  if (patch.counted !== undefined) db.prepare("UPDATE accounts SET inNetWorth = ? WHERE id = ?").run(patch.counted ? 1 : 0, id);
  return true;
}

// Delete a hand-kept account, its values and terms; a loan that was against
// it is against nothing now. A linked account is the bank's:
// it can be left out of net worth, not deleted (the next sync would add it back).
export function deleteManualAccount(id: number): boolean {
  const a = account(id);
  if (!a || a.source !== "manual") return false;
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM balances WHERE accountId = ?").run(id);
    db.prepare("DELETE FROM loan_terms WHERE accountId = ?").run(id);
    db.prepare("UPDATE accounts SET securedBy = NULL WHERE securedBy = ?").run(id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  })();
  return true;
}

// One account for its shelf: what it is, and every value it has had, newest first.
export type AccountDetail = {
  id: number;
  name: string;
  side: Side;
  kind: Kind;
  origin: "plaid" | "manual";
  subtype: string | null;
  mask: string | null;
  counted: boolean;
  history: { asOf: string; amount: number; source: "bank" | "owner" | "estimate" }[];
  // A loan: its terms, the asset it's against, and the assets it could be.
  terms: LoanTerms | null;
  securedBy: { id: number; name: string } | null;
  assets: { id: number; name: string }[];
  // An asset: the loans against it, and its equity (worth less what's owed on it).
  loans: { id: number; name: string; amount: number }[];
  equity: number | null;
  // A hand-kept loan: the vendor its payments post under, and likely ones
  // (vendors charged within 5% of its payment in the last six months).
  paidBy: string | null;
  payers: string[];
};
export function accountDetail(id: number): AccountDetail | null {
  const db = getDb();
  ensureAccounts(db);
  const a = db
    .prepare("SELECT id, name, side, kind, source AS origin, subtype, mask, inNetWorth, paidBy FROM accounts WHERE id = ?")
    .get(id) as (Omit<AccountDetail, "counted" | "history" | "terms" | "securedBy" | "assets" | "loans" | "equity" | "payers"> & { inNetWorth: number }) | undefined;
  if (!a) return null;
  const history = db
    .prepare("SELECT asOf, amount, source FROM balances WHERE accountId = ? ORDER BY asOf DESC")
    .all(id) as AccountDetail["history"];
  const { inNetWorth, ...rest } = a;
  const latest = (accountId: number) =>
    (db.prepare("SELECT amount FROM balances WHERE accountId = ? ORDER BY asOf DESC LIMIT 1").get(accountId) as { amount: number } | undefined)?.amount ?? 0;
  const liability = a.side === "liability";
  const sec = db.prepare("SELECT s.id, s.name FROM accounts l JOIN accounts s ON s.id = l.securedBy WHERE l.id = ?").get(id) as
    | { id: number; name: string }
    | undefined;
  const loans = liability
    ? []
    : (db.prepare("SELECT id, name FROM accounts WHERE securedBy = ? ORDER BY name").all(id) as { id: number; name: string }[]).map(
        (l) => ({ ...l, amount: latest(l.id) })
      );
  return {
    ...rest,
    counted: inNetWorth === 1,
    history,
    terms: liability ? (readTerms(id) ?? { ...EMPTY_TERMS, edited: [] }) : null,
    securedBy: sec ?? null,
    assets: liability
      ? (db.prepare("SELECT id, name FROM accounts WHERE side = 'asset' AND kind IN ('property','vehicle','other') ORDER BY name").all() as { id: number; name: string }[])
      : [],
    loans,
    equity: loans.length ? Number((latest(id) - loans.reduce((t, l) => t + l.amount, 0)).toFixed(2)) : null,
    payers: liability && a.origin === "manual" ? payersFor(readTerms(id)?.payment ?? null) : [],
  };
}

// ---- Loan terms and what a loan is against --------------------------------

export const TERM_FIELDS = ["rate", "payment", "maturity", "original", "opened"] as const;
export type TermField = (typeof TERM_FIELDS)[number];
// rate: annual %, payment: monthly $, maturity / opened: YYYY-MM-DD, original: $.
export type LoanTerms = {
  rate: number | null;
  payment: number | null;
  maturity: string | null;
  original: number | null;
  opened: string | null;
  edited: TermField[]; // the fields the owner set; the rest are the bank's, or unknown
};

function readTerms(id: number): LoanTerms | null {
  const r = getDb().prepare("SELECT rate, payment, maturity, original, opened, edited FROM loan_terms WHERE accountId = ?").get(id) as
    | (Omit<LoanTerms, "edited"> & { edited: string })
    | undefined;
  return r ? { ...r, edited: r.edited ? (r.edited.split(",") as TermField[]) : [] } : null;
}
function writeTerms(id: number, t: LoanTerms) {
  getDb()
    .prepare(
      `INSERT INTO loan_terms (accountId, rate, payment, maturity, original, opened, edited)
       VALUES (@id, @rate, @payment, @maturity, @original, @opened, @edited)
       ON CONFLICT(accountId) DO UPDATE SET rate = excluded.rate, payment = excluded.payment,
         maturity = excluded.maturity, original = excluded.original, opened = excluded.opened, edited = excluded.edited`
    )
    .run({ id, ...t, edited: t.edited.join(",") });
}
const EMPTY_TERMS: LoanTerms = { rate: null, payment: null, maturity: null, original: null, opened: null, edited: [] };

// What the bank reports for a linked loan (Plaid Liabilities: a mortgage's
// rate and next payment). It fills only the fields the owner hasn't set, and
// a field it doesn't report keeps what it had. Returns the loans updated.
export type BankTerms = { plaidAccountId: string; rate?: number | null; payment?: number | null };
export function recordBankTerms(rows: BankTerms[]): number {
  const db = getDb();
  ensureAccounts(db);
  const byPlaid = db.prepare("SELECT id FROM accounts WHERE plaidAccountId = ? AND side = 'liability'");
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const a = byPlaid.get(r.plaidAccountId) as { id: number } | undefined;
      if (!a) continue;
      const t = readTerms(a.id) ?? { ...EMPTY_TERMS, edited: [] };
      if (r.rate != null && !t.edited.includes("rate")) t.rate = r.rate;
      if (r.payment != null && !t.edited.includes("payment")) t.payment = r.payment;
      writeTerms(a.id, t);
      n++;
    }
  })();
  return n;
}

// The owner sets a loan's terms. A value marks the field edited, so the bank
// leaves it alone; null clears it, back to unknown until the bank reports it.
export function setTerms(id: number, patch: Partial<Record<TermField, number | string | null>>): boolean {
  const a = account(id);
  if (!a || a.side !== "liability") return false;
  const t = readTerms(id) ?? { ...EMPTY_TERMS, edited: [] };
  const edited = new Set(t.edited);
  for (const f of TERM_FIELDS) {
    if (!(f in patch)) continue;
    const v = patch[f];
    (t as Record<TermField, unknown>)[f] = v ?? null;
    if (v == null) edited.delete(f);
    else edited.add(f);
  }
  writeTerms(id, { ...t, edited: TERM_FIELDS.filter((f) => edited.has(f)) });
  if (a.source === "manual") projectLoanPayments(id); // a new rate changes the estimates
  return true;
}

// Which asset a loan is against (a mortgage's home, a boat loan's boat), or
// none. Only a loan points, and only at something owned.
export function setSecuredBy(loanId: number, assetId: number | null): boolean {
  const loan = account(loanId);
  if (!loan || loan.side !== "liability") return false;
  if (assetId != null) {
    const asset = account(assetId);
    if (!asset || asset.side !== "asset") return false;
  }
  getDb().prepare("UPDATE accounts SET securedBy = ? WHERE id = ?").run(assetId, loanId);
  return true;
}

// ---- Net worth over time ---------------------------------------------------

// The trend and the change against a month ago. History begins the first day
// Daybook recorded a balance, so both wait: the line until two weeks of it
// (fewer points read as noise), the change until a month of it. An account
// added later (a new link, a home entered by hand) counts from the start at
// its first value: otherwise adding it would draw a rise that never happened
// and report it as a change, when only the record grew. Like for like.
export { TREND_MIN_DAYS };
export const CHANGE_DAYS = 30;
export type NetWorthTrend = {
  start: string | null; // the first day with a balance
  series: { date: string; net: number }[] | null; // daily, once TREND_MIN_DAYS have passed
  prev: { date: string; owned: number; owed: number; net: number } | null; // CHANGE_DAYS ago, once reached
};
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export function netWorthTrend(today: string): NetWorthTrend {
  const db = getDb();
  ensureAccounts(db);
  const rows = db
    .prepare(
      `SELECT a.id, a.side, b.asOf, b.amount FROM accounts a JOIN balances b ON b.accountId = a.id
       WHERE a.hidden = 0 AND a.inNetWorth = 1 AND b.asOf <= ? ORDER BY a.id, b.asOf`
    )
    .all(today) as { id: number; side: Side; asOf: string; amount: number }[];
  if (rows.length === 0) return { start: null, series: null, prev: null };
  const byAccount = new Map<number, { side: Side; points: { asOf: string; amount: number }[] }>();
  for (const r of rows) {
    const a = byAccount.get(r.id) ?? { side: r.side, points: [] };
    a.points.push({ asOf: r.asOf, amount: r.amount });
    byAccount.set(r.id, a);
  }
  // Each account's value on a day: its latest on or before it, else its first.
  const at = (day: string) => {
    let owned = 0, owed = 0;
    for (const a of byAccount.values()) {
      let v = a.points[0].amount;
      for (const p of a.points) if (p.asOf <= day) v = p.amount; else break;
      if (a.side === "asset") owned += v; else owed += v;
    }
    const r2 = (n: number) => Number(n.toFixed(2));
    return { owned: r2(owned), owed: r2(owed), net: r2(owned - owed) };
  };
  const start = rows.reduce((m, r) => (r.asOf < m ? r.asOf : m), rows[0].asOf);
  let series: NetWorthTrend["series"] = null;
  if (addDays(start, TREND_MIN_DAYS) <= today) {
    series = [];
    for (let d = start; d <= today; d = addDays(d, 1)) series.push({ date: d, net: at(d).net });
  }
  const back = addDays(today, -CHANGE_DAYS);
  return { start, series, prev: start <= back ? { date: back, ...at(back) } : null };
}

// ---- Loans kept by hand, lowered by their payments ---------------------------

// A loan the bank link can't see (a car loan) has its balance from the owner.
// Between statements, each payment Daybook sees going to it lowers the
// balance: interest at the loan's rate for the days since the last balance
// (simple daily interest, as car loans accrue), then the payment. These are
// recorded as estimates, dated the payment's day. The owner's latest
// statement balance is the anchor: everything after it is recomputed on
// every run, so typing a new statement figure resets the estimates from it,
// and a missed payment simply lowers nothing.
export function projectLoanPayments(id: number): number {
  const db = getDb();
  ensureAccounts(db);
  const a = db.prepare("SELECT id, source, side, paidBy FROM accounts WHERE id = ?").get(id) as
    | { id: number; source: string; side: Side; paidBy: string | null }
    | undefined;
  if (!a || a.source !== "manual" || a.side !== "liability") return 0;
  const anchor = db
    .prepare("SELECT asOf, amount FROM balances WHERE accountId = ? AND source != 'estimate' ORDER BY asOf DESC LIMIT 1")
    .get(id) as { asOf: string; amount: number } | undefined;
  const rate = readTerms(id)?.rate;
  return db.transaction(() => {
    // Estimates are this function's own output: clear them, then rebuild.
    db.prepare("DELETE FROM balances WHERE accountId = ? AND source = 'estimate'").run(id);
    if (!anchor || !a.paidBy || rate == null) return 0;
    // The vendor and every name combined with it: a lender's payments can post
    // under two descriptors ("Hmf Hmfusa.com", "Hyundai Motor Finance").
    const payments = db
      .prepare(
        `WITH v(name) AS (
           SELECT @vendor
           UNION SELECT primaryMerchant FROM merchant_links WHERE alias = @vendor COLLATE NOCASE
         ), names(name) AS (
           SELECT name FROM v
           UNION SELECT alias FROM merchant_links WHERE primaryMerchant IN (SELECT name FROM v)
         )
         SELECT COALESCE(effectiveDate, date) AS day, SUM(-amount) AS paid FROM transactions
         WHERE merchant COLLATE NOCASE IN (SELECT name FROM names) AND amount < 0 AND pending = 0 AND hash NOT LIKE '%:s%'
           AND COALESCE(effectiveDate, date) > @after
         GROUP BY day ORDER BY day`
      )
      .all({ vendor: a.paidBy, after: anchor.asOf }) as { day: string; paid: number }[];
    const write = db.prepare("INSERT OR REPLACE INTO balances (accountId, asOf, amount, source) VALUES (?, ?, ?, 'estimate')");
    let balance = anchor.amount;
    let since = anchor.asOf;
    for (const p of payments) {
      const days = (Date.parse(p.day + "T00:00:00Z") - Date.parse(since + "T00:00:00Z")) / 86400000;
      balance = Math.max(0, balance * (1 + (rate / 100) * (days / 365)) - p.paid);
      balance = Number(balance.toFixed(2));
      write.run(id, p.day, balance);
      since = p.day;
    }
    return payments.length;
  })();
}

// Every hand-kept loan with a payer: after a sync brings new payments.
export function projectAllLoanPayments(): number {
  const db = getDb();
  ensureAccounts(db);
  const ids = db.prepare("SELECT id FROM accounts WHERE source = 'manual' AND side = 'liability' AND paidBy IS NOT NULL").all() as { id: number }[];
  return ids.reduce((n, r) => n + projectLoanPayments(r.id), 0);
}

// Name the vendor a hand-kept loan's payments post under, or none.
export function setPaidBy(id: number, vendor: string | null): boolean {
  const a = account(id);
  if (!a || a.source !== "manual" || a.side !== "liability") return false;
  getDb().prepare("UPDATE accounts SET paidBy = ? WHERE id = ?").run(vendor?.trim() || null, id);
  projectLoanPayments(id);
  return true;
}

function payersFor(payment: number | null): string[] {
  if (payment == null) return [];
  const since = new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 10);
  return (
    getDb()
      .prepare(
        `SELECT merchant FROM transactions WHERE amount BETWEEN ? AND ? AND date >= ?
         GROUP BY merchant ORDER BY COUNT(*) DESC LIMIT 5`
      )
      .all(-payment * 1.05, -payment * 0.95, since) as { merchant: string }[]
  ).map((r) => r.merchant);
}

// The owner's order for a section's accounts, top to bottom (dragged on the
// Accounts page). Only the order within a section matters, so each gets its
// index there; accounts never ordered sort after, as before (kind, then name).
export function setAccountOrder(ids: number[]): void {
  const db = getDb();
  ensureAccounts(db);
  const set = db.prepare("UPDATE accounts SET position = ? WHERE id = ?");
  db.transaction(() => ids.forEach((id, i) => set.run(i, id)))();
}
