import { getDb, ensurePlanMatchTables, ensureRecurringTxInclusions } from "./db";
import { getChargeMoves, vendorScope } from "./chargeVendors";
import { canonicalMerchant, getMerchantLinks, merchantVariants } from "./queries";
import { merchantKey } from "./merchant";

// Moving a charge to another vendor, and the rules that move a bank name's
// charges at one amount. Precedence: the owner's own move, then a rule, then
// plan matching's ('auto'), then the bank name. A move never overwrites a
// stronger one, and undoing one falls back to the next that applies.
export type Origin = "user" | "rule" | "auto";
const RANK: Record<Origin, number> = { auto: 1, rule: 2, user: 3 };

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

// The rule that matches a charge, if any: its bank name, and its amount to
// the cent (a rule is the earliest made, when two match).
function ruleFor(c: Charge): { id: number; vendor: string } | undefined {
  return getDb()
    .prepare("SELECT id, vendor FROM vendor_rules WHERE merchant = ? AND ABS(amount - ?) < 0.005 ORDER BY id LIMIT 1")
    .get(c.merchant, Math.abs(c.amount)) as { id: number; vendor: string } | undefined;
}

// Move one charge (vendor: a bank name), or with null undo a move of this
// origin and fall back: an undone 'user' move gives way to a rule. Returns
// whether the charge's vendor changed hands.
export function setChargeVendor(hash: string, vendor: string | null, origin: Origin, ruleId: number | null = null): boolean {
  const db = getDb();
  getChargeMoves(); // the table, on the live connection
  const c = chargeOf(hash);
  if (!c) return false;
  const held = db.prepare("SELECT vendor, origin FROM charge_vendors WHERE hash = ?").get(hash) as { vendor: string; origin: Origin } | undefined;
  if (vendor == null) {
    if (!held || held.origin !== origin) return false;
    db.prepare("DELETE FROM charge_vendors WHERE hash = ?").run(hash);
    const rule = origin === "user" ? ruleFor(c) : undefined;
    if (rule) db.prepare("INSERT INTO charge_vendors (hash, vendor, origin, ruleId) VALUES (?, ?, 'rule', ?)").run(hash, rule.vendor, rule.id);
    followCategory(hash);
    return true;
  }
  if (held && RANK[held.origin] > RANK[origin]) return false;
  if (held && held.vendor === vendor && held.origin === origin) return false;
  // A move to the charge's own bank name is no move; the owner's says so
  // anyway, so a rule doesn't move it back.
  if (vendor === c.merchant && origin !== "user") {
    if (held) db.prepare("DELETE FROM charge_vendors WHERE hash = ?").run(hash);
  } else {
    db.prepare(
      `INSERT INTO charge_vendors (hash, vendor, origin, ruleId) VALUES (?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET vendor = excluded.vendor, origin = excluded.origin, ruleId = excluded.ruleId`
    ).run(hash, vendor, origin, ruleId);
  }
  followCategory(hash);
  return true;
}

// The charges a rule would move: the bank name's, at the amount, not the
// owner's own moves. For the preview before a rule is made.
export function ruleMatches(merchant: string, amount: number): { hash: string; date: string; amount: number }[] {
  getChargeMoves();
  return getDb()
    .prepare(
      `SELECT t.hash, COALESCE(t.effectiveDate, t.date) AS date, t.amount FROM transactions t
       WHERE t.merchant = ? AND ABS(ABS(t.amount) - ?) < 0.005 AND t.hash NOT LIKE '%:s%'
         AND t.hash NOT IN (SELECT hash FROM charge_vendors WHERE origin = 'user')
       ORDER BY date DESC`
    )
    .all(merchant, Math.abs(amount)) as { hash: string; date: string; amount: number }[];
}

export function createVendorRule(merchant: string, amount: number, vendor: string): number {
  getChargeMoves();
  const info = getDb()
    .prepare("INSERT INTO vendor_rules (merchant, amount, vendor) VALUES (?, ?, ?)")
    .run(merchant, Math.abs(amount), vendor);
  const id = Number(info.lastInsertRowid);
  applyVendorRules();
  return id;
}

// Remove a rule: the charges it moved go back (to another rule that matches
// them, else their bank name).
export function deleteVendorRule(id: number) {
  const db = getDb();
  getChargeMoves();
  const moved = db.prepare("SELECT hash FROM charge_vendors WHERE ruleId = ? AND origin = 'rule'").all(id) as { hash: string }[];
  db.prepare("DELETE FROM vendor_rules WHERE id = ?").run(id);
  for (const { hash } of moved) setChargeVendor(hash, null, "rule");
  applyVendorRules();
}

// Every rule over every charge it matches: as a sync lands new charges, and
// after a rule is made or removed. Returns how many charges moved.
export function applyVendorRules(): number {
  const db = getDb();
  getChargeMoves();
  const rules = db.prepare("SELECT id, merchant, amount, vendor FROM vendor_rules ORDER BY id").all() as {
    id: number;
    merchant: string;
    amount: number;
    vendor: string;
  }[];
  let n = 0;
  const seen = new Set<string>();
  for (const r of rules)
    for (const m of ruleMatches(r.merchant, r.amount)) {
      if (seen.has(m.hash)) continue; // the earliest rule wins
      seen.add(m.hash);
      if (setChargeVendor(m.hash, r.vendor, "rule", r.id)) n++;
    }
  return n;
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
