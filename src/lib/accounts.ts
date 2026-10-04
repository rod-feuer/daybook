import { getDb, ensureAccounts } from "./db";
import type { PlaidAccount, PlaidItem } from "./plaid";
import type { ManualKind } from "./accountKinds";

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
  }[];
};
export function netWorth(asOf: string): NetWorth {
  const db = getDb();
  ensureAccounts(db);
  const accounts = (
    db
      .prepare(
        `SELECT a.id, a.name, a.side, a.kind, a.source AS origin, a.subtype, a.mask, a.inNetWorth AS counted,
                b.amount, b.asOf, b.source
         FROM accounts a
         JOIN balances b ON b.accountId = a.id
          AND b.asOf = (SELECT MAX(asOf) FROM balances WHERE accountId = a.id AND asOf <= @asOf)
         WHERE a.hidden = 0
         ORDER BY a.side, a.kind, a.name`
      )
      .all({ asOf }) as (Omit<NetWorth["accounts"][number], "counted"> & { counted: number })[]
  ).map((a) => ({ ...a, counted: a.counted === 1 }));
  const sum = (side: Side) => accounts.filter((a) => a.counted && a.side === side).reduce((t, a) => t + a.amount, 0);
  const owned = Number(sum("asset").toFixed(2));
  const owed = Number(sum("liability").toFixed(2));
  return { owned, owed, net: Number((owned - owed).toFixed(2)), accounts };
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
  getDb()
    .prepare(
      `INSERT INTO balances (accountId, asOf, amount, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(accountId, asOf) DO UPDATE SET amount = excluded.amount, source = excluded.source`
    )
    .run(id, v.asOf, v.amount, v.estimate ? "estimate" : "owner");
  return true;
}

// Remove one dated value from a hand-kept account, keeping at least one: an
// account with no value would vanish from the page, where it could be fixed.
export function removeValue(id: number, asOf: string): boolean {
  const a = account(id);
  if (!a || a.source !== "manual") return false;
  const db = getDb();
  const n = (db.prepare("SELECT COUNT(*) AS n FROM balances WHERE accountId = ?").get(id) as { n: number }).n;
  if (n <= 1) return false;
  return db.prepare("DELETE FROM balances WHERE accountId = ? AND asOf = ?").run(id, asOf).changes > 0;
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
};
export function accountDetail(id: number): AccountDetail | null {
  const db = getDb();
  ensureAccounts(db);
  const a = db
    .prepare("SELECT id, name, side, kind, source AS origin, subtype, mask, inNetWorth FROM accounts WHERE id = ?")
    .get(id) as (Omit<AccountDetail, "counted" | "history"> & { inNetWorth: number }) | undefined;
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
