import { getDb, ensurePlanMatchTables, ensureRecurringTxInclusions } from "./db";
import { getChargeMoves, vendorScope } from "./chargeVendors";
import { canonicalMerchant, getMerchantLinks, merchantVariants } from "./queries";
import { merchantKey } from "./merchant";

// Moving a charge to another vendor. Precedence: the owner's own move, then
// plan matching's ('auto'), then the bank name. A move never overwrites a
// stronger one.
export type Origin = "user" | "auto";
const RANK: Record<Origin, number> = { auto: 1, user: 2 };

type Charge = { hash: string; merchant: string; amount: number; categoryByHand: number };
const chargeOf = (hash: string) =>
  getDb().prepare("SELECT hash, merchant, amount, categoryByHand FROM transactions WHERE hash = ?").get(hash) as Charge | undefined;

// A moved charge takes its vendor's category, the one most of the vendor's
// other charges carry, unless the owner set this charge's category by hand.
function followCategory(hash: string) {
  const db = getDb();
  const c = chargeOf(hash);
  if (!c || c.categoryByHand) return;
  const vendor = getChargeMoves().get(hash) ?? c.merchant;
  const scope = vendorScope(merchantVariants(vendor));
  const top = db
    .prepare(
      `SELECT categoryId FROM transactions WHERE ${scope.sql} AND hash != ? AND categoryId IS NOT NULL AND excluded = 0
       GROUP BY categoryId ORDER BY COUNT(*) DESC LIMIT 1`
    )
    .get(...scope.args, hash) as { categoryId: number } | undefined;
  if (top) db.prepare("UPDATE transactions SET categoryId = ? WHERE hash = ?").run(top.categoryId, hash);
}

// Move one charge (vendor: a bank name), or with null undo a move of this
// origin, back to its bank name. Returns whether the charge's vendor changed
// hands.
export function setChargeVendor(hash: string, vendor: string | null, origin: Origin): boolean {
  const db = getDb();
  getChargeMoves(); // the table, on the live connection
  const c = chargeOf(hash);
  if (!c) return false;
  const held = db.prepare("SELECT vendor, origin FROM charge_vendors WHERE hash = ?").get(hash) as { vendor: string; origin: Origin } | undefined;
  if (vendor == null) {
    if (!held || held.origin !== origin) return false;
    db.prepare("DELETE FROM charge_vendors WHERE hash = ?").run(hash);
    followCategory(hash);
    return true;
  }
  if (held && RANK[held.origin] > RANK[origin]) return false;
  if (held && held.vendor === vendor && held.origin === origin) return false;
  // A move to the charge's own bank name is no move; the owner's says so
  // anyway, so plan matching doesn't move it back.
  if (vendor === c.merchant && origin !== "user") {
    if (held) db.prepare("DELETE FROM charge_vendors WHERE hash = ?").run(hash);
  } else {
    db.prepare(
      `INSERT INTO charge_vendors (hash, vendor, origin) VALUES (?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET vendor = excluded.vendor, origin = excluded.origin, ruleId = NULL`
    ).run(hash, vendor, origin);
  }
  followCategory(hash);
  return true;
}

// Once, from the way a charge used to join another vendor's plan (#296): a
// scored match (plan_matches) or the owner's pin into that plan. Both said the
// charge was the other vendor's; now that is said by moving the charge. A
// match becomes plan matching's move ('auto'); a pin, the owner's ('user'),
// and stays as their In plan. Idempotent: it finds nothing the second time.
export function migrateCrossVendorPlans() {
  const db = getDb();
  ensurePlanMatchTables(db);
  ensureRecurringTxInclusions(db);
  getChargeMoves(); // the table, on the live connection
  const links = getMerchantLinks();
  const vendorOfKey = db.prepare("SELECT vendor FROM plans WHERE key = ?");
  const matches = db.prepare("SELECT hash, plan FROM plan_matches").all() as { hash: string; plan: string }[];
  for (const m of matches) {
    const p = vendorOfKey.get(m.plan) as { vendor: string } | undefined;
    if (p) setChargeVendor(m.hash, p.vendor, "auto");
  }
  if (matches.length) db.prepare("DELETE FROM plan_matches").run();
  const moves = getChargeMoves();
  const vendorKey = (name: string) => {
    const c = canonicalMerchant(name, links);
    return merchantKey(c) || c;
  };
  const pins = db
    .prepare(
      `SELECT i.hash, t.merchant, p.vendor FROM recurring_tx_inclusions i
       JOIN transactions t ON t.hash = i.hash JOIN plans p ON p.key = i.plan`
    )
    .all() as { hash: string; merchant: string; vendor: string }[];
  for (const pin of pins)
    if (vendorKey(moves.get(pin.hash) ?? pin.merchant) !== vendorKey(pin.vendor)) setChargeVendor(pin.hash, pin.vendor, "user");
}
