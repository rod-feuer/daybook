import { getChargeMoves, vendorName } from "./chargeVendors";
import type Database from "better-sqlite3";
import { getDb, ensureRecurringTxExclusions, ensureRecurringTxInclusions, ensurePlanMatches as ensureTables } from "./db";
import { nameAffinity } from "./similarity";
import { merchantKey } from "./merchant";
import { canonicalMerchant, getMerchantLinks } from "./queries";

// Cross-vendor plan matching. A bill's charges can arrive under another of
// the household's vendors: the bank renamed the descriptor and Plaid cleaned
// it to a brand the household already uses ("G1AI101M G.CO/HELPPAY#" came as
// "Google", the Workspace vendor, though it is Google One's $19.99). The
// detector groups by vendor, so such a charge sits in no plan, or prompts a
// Combine that would merge two real vendors.
//
// This scores each unplanned charge against every other vendor's confirmed
// monthly plan, record-linkage style: no single field decides. The name must
// link (the bank's own text counts too), then the amount, the day of the
// month and the card choose the plan. Two cut-offs:
//   auto    the names agree, the amount is to the cent, the day within one,
//           the same card, and the plan has no other charge that cycle: the
//           charge joins the plan (shown as auto; "Not in plan" undoes it).
//   suggest a looser match, offered for one tap in the review queue.
// Below both, nothing. Calibrated on the owner's history (2026-10-05): name
// alone at 0.8 let Culver's in as "Summers Of Franklin", and amount and day
// alone matched a McDonald's to three newsletters.
//
// A charge marked "Not in plan" is only ever suggested, never joined.
// Only established vendors (3+ charges) take part: a new vendor with a charge
// or two is the merge queue's Combine question, and one charge shouldn't get
// two answers.

export const AUTO_NAME = 0.95;
export const SUGGEST_NAME = 0.8;
const WINDOW_DAYS = 120; // only recent charges are matched; history stays as it was

// On the live connection too (a server started before this table existed).
export function ensurePlanMatches(db: Database.Database) {
  ensureRecurringTxExclusions(db);
  ensureRecurringTxInclusions(db);
  ensureTables(db);
}

// The automatic matches, for the detector: hash → plan key. A charge the owner
// pinned or took out is theirs, and wins over these.
export function getPlanMatches(): Map<string, string> {
  const db = getDb();
  ensurePlanMatches(db);
  const rows = db.prepare("SELECT hash, plan FROM plan_matches").all() as { hash: string; plan: string }[];
  return new Map(rows.map((r) => [r.hash, r.plan]));
}

export type PlanMatch = {
  id: number;
  hash: string;
  date: string;
  merchant: string;
  amount: number;
  plan: string; // the plan's key
  vendor: string; // the plan's vendor, for the wording
  planAmount: number;
  day: number;
  score: number; // the name's agreement, 0..1
  band: "auto" | "suggest";
};

type Plan = { id: number; key: string; vendor: string; amount: number; day: number; names: string[]; accounts: Set<string>; dates: string[] };

const dom = (iso: string) => Number(iso.slice(8, 10));
// Days apart on a month's clock: the 30th and the 1st are two apart.
const dayGap = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, 31 - d);
};
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000;

