import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb, ensureRecurringTxExclusions, ensureRecurringTxInclusions, ensurePlanCharges } from "./db";
import { categorizeByRules, categorizeByHistory, detectRecurrings } from "./core";
import { applySplitRules } from "./splits";
import { normalizeMerchant } from "./merchant";
import { nameAffinity, NAME_MATCH } from "./merges";

const run = promisify(execFile);
const CLI = process.env.PLAID_CLI_PATH || "plaid";

type PlaidTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number; // Plaid sign: positive = money out (our expenses)
  pending: boolean;
};
type PlaidAccount = { account_id: string; name: string; type?: string };
export type PlaidItem = { accounts: PlaidAccount[]; transactions: PlaidTxn[] };

// Pull transactions for a date range via the Plaid CLI. We use `transactions
// list` (not `sync`) on purpose: it's idempotent and cursor-free, so manual CLI
// use and the app's "Sync now" can't corrupt a shared cursor. Dedup happens on
// transaction_id downstream. Returns one entry per linked item.
export async function fetchPlaidTransactions(
  startDate: string,
  endDate: string
): Promise<PlaidItem[]> {
  const PAGE = 500;
  const byItem = new Map<string, PlaidItem>();
  let offset = 0;
  // Paginate until a page yields fewer than a full page of transactions.
  // (Per-item offset; fine for the single-/few-item personal case.)
  for (;;) {
    const { stdout } = await run(
      CLI,
      [
        "transactions", "list", "--all", "--json",
        "--start-date", startDate, "--end-date", endDate,
        "--count", String(PAGE), "--offset", String(offset),
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout) as {
      items?: { item?: { item_id?: string }; accounts?: PlaidAccount[]; transactions?: PlaidTxn[] }[];
    };
    let pageCount = 0;
    for (const it of data.items ?? []) {
      const id = it.item?.item_id ?? "default";
      const acc = byItem.get(id) ?? { accounts: it.accounts ?? [], transactions: [] };
      acc.transactions.push(...(it.transactions ?? []));
      pageCount += it.transactions?.length ?? 0;
      byItem.set(id, acc);
    }
    if (pageCount < PAGE) break;
    offset += PAGE;
  }
  return [...byItem.values()];
}

// Where to start the Plaid pull. To avoid duplicating imported back-history
// (Copilot/CSV rows dedup on a different key than Plaid's transaction_id), begin
// the day AFTER our latest non-Plaid transaction — Plaid then only contributes
// genuinely new, forward-going data. Falls back to a 2-year backfill if there's
// no prior history at all.
export function plaidSyncStartDate(): string {
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(date) d FROM transactions WHERE source != 'plaid'")
    .get() as { d: string | null };
  if (row?.d) {
    const dt = new Date(row.d + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }
  const back = new Date();
  back.setUTCFullYear(back.getUTCFullYear() - 2);
  return back.toISOString().slice(0, 10);
}

// Upsert Plaid transactions into our store. Dedup key is the Plaid
// transaction_id (stored as `hash`), so re-syncing is idempotent and `modified`
// transactions (pending -> posted, amount finalized) update in place. We flip
// the amount sign (Plaid: + = outflow; ours: - = expense) and never overwrite an
// existing categoryId on update, preserving rule/manual categorization.
// Every row keeps its id across syncs, pending ones included: the app holds
// ids in an open page (a tapped charge fetches by id), and a pending row that
// was wiped and re-inserted on each sync came back under a new id, so a tap in
// the seconds after launch found nothing. A pending row Plaid stops returning
// has posted under a new id (or reconciled below) and is dropped then.
// `updated` counts rows whose date, amount, account or pending flag actually
// changed — not every row the pull happened to contain, which had the launch
// toast reporting "1002 updated" when nothing had.
export function importPlaidTransactions(items: PlaidItem[]): {
  inserted: number;
  updated: number;
  reconciled: number;
  relinked: number;
  aliased: number;
} {
  const db = getDb();
  type Held = { hash: string; date: string; merchant: string; rawMerchant: string | null; amount: number; account: string; pending: number };
  const held = new Map<string, Held>();
  for (const r of db
    .prepare("SELECT hash, date, merchant, rawMerchant, amount, account, pending FROM transactions WHERE source = 'plaid'")
    .all() as Held[])
    held.set(r.hash, r);
  // User edits on pending rows. A re-pulled pending row keeps them (the upsert
  // never touches them); a pending row that posts under a NEW transaction_id
  // vanishes, so its edits are carried onto the posted twin instead of lost.
  type Edits = { categoryId: number | null; note: string | null; effectiveDate: string | null };
  const pendingEdits = new Map<string, Edits>();
  for (const r of db
    .prepare(
      "SELECT hash, categoryId, note, effectiveDate FROM transactions WHERE source = 'plaid' AND pending = 1"
    )
    .all() as ({ hash: string } & Edits)[]) {
    if (r.categoryId != null || r.note != null || r.effectiveDate != null)
      pendingEdits.set(r.hash, {
        categoryId: r.categoryId,
        note: r.note,
        effectiveDate: r.effectiveDate,
      });
  }
  // A charge keeps the name it was first stored under: combines, name
  // cleanups and vendor shelves key on it, and a later pull (a relinked bank
  // especially) can name the same charge differently. The 2026-10-02 relink
  // renamed 96 held charges, and 69 fell out of the vendor they'd been
  // combined into ("Southern Ridge Landscaindianapolis" became "Southern
  // Ridge"). So an update never touches merchant or rawMerchant.
  const upsert = db.prepare(
    `INSERT INTO transactions (date, merchant, rawMerchant, amount, categoryId, account, pending, source, hash)
     VALUES (@date, @merchant, @rawMerchant, @amount, @categoryId, @account, @pending, 'plaid', @hash)
     ON CONFLICT(hash) DO UPDATE SET
       date = excluded.date,
       amount = excluded.amount,
       account = excluded.account,
       pending = excluded.pending`
  );
  const drop = db.prepare("DELETE FROM transactions WHERE hash = ?");
  // A posted twin for a pending charge: same account + amount, within 3 days.
  // Name affinity (checked in JS) then confirms it's the same vendor.
  const findPosted = db.prepare(
    `SELECT hash, merchant FROM transactions
     WHERE source = 'plaid' AND pending = 0 AND account = @account AND amount = @amount
       AND ABS(julianday(COALESCE(effectiveDate, date)) - julianday(@date)) <= 3`
  );
  const postedTwin = (r: { account: string; amount: number; date: string; merchant: string }) =>
    (findPosted.all({ account: r.account, amount: r.amount, date: r.date }) as { hash: string; merchant: string }[]).find(
      (q) => nameAffinity(r.merchant, q.merchant) >= NAME_MATCH
    );
  // Carry a vanishing pending row's edits onto its posted twin. categoryId is
  // overridden so the value the row carried wins over a fresh rules/history
  // guess; note and effectiveDate fill only when the twin doesn't have one.
  const restoreEdits = db.prepare(
    `UPDATE transactions SET
       categoryId = COALESCE(@categoryId, categoryId),
       note = COALESCE(note, @note),
       effectiveDate = COALESCE(effectiveDate, @effectiveDate)
     WHERE hash = @hash`
  );
  const carryEdits = (from: string, to: string) => {
    const e = pendingEdits.get(from);
    if (!e) return;
    pendingEdits.delete(from);
    restoreEdits.run({ hash: to, ...e });
  };

  // A relinked bank: re-adding an institution (or Plaid replacing a link)
  // issues new transaction_ids for charges already held, so they'd all import
  // a second time. A charge under an id we don't hold takes over a held row
  // whose own id this pull no longer carries, when account, date, amount,
  // pending state and vendor all agree, one row for one charge. The row keeps
  // its id, category, note and plan; its split parts and plan entries follow
  // the new id.
  ensureRecurringTxExclusions(db);
  ensureRecurringTxInclusions(db);
  ensurePlanCharges(db);
  const rekeyRow = db.prepare("UPDATE transactions SET hash = @to WHERE hash = @from");
  const rekeyParts = db.prepare(
    "UPDATE transactions SET hash = @to || substr(hash, length(@from) + 1) WHERE hash LIKE @from || ':s%'"
  );
  const rekeyRefs = ["recurring_tx_exclusions", "recurring_tx_inclusions", "plan_charges"].map((t) =>
    db.prepare(`UPDATE ${t} SET hash = @to || substr(hash, length(@from) + 1) WHERE hash = @from OR hash LIKE @from || ':s%'`)
  );
  // Names in use before this pull: on a charge, or in a combine.
  const known = new Set(
    (db.prepare(
      "SELECT merchant AS m FROM transactions UNION SELECT alias FROM merchant_links UNION SELECT primaryMerchant FROM merchant_links"
    ).all() as { m: string }[]).map((r) => r.m)
  );
  // A relinked charge that comes back under a name never seen before teaches
  // that name: it becomes an alias of the name the charge is stored under, so
  // the vendor's next charges under it join the same vendor and its combines
  // ("Southern Ridge" for "Southern Ridge Landscaindianapolis"). Undone, like
  // any combine, with Separate.
  const learn = db.prepare("INSERT OR IGNORE INTO merchant_links (alias, primaryMerchant) VALUES (?, ?)");
  let aliased = 0;
  const rekey = (from: string, to: string) => {
    rekeyRow.run({ from, to });
    rekeyParts.run({ from, to });
    for (const r of rekeyRefs) r.run({ from, to });
    const was = held.get(from)!;
    held.delete(from);
    held.set(to, { ...was, hash: to });
  };
  // The vendor check reads both names Plaid sends: a link can return the
  // bank's descriptor where another returned Plaid's cleaned-up name for the
  // same charge ("Benjamin Franklin Pl" against "Ben Franklin Plumbing").
  type Row = { hash: string; date: string; merchant: string; rawMerchant: string; descriptor: string; amount: number; account: string; pending: number };
  const sameSlot = (r: Row, h: Held) =>
    h.account === r.account && h.date === r.date && h.amount === r.amount && h.pending === r.pending;
  const sameCharge = (r: Row, h: Held) =>
    sameSlot(r, h) &&
    (h.rawMerchant === r.rawMerchant ||
      h.rawMerchant === r.descriptor ||
      nameAffinity(r.merchant, h.merchant) >= NAME_MATCH ||
      nameAffinity(normalizeMerchant(r.descriptor), h.merchant) >= NAME_MATCH);

  let inserted = 0;
  let updated = 0;
  let reconciled = 0;
  let relinked = 0;
  const tx = db.transaction((rows: PlaidItem[]) => {
    // Flatten + normalize, then import POSTED before PENDING so a pending row
    // can see its posted twin already in the table.
    const flat = rows.flatMap((item) => {
      const acctName = new Map(item.accounts.map((a) => [a.account_id, a.name]));
      // A loan's or an investment account's own transactions aren't spending:
      // a mortgage payment is already the payment out of checking, and its
      // loan-side record would count it a second time, as income. Their
      // balances are what matter, and come separately.
      const ledger = new Set(
        item.accounts.filter((a) => a.type !== "loan" && a.type !== "investment").map((a) => a.account_id)
      );
      return item.transactions.filter((t) => ledger.has(t.account_id) || !acctName.has(t.account_id)).map((t) => {
        const rawMerchant = t.merchant_name || t.name;
        return {
          date: t.date,
          merchant: normalizeMerchant(rawMerchant),
          rawMerchant,
          amount: -t.amount,
          account: acctName.get(t.account_id) ?? t.account_id,
          pending: t.pending ? 1 : 0,
          hash: t.transaction_id,
          descriptor: t.name, // the bank's own text; merchant_name is Plaid's cleanup of it
        };
      });
    });
    flat.sort((a, b) => a.pending - b.pending); // posted (0) first

    // Held rows this pull doesn't carry by id: the ones a relinked charge may
    // be. Split parts are never Plaid's own rows, so they're never candidates.
    const ids = new Set(flat.map((r) => r.hash));
    const orphans = [...held.values()].filter((h) => !ids.has(h.hash) && !h.hash.includes(":s"));

    const pulled = new Set<string>();
    for (const r of flat) {
      // In-pull pending→posted reconciliation: Plaid returns BOTH versions of a
      // charge during the transition (different transaction_ids) and
      // `transactions list` omits pending_transaction_id — so skip a pending row
      // whose posted twin is already present. Same account+amount+near-date AND
      // a matching name (so a coincidental same-amount charge from another
      // vendor is spared). This approximates Plaid's pending_transaction_id link.
      // Not marked as pulled, so a copy from an earlier sync is dropped below.
      if (r.pending) {
        const twin = postedTwin(r);
        if (twin) {
          carryEdits(r.hash, twin.hash);
          reconciled++;
          continue;
        }
      }
      if (!held.has(r.hash)) {
        // The vendor's names agree; failing that, the one held charge this
        // pull dropped on that account, day and amount ("Sweetnew" came back
        // as "Grubhub"). Two candidates and no name to choose by: no match.
        let i = orphans.findIndex((h) => sameCharge(r, h));
        if (i < 0) {
          const slot = orphans.flatMap((h, j) => (sameSlot(r, h) ? [j] : []));
          if (slot.length === 1) i = slot[0];
        }
        if (i >= 0) {
          rekey(orphans[i].hash, r.hash);
          const stored = orphans[i].merchant;
          if (r.merchant !== stored && !known.has(r.merchant)) {
            aliased += learn.run(r.merchant, stored).changes;
            known.add(r.merchant);
          }
          orphans.splice(i, 1);
          relinked++;
        }
      }
      upsert.run({
        ...r,
        // Ignored on conflict (existing categoryId preserved); applied on
        // fresh inserts. Rules first, then the vendor's own categorization
        // history (a repeat vendor under a new descriptor).
        categoryId: categorizeByRules(r.merchant) ?? categorizeByHistory(r.merchant),
      });
      pulled.add(r.hash);
      const was = held.get(r.hash);
      if (!was) inserted++;
      else if (was.date !== r.date || was.amount !== r.amount || was.account !== r.account || was.pending !== r.pending)
        updated++;
    }

    // Pending rows this pull no longer carries have posted under a new id (or
    // reconciled above): drop them, edits carried to the posted twin if one is
    // in the table now.
    for (const was of held.values()) {
      if (!was.pending || pulled.has(was.hash)) continue;
      const twin = postedTwin(was);
      if (twin) carryEdits(was.hash, twin.hash);
      drop.run(was.hash);
    }
  });
  // Immediate: this transaction reads (is the posted twin here?) before it
  // writes. Deferred, a commit from another process in between fails it at once
  // with SQLITE_BUSY_SNAPSHOT, which no busy timeout retries.
  tx.immediate(items);
  return { inserted, updated, reconciled, relinked, aliased };
}

// A whole sync, callable from anywhere (the route, the digest job): pull from
// the bank since the last imported day, import, apply the split rules, and
// rebuild the plans when anything changed.
export async function syncFromBank(): Promise<{ inserted: number; updated: number; reconciled: number; relinked: number; aliased: number; split: number; total: number }> {
  const end = new Date().toISOString().slice(0, 10);
  // Start after existing history so Plaid doesn't duplicate the back-import.
  // Clamp to `end` in case prior data is future-dated (nothing to pull then).
  const startDate = plaidSyncStartDate();
  const start = startDate > end ? end : startDate;

  const items = await fetchPlaidTransactions(start, end);
  const result = importPlaidTransactions(items);
  const split = applySplitRules();
  if (result.inserted > 0 || result.updated > 0) detectRecurrings();

  const total = items.reduce((a, i) => a + i.transactions.length, 0);
  return { ...result, split, total };
}
