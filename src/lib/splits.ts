import { getDb } from "./db";

export type SplitPart = { categoryId: number; amount: number; label: string };

// Define an auto-split: any transaction whose merchant contains `pattern` and
// whose magnitude equals `amount` gets split into `parts` on the next sync.
export function createSplitRule(
  pattern: string,
  amount: number,
  parts: SplitPart[]
) {
  getDb()
    .prepare("INSERT INTO split_rules (pattern, amount, parts) VALUES (?, ?, ?)")
    .run(pattern.toLowerCase(), amount, JSON.stringify(parts));
}

// Split drift: a rule matches its amount to the cent, so when the vendor changes
// the price (an insurance renewal) the rule silently stops applying — the charge
// posts whole, and the parts' plans read as overdue with nothing saying why. A
// charge from a rule's vendor within 10% of the rule's amount, that no rule
// matches exactly, is reported with the rule's parts scaled to the new total.
// Accepting it records a NEW rule at the new amount (the old one stays, so the
// charges it split can still be undone); the parts keep their labels, so they
// continue the same part-vendors and plans as a price change.
export type SplitDrift = { ruleAmount: number; parts: SplitPart[] };
const DRIFT = 0.1;

// Parts in the same proportions, in cents, summing exactly to `total`: each is
// rounded, and the rounding remainder goes to the largest part.
export function scaleParts(parts: SplitPart[], total: number): SplitPart[] {
  const from = parts.reduce((a, p) => a + p.amount, 0);
  const cents = parts.map((p) => Math.round((p.amount / from) * total * 100));
  const off = Math.round(total * 100) - cents.reduce((a, c) => a + c, 0);
  cents[cents.indexOf(Math.max(...cents))] += off;
  return parts.map((p, i) => ({ ...p, amount: cents[i] / 100 }));
}

type Rule = { id: number; pattern: string; amount: number; parts: SplitPart[] };
export function splitRules(): Rule[] {
  return (getDb().prepare("SELECT id, pattern, amount, parts FROM split_rules ORDER BY id").all() as { id: number; pattern: string; amount: number; parts: string }[]).map(
    (r) => ({ id: r.id, pattern: r.pattern, amount: r.amount, parts: JSON.parse(r.parts) as SplitPart[] })
  );
}

// The rules that act on a vendor, for its shelf: a rule was invisible unless
// you found a charge it had split, and a price change can leave a vendor with
// two. `merchants` are the vendor's own bank descriptors (not the part-vendors
// a split creates, whose names also contain the pattern). `applied` counts the
// charges the rule has split.
export type SplitRuleInfo = { id: number; amount: number; parts: SplitPart[]; applied: number };
export function splitRulesFor(merchants: string[]): SplitRuleInfo[] {
  const names = merchants.map((m) => m.toLowerCase());
  const applied = getDb().prepare(
    `SELECT COUNT(*) AS n FROM transactions t
     WHERE LOWER(t.merchant) LIKE ? AND t.amount < 0 AND ABS(ABS(t.amount) - ?) < 0.01 AND t.excluded = 1
       AND t.hash NOT LIKE '%:s%' AND EXISTS (SELECT 1 FROM transactions s WHERE s.hash LIKE t.hash || ':s%')`
  );
  return splitRules()
    .filter((r) => names.some((m) => m.includes(r.pattern)))
    .map((r) => ({ id: r.id, amount: r.amount, parts: r.parts, applied: (applied.get(`%${r.pattern}%`, r.amount) as { n: number }).n }));
}

export function splitDriftFor(
  tx: { merchant: string; amount: number; pending: number | boolean; excluded: number | boolean; hash: string },
  rules: Rule[] = splitRules()
): SplitDrift | null {
  // Only a charge that could be split: a posted expense that counts, and is not
  // itself a part. (A split parent is excluded.)
  if (tx.amount >= 0 || tx.pending || tx.excluded || tx.hash.includes(":s")) return null;
  const magnitude = Math.abs(tx.amount);
  const mine = rules.filter((r) => tx.merchant.toLowerCase().includes(r.pattern));
  if (mine.some((r) => Math.abs(r.amount - magnitude) < 0.01)) return null; // a rule fits; the next sync applies it
  const near = mine
    .filter((r) => Math.abs(r.amount - magnitude) <= DRIFT * r.amount)
    .sort((a, b) => Math.abs(a.amount - magnitude) - Math.abs(b.amount - magnitude))[0];
  return near ? { ruleAmount: near.amount, parts: scaleParts(near.parts, magnitude) } : null;
}

