// Shared scaffolding for the DB-backed suites. Import this module FIRST in a
// test file: it points every DB access at a throwaway SQLite file for this
// process (getDb reads COPILOT_DB_PATH at call time, so the real
// data/copilot.db is never touched), and removes the file when the file's
// tests finish. One wipe list for every suite — the per-file lists had drifted
// (5 / 8 / 10 tables; one never wiped categories, so rows leaked across tests).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.COPILOT_DB_PATH = path.join(
  os.tmpdir(),
  `copilot-test-${process.pid}-${Date.now()}.db`
);

import { after, beforeEach } from "node:test";
import { getDb } from "../src/lib/db";
import { detectRecurrings } from "../src/lib/core";
import { confirmPlan } from "../src/lib/queries";

after(() => {
  const p = process.env.COPILOT_DB_PATH!;
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
});

// Every mutable table in the schema (src/lib/db.ts). Add here when a table is added.
export const TABLES = [
  "transactions",
  "recurrings",
  "rules",
  "merchant_links",
  "recurring_settings",
  "recurring_overrides",
  "recurring_tx_exclusions",
  "recurring_tx_inclusions",
  "plans",
  "plan_charges",
  "merchant_merge_dismissals",
  "merchant_cleanup_log",
  "split_rules",
  "budget_entries",
  "categories",
  "loan_terms",
  "balances",
  "accounts",
];

export function wipe(except: string[] = []) {
  const db = getDb();
  for (const t of TABLES) if (!except.includes(t)) db.exec(`DELETE FROM ${t}`);
  // Created lazily (by the suggestion queue, by the digests), so they may not exist yet.
  for (const t of ["category_model_answers", "category_suggestion_dismissals", "digest_sent"]) db.exec(`DROP TABLE IF EXISTS ${t}`);
}

// A clean database before every test in the file. `except` keeps fixture rows a
// file creates once in before() (e.g. its categories).
export function cleanDbBeforeEach(except: string[] = []) {
  beforeEach(() => wipe(except));
}

export function addCat(name: string, kind = "expense", excludeFromTotals = 0): number {
  const info = getDb()
    .prepare("INSERT INTO categories (name, color, icon, kind, excludeFromTotals) VALUES (?,?,?,?,?)")
    .run(name, "#888", "•", kind, excludeFromTotals);
  return Number(info.lastInsertRowid);
}

let hashSeq = 0;

// One transaction with every overlay available (the invariants suite's fixture).
export type TxOpts = {
  amount: number;
  date?: string;
  effectiveDate?: string | null;
  categoryId?: number | null;
  excluded?: 0 | 1;
  account?: string;
  hash?: string;
  recurringId?: number | null;
};
export function tx(merchant: string, o: TxOpts) {
  getDb()
    .prepare(
      `INSERT INTO transactions (date, effectiveDate, merchant, amount, categoryId, account, excluded, recurringId, source, hash)
       VALUES (@date, @effectiveDate, @merchant, @amount, @categoryId, @account, @excluded, @recurringId, 'test', @hash)`
    )
    .run({
      date: o.date ?? "2025-06-15",
      effectiveDate: o.effectiveDate ?? null,
      merchant,
      amount: o.amount,
      categoryId: o.categoryId ?? null,
      account: o.account ?? "Checking",
      excluded: o.excluded ?? 0,
      recurringId: o.recurringId ?? null,
      hash: o.hash ?? `h${hashSeq++}`,
    });
}

// Several charges for one vendor (the detection suites' fixture).
export function seed(
  merchant: string,
  rows: { date: string; amount: number }[],
  opts: { categoryId?: number | null; account?: string } = {}
) {
  const ins = getDb().prepare(
    "INSERT INTO transactions (date, merchant, amount, account, categoryId, source, hash) VALUES (?,?,?,?,?,?,?)"
  );
  for (const r of rows)
    ins.run(r.date, merchant, r.amount, opts.account ?? "Checking", opts.categoryId ?? null, "test", `h${hashSeq++}`);
}

// The 15th of `n` consecutive months from `startMonth` (1-based; rolls over the year).
export function months(startMonth: number, n: number, amounts: number | number[], year = 2025) {
  return Array.from({ length: n }, (_, i) => {
    const m = startMonth + i;
    const yy = year + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    return { date: `${yy}-${String(mm).padStart(2, "0")}-15`, amount: Array.isArray(amounts) ? amounts[i] : amounts };
  });
}

// Relative dates, for anything the clock judges ("active", "upcoming", "so far").
// Pinned dates rot: the clock sweep (npm run test:clock) proves these don't.
export const daysAgo = (n: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
export const daysFromNow = (n: number): string => daysAgo(-n);
// The last `n` times day-of-month `day` fell on or before today, oldest first:
// a monthly bill that is still live at any clock (npm run test:clock).
export function lastMonthlyDates(n: number, day: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let back = 0; out.length < n; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, day));
    if (d.getUTCDate() !== day) continue; // the month has no such day
    const iso = d.toISOString().slice(0, 10);
    if (iso <= now.toISOString().slice(0, 10)) out.unshift(iso);
  }
  return out;
}

// Plans count only once confirmed (the owner accepts what the detector
// found). A test about bills, totals or the digest, not about accepting,
// detects and then accepts every plan, as an owner who added them all.
export function confirmAll() {
  for (const r of getDb().prepare("SELECT merchant FROM recurrings").all() as { merchant: string }[]) confirmPlan(r.merchant);
}
export function detectAndConfirm() {
  const plans = detectRecurrings();
  confirmAll();
  return plans;
}
