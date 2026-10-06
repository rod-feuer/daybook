import type Database from "better-sqlite3";
import { getDb, ensureChargeVendors } from "./db";

// A charge's vendor is its bank name's, unless the charge was moved
// (charge_vendors): the bank sends Google One and Google Workspace both as
// "Google", so whole bank names can't tell them apart. Reads only; the
// writes are in vendorMoves.ts.

// On the live connection once (a server started before the table existed).
const ready = new WeakSet<Database.Database>();
function ensure(db: Database.Database) {
  if (ready.has(db)) return;
  ensureChargeVendors(db);
  ready.add(db);
}

// The charges that are a vendor's, as SQL: its bank names' charges, less those
// moved to another vendor, plus those moved to it. `variants` are the
// vendor's bank names (merchantVariants), and a moved charge's vendor is
// stored as a bank name, so "moved to it" is a lookup in the same list.
// `t` is the transactions table's alias in the caller's query, if any.
export function vendorScope(variants: string[], t = ""): { sql: string; args: string[] } {
  ensure(getDb());
  const c = t ? `${t}.` : "";
  const ph = variants.map(() => "?").join(",");
  return {
    sql: `((${c}merchant IN (${ph}) AND ${c}hash NOT IN (SELECT hash FROM charge_vendors)) OR ${c}hash IN (SELECT hash FROM charge_vendors WHERE vendor IN (${ph})))`,
    args: [...variants, ...variants],
  };
}

// hash → the bank name of the vendor the charge was moved to.
export function getChargeMoves(): Map<string, string> {
  const db = getDb();
  ensure(db);
  const rows = db.prepare("SELECT hash, vendor FROM charge_vendors").all() as { hash: string; vendor: string }[];
  return new Map(rows.map((r) => [r.hash, r.vendor]));
}

// The name a charge is grouped under: where it was moved, else its bank name.
// Resolve the result through canonicalMerchant, as a bank name.
export function vendorName(row: { merchant: string; hash: string }, moves: Map<string, string>): string {
  return moves.get(row.hash) ?? row.merchant;
}