// Apply all split rules to matching, not-yet-split transactions. Idempotent:
// a parent is "already split" once child rows (hash `<parent>:s*`) exist, and a
// split parent is marked excluded so it never double-counts or re-matches.
// Pending charges are split too, so a bill shows in its parts' categories
// while it waits to post. The parts are pending while their parent is, and
// follow it: a sync that drops a pending row drops its parts (importPlaid
// Transactions), so the posted row splits afresh; a parent whose amount no
// longer matches its parts (it posted at a different amount) is restored to
// counting whole and re-matched.
// Expenses only: the parts are inserted as debits, so matching on magnitude
// alone turned a refund of exactly the rule's amount into that much spending.
export function applySplitRules(): number {
  const db = getDb();
  const rules = db
    .prepare("SELECT pattern, amount, parts FROM split_rules")
    .all() as { pattern: string; amount: number; parts: string }[];
  if (rules.length === 0) return 0;

  const findMatches = db.prepare(
    `SELECT id, date, merchant, amount, account, source, hash, pending
     FROM transactions
     WHERE LOWER(merchant) LIKE ? AND amount < 0 AND ABS(ABS(amount) - ?) < 0.01 AND excluded = 0`
  );
  const hasChildren = db.prepare(
    "SELECT 1 FROM transactions WHERE hash LIKE ? LIMIT 1"
  );
  const excludeParent = db.prepare(
    "UPDATE transactions SET excluded = 1 WHERE id = ?"
  );
  const insertChild = db.prepare(
    `INSERT OR IGNORE INTO transactions
       (date, merchant, rawMerchant, amount, categoryId, account, pending, excluded, source, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  // Parents whose parts no longer add up to them: a pending charge that
  // posted in place at another amount.
  const stale = db.prepare(
    `SELECT p.id, p.hash FROM transactions p
     JOIN transactions c ON c.hash LIKE p.hash || ':s%'
     WHERE p.hash NOT LIKE '%:s%'
     GROUP BY p.id HAVING ABS(SUM(c.amount) - p.amount) >= 0.01`
  );
  const dropParts = db.prepare("DELETE FROM transactions WHERE hash LIKE ?");
  const restoreParent = db.prepare("UPDATE transactions SET excluded = 0 WHERE id = ?");
  // Parts are pending exactly while their parent is (one that posted in place).
  const syncPending = db.prepare(
    `UPDATE transactions AS c SET pending = p.pending
     FROM transactions p
     WHERE c.hash LIKE p.hash || ':s%' AND p.hash NOT LIKE '%:s%' AND c.pending != p.pending`
  );

  let split = 0;
  const tx = db.transaction(() => {
    for (const p of stale.all() as { id: number; hash: string }[]) {
      dropParts.run(`${p.hash}:s%`);
      restoreParent.run(p.id);
    }
    syncPending.run();
    for (const rule of rules) {
      const parts = JSON.parse(rule.parts) as SplitPart[];
      const matches = findMatches.all(
        `%${rule.pattern}%`,
        rule.amount
      ) as {
        id: number;
        date: string;
        merchant: string;
        amount: number;
        account: string;
        source: string;
        hash: string;
        pending: number;
      }[];
      for (const t of matches) {
        if (hasChildren.get(`${t.hash}:%`)) continue; // already split
        excludeParent.run(t.id);
        parts.forEach((p, i) => {
          const childMerchant = `${t.merchant} — ${p.label}`;
          insertChild.run(
            t.date,
            childMerchant,
            childMerchant,
            -Math.abs(p.amount),
            p.categoryId,
            t.account,
            t.pending,
            t.source,
            `${t.hash}:s${i}`
          );
        });
        split++;
      }
    }
  });
  tx();
  return split;
}

// Undo a split from one of its parents: delete the rule that produced it, remove
// every child row that rule created (for every parent it matched, not just this
// one — a rule that is gone must not leave half its work behind), and restore
// each parent to counting. Returns how many parents were restored; 0 means
// there was no split to undo.
export function undoSplit(parentId: number): number {
  const db = getDb();
  const parent = db
    .prepare("SELECT merchant, amount FROM transactions WHERE id = ?")
    .get(parentId) as { merchant: string; amount: number } | undefined;
  if (!parent) return 0;
  const rule = (
    db
      .prepare("SELECT id, pattern, amount FROM split_rules WHERE ABS(amount - ?) < 0.01")
      .all(Math.abs(parent.amount)) as { id: number; pattern: string; amount: number }[]
  ).find((r) => parent.merchant.toLowerCase().includes(r.pattern));
  if (!rule) return 0;
  return undoRule(rule);
}

// Remove a rule by id (the vendor shelf's control). null: no such rule. A rule
// that never applied — one recorded for a new price that hasn't charged yet —
// restores nothing and is still removed.
export function removeSplitRule(id: number): number | null {
  const rule = getDb().prepare("SELECT id, pattern, amount FROM split_rules WHERE id = ?").get(id) as
    | { id: number; pattern: string; amount: number }
    | undefined;
  return rule ? undoRule(rule) : null;
}

function undoRule(rule: { id: number; pattern: string; amount: number }): number {
  const db = getDb();
  const parents = db
    .prepare(
      `SELECT id, hash FROM transactions
       WHERE LOWER(merchant) LIKE ? AND ABS(ABS(amount) - ?) < 0.01
         AND excluded = 1 AND hash NOT LIKE '%:s%'`
    )
    .all(`%${rule.pattern}%`, rule.amount) as { id: number; hash: string }[];
  const deleteChildren = db.prepare("DELETE FROM transactions WHERE hash LIKE ?");
  const restoreParent = db.prepare("UPDATE transactions SET excluded = 0 WHERE id = ?");

  return db.transaction(() => {
    let restored = 0;
    for (const p of parents) {
      // A parent excluded by hand (not by this rule) has no children — leave it.
      if (deleteChildren.run(`${p.hash}:s%`).changes === 0) continue;
      restoreParent.run(p.id);
      restored++;
    }
    db.prepare("DELETE FROM split_rules WHERE id = ?").run(rule.id);
    return restored;
  })();
}