function plans(db: Database.Database): Plan[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.merchant AS key, p.vendor, r.avgAmount AS amount, p.day
       FROM recurrings r JOIN plans p ON p.key = r.merchant
       WHERE r.cadence = 'monthly' AND r.avgAmount < 0 AND p.day IS NOT NULL`
    )
    .all() as { id: number; key: string; vendor: string; amount: number; day: number }[];
  const members = db.prepare("SELECT merchant, account, COALESCE(effectiveDate, date) AS date FROM transactions WHERE recurringId = ?");
  const links = getMerchantLinks();
  return rows.map((r) => {
    const charges = members.all(r.id) as { merchant: string; account: string; date: string }[];
    // Every name the plan is known by: its vendor, its charges' names, and the names combined into it.
    const aliases = Object.keys(links).filter((a) => canonicalMerchant(a, links) === r.vendor);
    return {
      ...r,
      names: [...new Set([r.vendor, ...charges.map((c) => c.merchant), ...aliases])],
      accounts: new Set(charges.map((c) => c.account)),
      dates: charges.map((c) => c.date),
    };
  });
}

// Score the recent unplanned charges. Each gets its single best plan, if any
// clears a cut-off; two plans tied at the top is no match, only a suggestion.
export function scorePlanMatches(today = new Date().toISOString().slice(0, 10)): PlanMatch[] {
  const db = getDb();
  ensurePlanMatches(db);
  const since = new Date(Date.parse(today + "T00:00:00Z") - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const charges = db
    .prepare(
      `SELECT t.id, t.hash, COALESCE(t.effectiveDate, t.date) AS date, t.merchant, t.descriptor, t.amount, t.account, t.recurringId,
              (t.hash IN (SELECT hash FROM recurring_tx_exclusions)) AS markedOut
       FROM transactions t
       WHERE t.amount < 0 AND t.excluded = 0 AND t.pending = 0
         AND t.hash NOT LIKE '%:s%' AND COALESCE(t.effectiveDate, t.date) >= ?
         AND t.hash NOT IN (SELECT hash FROM recurring_tx_inclusions)
         AND t.hash NOT IN (SELECT hash FROM plan_match_dismissals)`
    )
    .all(since) as { id: number; hash: string; date: string; merchant: string; descriptor: string | null; amount: number; account: string; recurringId: number | null; markedOut: number }[];
  if (!charges.length) return [];
  // A charge the detector filed in its own vendor's plan at an amount far
  // from that plan's usual one ($19.99 among Workspace's $8.40s) may belong to
  // a sibling's bill; one at the plan's own price is the plan's.
  const amounts = new Map<number, number[]>();
  for (const r of db.prepare("SELECT recurringId AS id, amount FROM transactions WHERE recurringId IS NOT NULL ORDER BY recurringId, amount").all() as { id: number; amount: number }[]) {
    const list = amounts.get(r.id);
    if (list) list.push(r.amount);
    else amounts.set(r.id, [r.amount]);
  }
  const median = (id: number) => {
    const a = amounts.get(id) ?? [0];
    return a[Math.floor(a.length / 2)];
  };
  const misfiled = (c: { recurringId: number | null; amount: number }) =>
    c.recurringId == null || Math.abs(c.amount - median(c.recurringId)) > Math.abs(median(c.recurringId)) * 0.25;
  const links = getMerchantLinks();
  const moves = getChargeMoves();
  const size = new Map(
    (db.prepare("SELECT merchant, COUNT(*) AS n FROM transactions GROUP BY merchant").all() as { merchant: string; n: number }[]).map((r) => [r.merchant, r.n])
  );
  const all = plans(db);
  const out: PlanMatch[] = [];
  for (const c of charges) {
    if (!misfiled(c)) continue; // in a plan, at its price
    if ((size.get(c.merchant) ?? 0) < 3) continue; // the merge queue's question
    const own = merchantKey(canonicalMerchant(vendorName(c, moves), links));
    const fits: (PlanMatch & { sameCard: boolean; exact: boolean; gap: number })[] = [];
    for (const p of all) {
      if (merchantKey(p.vendor) === own) continue; // its own vendor's plans are the detector's
      const off = Math.abs(c.amount - p.amount);
      if (off > Math.abs(p.amount) * 0.01 + 0.005) continue;
      const gap = dayGap(dom(c.date), p.day);
      if (gap > 3) continue;
      const score = Math.max(...p.names.map((n) => Math.max(nameAffinity(c.merchant, n), c.descriptor ? nameAffinity(c.descriptor, n) : 0)));
      if (score < SUGGEST_NAME) continue;
      const exact = off <= 0.01;
      const sameCard = p.accounts.has(c.account);
      if (!((exact && sameCard) || score >= AUTO_NAME)) continue;
      // The plan already charged this cycle: a second charge isn't its bill.
      const cycleTaken = p.dates.some((d) => daysBetween(d, c.date) <= 10);
      // A charge the owner marked "Not in plan" is never joined on their behalf
      // (the mark doesn't say which plan it meant); it can still be suggested.
      const auto = score >= AUTO_NAME && exact && gap <= 1 && sameCard && !cycleTaken && !c.markedOut;
      fits.push({
        id: c.id, hash: c.hash, date: c.date, merchant: c.merchant, amount: c.amount,
        plan: p.key, vendor: p.vendor, planAmount: p.amount, day: p.day,
        score: Number(score.toFixed(2)), band: auto ? "auto" : "suggest", sameCard, exact, gap,
      });
    }
    if (!fits.length) continue;
    fits.sort((a, b) => b.score - a.score || Number(b.exact) - Number(a.exact) || a.gap - b.gap);
    const best = fits[0];
    // Two plans fit as well as each other: not certain enough to act alone.
    const tied = fits.length > 1 && fits[1].score === best.score && fits[1].exact === best.exact && fits[1].gap === best.gap;
    out.push({
      id: best.id, hash: best.hash, date: best.date, merchant: best.merchant, amount: best.amount,
      plan: best.plan, vendor: best.vendor, planAmount: best.planAmount, day: best.day, score: best.score,
      band: tied ? "suggest" : best.band,
    });
  }
  return out;
}

// Record the automatic matches (the caller re-runs the detector when any are
// new). Returns how many were added.
export function applyPlanMatches(today?: string): number {
  const db = getDb();
  ensurePlanMatches(db);
  const add = db.prepare("INSERT OR IGNORE INTO plan_matches (hash, plan, score) VALUES (?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const m of scorePlanMatches(today)) if (m.band === "auto") n += add.run(m.hash, m.plan, m.score).changes;
  })();
  return n;
}

// The middle band, for the review queue.
export function planMatchSuggestions(today?: string): PlanMatch[] {
  return scorePlanMatches(today).filter((m) => m.band === "suggest");
}

export function dismissPlanMatch(hash: string) {
  const db = getDb();
  ensurePlanMatches(db);
  db.prepare("INSERT OR IGNORE INTO plan_match_dismissals (hash) VALUES (?)").run(hash);
}
