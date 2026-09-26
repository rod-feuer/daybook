import { variableStillToCome, LARGE_CHARGE, EXTRAORDINARY, HISTORY_MONTHS } from "./forecast";
import { seriesKey, seriesVendor, isSeriesKey, dayLabel, amountLabel } from "./series";
import { merchantKey } from "./merchant";
import crypto from "node:crypto";
import { getDb } from "./db";
import {
  upcomingRecurringExpenses,
  getBudgets,
  recurringMonthlyByCategory,
  getRecurringOverrides,
  getRecurringTxExclusions,
  getRecurringTxInclusions,
  getMerchantLinks,
  canonicalMerchant,
  linkedAliases,
  getRecurringSettings,
  setRecurringSetting,
} from "./queries";
import type { Recurring } from "./types";
import { CADENCE_DAYS, medianGap } from "./cadence";

// ---- Dedupe key -----------------------------------------------------------
// A transaction is uniquely identified by date + merchant + amount + account.
// Re-importing the same CSV is therefore idempotent.
export function txHash(
  date: string,
  merchant: string,
  amount: number,
  account: string
): string {
  return crypto
    .createHash("sha1")
    .update(`${date}|${merchant.trim().toLowerCase()}|${amount.toFixed(2)}|${account}`)
    .digest("hex");
}

// ---- Rule-based categorization -------------------------------------------
// Deterministic: a merchant matches a rule if the rule's pattern is a substring
// of the (lowercased) merchant name. This handles every *known* merchant for
// free. Only genuinely-unseen merchants fall through to the model. (Rule 5)
// When several rules match, the user's beat the model's, and of the user's the
// most specific (longest) wins. In table order, the model's early guess
// "benjamin franklin" → Gifts outranked the user's later "benjamin franklin
// pl" → Carmel Home, and every new plumbing charge was filed as a gift.
// Model rules keep their order among themselves: two guesses have no ranking.
export function categorizeByRules(merchant: string): number | null {
  const db = getDb();
  const m = merchant.toLowerCase();
  const rules = db
    .prepare(
      `SELECT pattern, categoryId FROM rules
       ORDER BY (origin = 'user') DESC, CASE WHEN origin = 'user' THEN length(pattern) ELSE 0 END DESC, id`
    )
    .all() as { pattern: string; categoryId: number }[];
  for (const r of rules) {
    if (m.includes(r.pattern)) return r.categoryId;
  }
  return null;
}

// Categorize from the user's own history: if this vendor (canonical, across all
// linked descriptors) has been filed under one dominant category before, reuse
// it. Deterministic and free — honors past choices without a model call, and
// catches repeat non-recurring vendors that posted under a new descriptor (e.g.
// Calico Corners → Home Decor). Requires ≥2 prior categorized charges and a
// clear majority (≥60%) so a split or one-off doesn't guess.
export function categorizeByHistory(merchant: string): number | null {
  const db = getDb();
  const aliases = linkedAliases(canonicalMerchant(merchant, getMerchantLinks()), getMerchantLinks());
  const ph = aliases.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT categoryId FROM transactions
       WHERE merchant IN (${ph}) AND categoryId IS NOT NULL AND excluded = 0`
    )
    .all(...aliases) as { categoryId: number }[];
  if (rows.length < 2) return null;
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [c, n] of counts)
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  return bestN / rows.length >= 0.6 ? best : null;
}

export function learnRule(pattern: string, categoryId: number, origin: string) {
  const db = getDb();
  const p = pattern.trim().toLowerCase();
  const exists = db
    .prepare("SELECT id FROM rules WHERE pattern = ?")
    .get(p) as { id: number } | undefined;
  if (exists) {
    db.prepare("UPDATE rules SET categoryId = ?, origin = ? WHERE id = ?").run(
      categoryId,
      origin,
      exists.id
    );
  } else {
    db.prepare(
      "INSERT INTO rules (pattern, categoryId, origin) VALUES (?, ?, ?)"
    ).run(p, categoryId, origin);
  }
}

// ---- Recurring detection --------------------------------------------------
// Pure pattern detection, no model. A merchant is "recurring" if it has >= 3
// charges of similar amount spaced at a regular cadence. (Rule 5: deterministic)
const DAY = 86_400_000;

// Fraction of gaps that sit near an integer multiple of the cadence period. This
// is the timing-regularity test: a missing month (gap ≈ 2×, 3× period) still
// counts as on-grid, so it keeps real bills with skipped periods (e.g. the
// mortgage), but erratic spend whose median merely lands in a cadence window
// (restaurants, coffee) scores low and is rejected.
// The grid's tolerance is a third of the period — except every-two-months,
// which keeps the monthly tolerance (~10 days): a two-month plan lands as
// tightly as a monthly one, and a third of 61 days (three weeks) let random
// restaurant and grocery visits at roughly two-month spacing read as plans.
function gridTolerance(period: number): number {
  return period === CADENCE_DAYS.bimonthly ? 0.35 * CADENCE_DAYS.monthly : 0.35 * period;
}
// A skip is one or two missed periods (k ≤ 3). Past that, the ±⅓-period
// window covers most of any long gap: 69% of gaps between 60 and 200 days
// land "on" the monthly grid by chance, and a restaurant visited every few
// months (Pies & Pints: gaps of 90, 119, 189 days) read as a monthly bill.
function onGridFraction(gaps: number[], period: number): number {
  if (!gaps.length) return 0;
  const on = gaps.filter((g) => {
    const k = Math.max(1, Math.round(g / period));
    if (k > 3) return false;
    return Math.abs(g - k * period) <= gridTolerance(period);
  }).length;
  return on / gaps.length;
}

// A plan whose rhythm changed (Liquid IV: monthly for two years, then every
// two months) has a median gap in no cadence's window. It is two plans back
// to back: the current era — the last three gaps or more, each within ten
// days of one period, monthly or longer — and before it a history that read
// as a plan by the ordinary rules. Then the plan is the current rhythm and
// the history is its history; each half is regular on its own grid, so the
// whole is not measured against one. A vendor with no rhythm has neither half.
function rhythmChange(gaps: number[]): Recurring["cadence"] | null {
  const recent = recentCadence(gaps);
  if (!recent || recent === "weekly" || recent === "biweekly") return null;
  const period = CADENCE_DAYS[recent];
  let n = 0;
  while (n < gaps.length && Math.abs(gaps[gaps.length - 1 - n] - period) <= 0.35 * CADENCE_DAYS.monthly) n++;
  if (n < 3) return null;
  const before = gaps.slice(0, gaps.length - n);
  if (before.length < 2) return null;
  const was = classifyCadence(medianGap(before));
  return was && onGridFraction(before, CADENCE_DAYS[was]) >= 0.6 ? recent : null;
}

export function classifyCadence(avgGapDays: number): Recurring["cadence"] | null {
  if (Math.abs(avgGapDays - 7) <= 2) return "weekly";
  if (Math.abs(avgGapDays - 14) <= 3) return "biweekly";
  if (avgGapDays >= 26 && avgGapDays <= 35) return "monthly";
  // Every two months sits between monthly and quarterly; without it a plan
  // that moved to a two-month rhythm (Liquid IV, late 2025) read as nothing.
  if (avgGapDays >= 52 && avgGapDays <= 70) return "bimonthly";
  if (avgGapDays >= 80 && avgGapDays <= 100) return "quarterly";
  if (avgGapDays >= 165 && avgGapDays <= 200) return "semiannual";
  if (avgGapDays >= 330 && avgGapDays <= 400) return "yearly";
  return null;
}

// Cadence from the most recent gaps (the vendor's current rhythm), so one that
// switched plans — e.g. monthly → annual — is classified by what it does now,
// not a median dragged down by old history. Used for user-forced recurrings,
// which should honor current behavior (the auto pass still needs all-gap
// regularity via onGridFraction, so it stays median-based there).
function recentCadence(gaps: number[]): Recurring["cadence"] | null {
  if (!gaps.length) return null;
  return classifyCadence(medianGap(gaps.slice(-3)));
}

// The current charge, not the average. A settled price (the last two charges
// agree within 10%) uses the most recent; a genuinely variable bill uses the
// median, a steadier typical than the latest swing. Mirrors the suggestion logic
// so a recurring's amount matches what was suggested, and a price change (intro
// rate that later rose) no longer skews it. Amounts are signed (expenses < 0).
function currentAmount(amounts: number[]): number {
  const n = amounts.length;
  const last = amounts[n - 1];
  const prev = n >= 2 ? amounts[n - 2] : last;
  const stable = Math.abs(last - prev) <= 0.1 * Math.max(Math.abs(last), Math.abs(prev));
  if (n < 3 || stable) return last;
  const s = [...amounts].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function addCadence(date: string, cadence: Recurring["cadence"]): string {
  const d = new Date(date + "T00:00:00Z");
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "biweekly") d.setUTCDate(d.getUTCDate() + 14);
  else if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "bimonthly") d.setUTCMonth(d.getUTCMonth() + 2);
  else if (cadence === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (cadence === "semiannual") d.setUTCMonth(d.getUTCMonth() + 6);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// The most common category among a recurring's charges — robust to a single new
// uncategorized member (unlike "use the latest charge's category", which a fresh
// descriptor with no rule match would null out). Ties broken by first seen.
function modalCategory(txs: { categoryId: number | null }[]): number | null {
  const counts = new Map<number, number>();
  for (const t of txs)
    if (t.categoryId != null) counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [cat, n] of counts)
    if (n > bestN) {
      bestN = n;
      best = cat;
    }
  return best;
}

// Two bills behind one descriptor. Netflix charges on the 23rd and the 26th
// (one account per home); Benjamin Franklin on the 8th and the 22nd; Sofi on
// the 1st ($4,453 mortgage) and the 21st ($1,350 loan). Grouped by descriptor
// they read as ONE bill — "biweekly Netflix", a "$2,902 Sofi" that is neither
// payment. Timing alone can't separate the plumbing pair from a true biweekly
// plan, except for one thing: two monthly plans keep their days of the month,
// while a biweekly drifts through the calendar (14-day steps against 30/31-day
// months). So: cluster charges by day of the month (a cluster spans ≤2 days,
// so a weekend slip stays together and 23 vs 26 stays apart; days 28–31 are
// one "end of month"); charges in the same month of one cluster are ONE event
// (two policies both billed on the 1st sum to one bill) — unless they are
// debits of consistently different amounts, which are different bills (two
// 529 contributions of $200 and $300 on the 18th); a cluster is a bill when it
// has ≥3 events that recur monthly. Split only when ≥2 such clusters
// overlap in time (a bill whose day moved is still one bill) and together hold
// most of the vendor's charges (a weekly grocery run is not four bills).
// Charges that fit no cluster are left unlinked, so a second plan with one or
// two charges so far joins automatically once it reaches three.
//
// The same clusters also rescue a monthly plan that a few strays would break:
// Benjamin Franklin on the 8th, plus a one-off service call on the 21st and
// the first charge of a second plan on the 22nd, read as "biweekly" by gap
// math. When one cluster holds most of the vendor's charges and the whole
// descriptor doesn't classify as monthly, that cluster IS the bill.
const MONTH_DAYS = 30.44;
// `held`: charges on the part's billing day that the day explains but the
// plan does not own (see the guard in amountGroups). They count toward how
// much of the vendor the day-parts cover, and stay unlinked.
type DayPart<T> = { day: number; amount: number | null; label?: string; txs: T[]; held: T[]; events: { date: string; amount: number }[] };
function monthlyDayParts<T extends { date: string; amount: number }>(txs: T[]): DayPart<T>[] {
  if (txs.length < 4) return [];
  const dayOf = (t: T) => Number(t.date.slice(8, 10));
  const bucket = (t: T) => Math.min(dayOf(t), 28); // 28th–31st = end of month
  const sorted = [...txs].sort((a, b) => bucket(a) - bucket(b) || a.date.localeCompare(b.date));
  const clusters: T[][] = [];
  for (const t of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && bucket(t) - bucket(cur[0]) <= 2) cur.push(t);
    else clusters.push([t]);
  }
  // A weekend slip can land past a cluster's two-day span (a bill on the
  // 18th posting on the 20th, when the cluster began on the 16th). A SMALL
  // leftover cluster within two days of a big cluster's typical day joins it.
  // Only small ones: two established clusters three days apart (Netflix on
  // the 23rd and the 26th) stay apart.
  const typicalDay = (c: T[]) => {
    const n = new Map<number, number>();
    for (const t of c) n.set(bucket(t), (n.get(bucket(t)) ?? 0) + 1);
    return [...n.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
  };
  for (let i = clusters.length - 1; i >= 0; i--) {
    const c = clusters[i];
    if (c.length >= 3) continue;
    const home = clusters.find((o, j) => j !== i && o.length >= 3 && Math.abs(typicalDay(o) - bucket(c[0])) <= 2);
    if (home) {
      home.push(...c);
      clusters.splice(i, 1);
    }
  }
  // Same-day charges of consistently different amounts are different bills:
  // group a cluster's charges by amount (within 10%); when ≥2 groups CO-OCCUR
  // — each shares ≥3 months with the largest — each is its own part. A price
  // change is not a second bill: its eras never share a month, and each era
  // folds into the concurrent group nearest in amount. Deposits split the
  // same way: two paychecks on one payday are two paychecks. A cluster that
  // mixes debits and credits is left whole.
  const amountGroups = (c: T[]): { amount: number | null; label?: string; txs: T[]; held: T[] }[] => {
    if (c.some((t) => t.amount > 0) && c.some((t) => t.amount < 0)) return [{ amount: null, txs: c, held: [] }];
    // A day that consistently carries k charges (two paychecks every payday)
    // is k bills even when amount bands can't cut it cleanly — two people's
    // raises cross in amount. Then the bills are ranked by size on each day:
    // the larger deposit is one paycheck, the smaller the other, whatever the
    // amounts do over time.
    const perMonth = new Map<string, T[]>();
    for (const t of c) (perMonth.get(t.date.slice(0, 7)) ?? perMonth.set(t.date.slice(0, 7), []).get(t.date.slice(0, 7))!).push(t);
    const counts = [...perMonth.values()].map((g) => g.length);
    const modalK = [...new Set(counts)].sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length)[0] ?? 1;
    const byRank = (): { amount: number | null; label?: string; txs: T[]; held: T[] }[] | null => {
      if (modalK < 2 || counts.filter((x) => x === modalK).length < 0.8 * counts.length) return null;
      const ranks: T[][] = Array.from({ length: modalK }, () => []);
      for (const g of perMonth.values()) {
        if (g.length !== modalK) continue; // an odd month (a bonus) stays out of the ranks
        [...g].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).forEach((t, i) => ranks[i].push(t));
      }
      const labels = modalK === 2 ? ["larger", "smaller"] : ranks.map((_, i) => `${i + 1}${["st", "nd", "rd"][i] ?? "th"}`);
      return ranks.map((g, i) => {
        const byDate = [...g].sort((a, b) => a.date.localeCompare(b.date));
        return { amount: Number(currentAmount(byDate.map((t) => t.amount)).toFixed(2)), label: labels[i], txs: byDate, held: [] };
      });
    };
    let groups: T[][] = [];
    for (const t of [...c].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount))) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(Math.abs(t.amount) - Math.abs(g[0].amount)) <= 0.1 * Math.abs(g[0].amount)) g.push(t);
      else groups.push([t]);
    }
    const monthsOf = (g: T[]) => new Set(g.map((t) => t.date.slice(0, 7)));
    const median = (g: T[]) => Math.abs(g[g.length >> 1].amount);
    const main = groups.reduce((a, b) => (b.length > a.length ? b : a));
    // The billing day alone does not make a charge the bill. On a fixed-price
    // plan (one amount band holds most of the day's charges) a lone charge
    // more than half off that price is a stray that happened to post on the
    // day — a $16.85 fee on tuition day, which then read as "the price
    // changed $16.85 → $353". A new price is a price once the vendor has
    // charged it twice, anywhere in its history (the new season's $353
    // posted on the 14th, then on the 4th); until then the charge is held:
    // explained by the day, owned by no plan. A variable bill (a utility,
    // whose months rarely repeat) has no majority band and keeps every charge.
    const held: T[] = [];
    if (main.length >= 0.6 * c.length) {
      const price = median(main);
      const repeated = (t: T) =>
        txs.some((o) => o !== t && Math.abs(Math.abs(o.amount) - Math.abs(t.amount)) <= 0.1 * Math.abs(t.amount));
      groups = groups.filter((g) => {
        const stray = g.length === 1 && Math.abs(Math.abs(g[0].amount) - price) > 0.5 * price && !repeated(g[0]);
        if (stray) held.push(g[0]);
        return !stray;
      });
    }
    const mainMonths = monthsOf(main);
    const bills = groups.filter((g) => g === main || [...monthsOf(g)].filter((m) => mainMonths.has(m)).length >= 3);
    // Rank only when the charges come in at least two real sizes: two
    // identical policies on the 1st are one bill (summed), not "larger" and
    // "smaller".
    const sizes = groups.filter((g) => monthsOf(g).size >= 3).length;
    if (sizes >= 2 && bills.length !== modalK) {
      const ranked = byRank();
      if (ranked) return ranked;
    }
    if (bills.length < 2) return [{ amount: null, txs: groups.flat(), held }];
    for (const g of groups) {
      if (bills.includes(g)) continue;
      const home = bills.reduce((a, b) => (Math.abs(median(b) - median(g)) < Math.abs(median(a) - median(g)) ? b : a));
      home.push(...g);
    }
    // The held strays ride with the largest bill, for coverage only.
    return bills.map((g) => {
      const byDate = [...g].sort((a, b) => a.date.localeCompare(b.date));
      return { amount: Number(currentAmount(byDate.map((t) => t.amount)).toFixed(2)), txs: byDate, held: g === main ? held : [] };
    });
  };
  const parts: DayPart<T>[] = [];
  for (const cluster of clusters) {
    // The cluster's typical day names every part cut from it, so two
    // paychecks on the 31st are "· 31st · $A" and "· 31st · $B", not one of
    // them "· 30th" because its own slips happened to skew.
    const n0 = new Map<number, number>();
    for (const t of cluster) n0.set(dayOf(t), (n0.get(dayOf(t)) ?? 0) + 1);
    const clusterDay = [...n0.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
    for (const { amount, label, txs: c, held } of amountGroups(cluster)) {
    const byMonth = new Map<string, { date: string; amount: number }>();
    for (const t of [...c].sort((a, b) => a.date.localeCompare(b.date))) {
      const m = t.date.slice(0, 7);
      const e = byMonth.get(m);
      if (e) {
        e.amount += t.amount;
        e.date = t.date; // the event closes on its last charge
      } else byMonth.set(m, { date: t.date, amount: t.amount });
    }
    const events = [...byMonth.values()];
    if (events.length < 3) continue;
    const gaps: number[] = [];
    for (let i = 1; i < events.length; i++)
      gaps.push((Date.parse(events[i].date) - Date.parse(events[i - 1].date)) / DAY);
    if (classifyCadence(medianGap(gaps)) !== "monthly" || onGridFraction(gaps, MONTH_DAYS) < 0.6) continue;
    parts.push({ day: clusterDay, amount, label, txs: c, held, events });
    }
  }
  return parts;
}

// Two jobs taking turns under one descriptor: Rosy's Cleaning is paid every
// two weeks, $240 then $270 then $240 — two homes, alternating. Day clustering
// can't see it (a two-week rhythm drifts through the month), but the amounts
// can: group debits by amount (within 10%); when ≥2 groups INTERLEAVE in date
// order (each swaps with the largest ≥3 times — a price change swaps once),
// each is regular on its own grid, and together they hold ≥80% of the
// charges, each group is its own bill, keyed by amount. Cadence per group is
// whatever its own gaps say (a 28-day turn reads as monthly).
function interleavedAmountParts<T extends { date: string; amount: number }>(
  txs: T[]
): { amount: number; cadence: Recurring["cadence"]; txs: T[] }[] | null {
  if (txs.length < 6 || txs.some((t) => t.amount > 0)) return null;
  const groups: T[][] = [];
  for (const t of [...txs].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount))) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(Math.abs(t.amount) - Math.abs(g[0].amount)) <= 0.1 * Math.abs(g[0].amount)) g.push(t);
    else groups.push([t]);
  }
  const big = groups.filter((g) => g.length >= 3).map((g) => [...g].sort((a, b) => a.date.localeCompare(b.date)));
  if (big.length < 2) return null;
  const main = big.reduce((a, b) => (b.length > a.length ? b : a));
  const swaps = (g: T[]) => {
    const seq = [...main.map((t) => ({ d: t.date, k: 0 })), ...g.map((t) => ({ d: t.date, k: 1 }))].sort((a, b) => a.d.localeCompare(b.d));
    let n = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i].k !== seq[i - 1].k) n++;
    return n;
  };
  const regular = (g: T[]): Recurring["cadence"] | null => {
    const gaps: number[] = [];
    for (let i = 1; i < g.length; i++) gaps.push((Date.parse(g[i].date) - Date.parse(g[i - 1].date)) / DAY);
    const cadence = classifyCadence(medianGap(gaps));
    return cadence && onGridFraction(gaps, CADENCE_DAYS[cadence]) >= 0.6 ? cadence : null;
  };
  const parts: { amount: number; cadence: Recurring["cadence"]; txs: T[] }[] = [];
  for (const g of big) {
    if (g !== main && swaps(g) < 3) continue;
    const cadence = regular(g);
    if (!cadence) continue;
    parts.push({ amount: Number(currentAmount(g.map((t) => t.amount)).toFixed(2)), cadence, txs: g });
  }
  if (parts.length < 2 || !parts.some((p) => p.txs === main)) return null;
  const covered = parts.reduce((n, p) => n + p.txs.length, 0);
  return covered >= 0.8 * txs.length ? parts : null;
}

// A fixed bill with usage on top: Anthropic is a $20 subscription every month
// plus $15-ish API top-ups on random days. Grouped by descriptor the top-ups
// join the series (the count, the per-charge, "paid"). When ONE amount group
// is regular on its own grid and is the largest, and the remaining charges
// are NOT themselves regular (random days — usage, not another bill), the
// bill is the regular group and the rest stays unlinked. A variable bill
// whose other months sit on the same grid (a utility) is left whole: its
// remainder is regular.
function regularCore<T extends { date: string; amount: number }>(
  txs: T[]
): { cadence: Recurring["cadence"]; txs: T[] } | null {
  // Debits only: usage on top of a plan is spending. A credit split across
  // postings (an Amex $25 credit posted as $21 + $4) is one credit, not a
  // core plus usage.
  if (txs.length < 6 || txs.some((t) => t.amount > 0)) return null;
  const groups: T[][] = [];
  for (const t of [...txs].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount))) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(Math.abs(t.amount) - Math.abs(g[0].amount)) <= 0.05 * Math.abs(g[0].amount)) g.push(t); // a plan's price is exact
    else groups.push([t]);
  }
  const byDate = (g: T[]) => [...g].sort((a, b) => a.date.localeCompare(b.date));
  const gapsOf = (g: T[]) => {
    const d = byDate(g);
    const gaps: number[] = [];
    for (let i = 1; i < d.length; i++) gaps.push((Date.parse(d[i].date) - Date.parse(d[i - 1].date)) / DAY);
    return gaps;
  };
  const regular = (g: T[], minOnGrid: number): Recurring["cadence"] | null => {
    if (g.length < 3) return null;
    const gaps = gapsOf(g);
    const cadence = classifyCadence(medianGap(gaps));
    return cadence && onGridFraction(gaps, CADENCE_DAYS[cadence]) >= minOnGrid ? cadence : null;
  };
  // A bill charges every period; six similar-priced lunches over four years
  // land on the grid only by skipping it. Require consecutive periods.
  const consecutive = (g: T[], period: number) => {
    const gaps = gapsOf(g);
    return gaps.filter((gap) => Math.round(gap / period) === 1 && Math.abs(gap - period) <= 0.35 * period).length >= 0.8 * gaps.length;
  };
  // The core must be a real bill on its own — six charges or more, tight on
  // its grid, and most of the vendor — and the rest must be usage: three or
  // more charges that are not regular. Anything less is a coincidence (six
  // similar-priced lunches) or a price change (one odd charge), and the
  // whole-descriptor path handles both.
  // The core is the CURRENT plan: among groups that qualify, the one charged
  // most recently — not the largest. Anthropic's $20 plan ran through 2024
  // (ten charges) and then became a ~$100 plan; the largest group was the
  // dead one, and the series ended in 2024.
  const last = (g: T[]) => byDate(g)[g.length - 1].date;
  const first = (g: T[]) => byDate(g)[0].date;
  const monthsOf = (g: T[]) => new Set(g.map((t) => t.date.slice(0, 7))).size;
  // A plan must own most of the MONTHS since it began — not most of the
  // charges, which usage swamps (a $100 plan beside ten $15 top-ups). A
  // two-month plan can own at most half the months, so its months count
  // double; longer cadences keep the month rule (a quarterly-looking subset
  // of a monthly bill must not become the plan).
  const ownsItsPeriods = (g: T[], period: number) =>
    monthsOf(g) * (period === CADENCE_DAYS.bimonthly ? 2 : 1) >= 0.6 * monthsOf(txs.filter((t) => t.date >= first(g)));
  // And it must still be running: a plan whose last charge is more than two
  // periods before the vendor's latest activity has ended — it is history,
  // not the vendor's bill (Anthropic's $20 plan through 2024, with 2026 usage).
  const latest = byDate(txs)[txs.length - 1].date;
  const stillRunning = (g: T[], period: number) => (Date.parse(latest) - Date.parse(last(g))) / DAY <= 2 * period;
  const candidates = groups
    .filter((g) => g.length >= 6)
    .sort((a, b) => last(b).localeCompare(last(a)));
  for (const core of candidates) {
    const cadence = regular(core, 0.8);
    // A plan with usage on top bills monthly or longer; a biweekly run of
    // similar gas fill-ups is a coincidence, not a plan.
    if (!cadence || cadence === "weekly" || cadence === "biweekly" || !consecutive(core, CADENCE_DAYS[cadence])) continue;
    if (!ownsItsPeriods(core, CADENCE_DAYS[cadence])) continue;
    if (!stillRunning(core, CADENCE_DAYS[cadence])) continue;
    const rest = txs.filter((t) => !core.includes(t));
    // What ran ALONGSIDE the plan must be usage: three or more charges that
    // are not a rival bill (a rival runs in consecutive periods; four service
    // calls over a year are not one just because 238 days is "17 periods").
    // Fewer than three is a price change or an odd charge — the ordinary
    // path handles that whole.
    const alongside = rest.filter((t) => t.date >= first(core));
    if (alongside.length < 3) return null;
    const rival = regular(alongside, 0.6);
    if (rival && consecutive(alongside, CADENCE_DAYS[rival])) return null;
    // An earlier era (the $20 plan before the $100 one) is the same bill at
    // an old price: it stays in the series as history. An era is itself a
    // regular amount group; charges before the plan began that belong to no
    // such group are usage, and leave with the rest.
    const eras = groups.filter((g) => g !== core && regular(g, 0.6));
    const history = rest.filter((t) => t.date < first(core) && eras.some((g) => g.includes(t)));
    return { cadence, txs: byDate([...core, ...history]) };
  }
  return null;
}

// "<vendor> · 23rd" when parts differ by day; "· $200" when they share a day
// and differ by amount; "· 18th · $200" when a vendor needs both.
function partKey<T>(vendor: string, p: DayPart<T>, all: DayPart<T>[]): string {
  const sameDay = all.filter((q) => q.day === p.day).length > 1;
  const oneDay = all.every((q) => q.day === p.day);
  if (!sameDay || (p.amount == null && !p.label)) return seriesKey(vendor, dayLabel(p.day));
  const what = p.label ?? amountLabel(p.amount as number); // a rank survives raises; an amount names a fixed plan
  if (oneDay) return seriesKey(vendor, what);
  return seriesKey(vendor, `${dayLabel(p.day)}${" · "}${what}`);
}

// Which monthly day-parts of a descriptor stand as separate bills. Concurrent,
// not sequential: each part shares ≥2 months with the longest one (a bill
// whose day moved shares none). And the parts must BE the vendor — ≥80% of
// its charges — or this is a store visited every week, whose trips also land
// in every day-bucket month after month. Unless the user said the vendor IS
// recurring (`forced`): then the day-parts are its subscriptions and the rest
// are purchases, which stay unlinked. Apple carried four subscriptions among
// seven one-off purchases (an iPhone among them): 65% coverage, so no split,
// and forcing it made ONE weekly plan of all twenty charges.
function concurrentParts<T extends { date: string; amount: number }>(parts: DayPart<T>[], total: number, forced = false): DayPart<T>[] | null {
  if (parts.length < 2) return null;
  const monthsOf = (p: DayPart<T>) => new Set(p.events.map((e) => e.date.slice(0, 7)));
  const anchor = monthsOf(parts.reduce((a, b) => (b.events.length > a.events.length ? b : a)));
  const overlapping = parts.filter((p) => [...monthsOf(p)].filter((m) => anchor.has(m)).length >= 2);
  if (overlapping.length < 2) return null;
  const covered = overlapping.reduce((n, p) => n + p.txs.length + p.held.length, 0);
  return forced || covered >= 0.8 * total ? overlapping : null;
}

// The rebuild clears every plan and writes them again. As separate commits, a
// reader in another process (the digest job beside the dev server) could see
// zero plans mid-rebuild, and two rebuilds could interleave into duplicates. One
// immediate transaction: readers see the old plans or the new ones, never none.
export function detectRecurrings(): Recurring[] {
  return getDb().transaction(rebuildRecurrings).immediate();
}

function rebuildRecurrings(): Recurring[] {
  const db = getDb();
  // Same calendar and same rows as every reader of the result: a charge lives in
  // its effective month (the user's overlay), and an excluded charge — a
  // transfer, a reimbursed one-off, a split parent whose parts count instead —
  // is not evidence of a bill. Excluded rows used to join series and corrupt
  // their cadence (a split parent on the same day as its child made a monthly
  // bill read biweekly).
  const rows = db
    .prepare(
      `SELECT merchant, COALESCE(effectiveDate, date) AS date, amount, categoryId, hash
       FROM transactions WHERE excluded = 0 ORDER BY merchant, date`
    )
    .all() as {
    merchant: string;
    date: string;
    amount: number;
    categoryId: number | null;
    hash: string;
  }[];

  // Group by canonical merchant, so user-linked descriptors (e.g. a gas bill
  // whose payment descriptor changed) form a single recurring.
  const links = getMerchantLinks();
  const byCanon = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = canonicalMerchant(r.merchant, links);
    const arr = byCanon.get(key) ?? [];
    arr.push(r);
    byCanon.set(key, arr);
  }
  // The SELECT is ordered by (merchant, date), but a canonical group can span
  // several descriptor strings — so it arrives ordered by descriptor, then date,
  // NOT globally by date. Re-sort each group so gap math and lastDate/nextDate
  // are correct for merged/linked vendors (e.g. a renamed gym).
  for (const arr of byCanon.values())
    arr.sort((a, b) => a.date.localeCompare(b.date));
  // Then by vendor: the same coarse key the shelf rolls a vendor up with
  // (merchantKey — the first two words once processor prefixes are stripped),
  // so a bank rename ("Cursor Ai Powered" → "Cursor, Ai Powered Isan
  // Francisco") can be read as one vendor with one history. Each vendor is
  // named by its busiest descriptor; the loop below decides per vendor whether
  // its descriptors are planned together or apart.
  const byKey = new Map<string, string[]>();
  for (const canon of byCanon.keys()) {
    const key = merchantKey(canon) || canon;
    byKey.set(key, [...(byKey.get(key) ?? []), canon]);
  }
  const byVendor = new Map<string, string[]>(); // vendor name → its descriptors
  for (const canons of byKey.values()) {
    const name = canons.reduce((a, b) => (byCanon.get(b)!.length > byCanon.get(a)!.length ? b : a));
    byVendor.set(name, canons);
  }

  // Clear child references BEFORE deleting parent rows, so this is safe whether
  // or not SQLite foreign-key enforcement is on.
  db.prepare("UPDATE transactions SET recurringId = NULL").run();
  db.prepare("DELETE FROM recurrings").run();

  // Overrides are stored under the descriptor the user clicked, but detection
  // groups by canonical merchant — so resolve each override to its canonical key.
  // Without this, a force/mute set on a linked alias (e.g. "Jimmy John's", an
  // alias of canonical "Jimmy Johns") never matches its own vendor's group and
  // silently does nothing.
  const rawOverrides = getRecurringOverrides();
  const overrides: Record<string, "force" | "mute"> = {};
  for (const [m, status] of Object.entries(rawOverrides)) {
    const canon = canonicalMerchant(m, links);
    if (overrides[canon] === "force") continue; // force wins a force/mute clash
    overrides[canon] = status;
  }
  const excluded = getRecurringTxExclusions(); // charges the user took out
  const included = getRecurringTxInclusions(); // charges the user put in: hash → plan
  const rowByHash = new Map(rows.map((r) => [r.hash, r]));
  const settings = getRecurringSettings();
  const created = new Set<string>();
  const out: Recurring[] = [];
  const insert = db.prepare(
    `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
     VALUES (@merchant, @categoryId, @avgAmount, @cadence, @lastDate, @nextDate, @count)`
  );
  // A split series owns specific charges of a shared descriptor, so it links
  // by row (hash), never by merchant string.
  const linkByHash = db.prepare("UPDATE transactions SET recurringId = ? WHERE hash = ?");
  // Backfill a recurring's category onto its still-uncategorized members (e.g. a
  // charge that posted under a new descriptor with no matching rule). Never
  // overwrites an existing category.
  const backfillCategory = db.prepare(
    "UPDATE transactions SET categoryId = ? WHERE recurringId = ? AND categoryId IS NULL"
  );

  // Amount consistency — coefficient of variation (stdev / |mean|), see the
  // comment at its use below. Shared by the whole-descriptor path and the
  // per-day split.
  const amountsConsistent = (amounts: number[]) => {
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    if (mean === 0) return false;
    const sd = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length);
    return sd / Math.abs(mean) <= 0.6;
  };

  type Tx = (typeof rows)[number];
  type Plan = {
    key: string;
    txs: Tx[];
    events: { date: string; amount: number }[];
    cadence: Recurring["cadence"];
    // Set on the established plan the first time a vendor splits: the vendor's
    // own settings (its name, an expected amount) move to that plan's key; the
    // new plan reads as the bare descriptor until it is named.
    inherit?: string;
  };
  // Plan one vendor's series without touching the database: `merchant` names
  // the series, `all` is its charges, `status` the user's override on it.
  const planVendor = (merchant: string, all: Tx[], status: "force" | "mute" | undefined): Plan[] => {
    const plans: Plan[] = [];
    if (status === "mute") return plans; // user said: not recurring
    const txs = all.filter((t) => !excluded.has(t.hash)); // drop flagged one-offs
    if (txs.length < 3) return plans;

    // Two (or more) monthly bills behind one descriptor: one series per day of
    // the month, keyed "<vendor> · <day>". A part the user marked not recurring
    // (mute on its key) or whose amounts don't hold together is skipped — its
    // charges stay unlinked. Falls through to the whole-descriptor path unless
    // at least two parts stand on their own.
    // Coverage counts every monthly day-cluster (that is what explains the
    // vendor's charges); a cluster whose amounts don't hold together is then
    // dropped from emission and its charges stay unlinked.
    const allParts = monthlyDayParts(txs);
    const steady = (p: DayPart<Tx>) => amountsConsistent(p.events.map((e) => e.amount));
    const dayParts = allParts.filter(steady);
    const emitPart = (
      key: string,
      p: { txs: Tx[]; events: { date: string; amount: number }[] },
      cadence: Recurring["cadence"] = "monthly"
    ) => plans.push({ key, txs: p.txs, events: p.events, cadence });
    const emitSplit = (parts: DayPart<Tx>[]) => {
      const main = parts.reduce((a, b) => (b.events.length > a.events.length ? b : a));
      for (const p of parts)
        plans.push({
          key: partKey(merchant, p, parts),
          txs: p.txs,
          events: p.events,
          cadence: "monthly",
          inherit: p === main ? merchant : undefined,
        });
    };
    const emitInterleaved = (parts: NonNullable<ReturnType<typeof interleavedAmountParts<Tx>>>) => {
      const main = parts.reduce((a, b) => (b.txs.length > a.txs.length ? b : a));
      for (const p of parts) {
        const key = seriesKey(merchant, amountLabel(p.amount));
        if (rawOverrides[key] === "mute") continue;
        plans.push({
          key,
          txs: p.txs,
          events: p.txs.map((t) => ({ date: t.date, amount: t.amount })),
          cadence: p.cadence,
          inherit: p === main ? merchant : undefined,
        });
      }
    };
    const concurrent = concurrentParts(allParts, txs.length, status === "force");
    const split = concurrent?.filter(
      (p) => steady(p) && rawOverrides[partKey(merchant, p, concurrent)] !== "mute"
    );
    if (split && split.length >= 2) {
      emitSplit(split);
      return plans;
    }
    // One billing day plus strays (a service call, the first charge of a
    // second plan, a pair that posted a month early): when that day's plan —
    // or its same-day plans of different amounts — holds ≥60% of the charges
    // and the whole descriptor would not read as monthly, the plan is the bill
    // and the strays stay unlinked. If the whole descriptor already reads
    // monthly, the ordinary path below keeps every charge.
    const oneDay = dayParts.length >= 1 && new Set(dayParts.map((p) => p.day)).size === 1;
    // The day must still be the vendor's day: a cluster whose last charge is
    // more than two months before the vendor's latest activity is a past era
    // (Liquid IV on the 4th, monthly, until the plan moved to every two
    // months), and rescuing it would make the dead era the plan.
    const latestDate = txs[txs.length - 1].date;
    const stillOn = (p: DayPart<Tx>) =>
      (Date.parse(latestDate) - Date.parse(p.events[p.events.length - 1].date)) / DAY <= 2 * MONTH_DAYS + 5;
    if (oneDay && dayParts.some(stillOn) && dayParts.reduce((n, p) => n + p.txs.length + p.held.length, 0) >= 0.6 * txs.length) {
      const all = txs.map((t) => Date.parse(t.date + "T00:00:00Z"));
      const allGaps = all.slice(1).map((d, i) => (d - all[i]) / DAY);
      // "Reads monthly" is the ordinary path's own two tests, both of them: a
      // monthly median AND gaps on the monthly grid. With only the median, a
      // vendor whose strays left the median at 28 days but put 6 of 14 gaps
      // off the grid (Chubb: a policy on the 17th plus a quarterly one on the
      // 4th) skipped this rescue and then failed the ordinary path — no plan
      // at all, for a bill charged every month for a year.
      const readsMonthly = classifyCadence(medianGap(allGaps)) === "monthly" && onGridFraction(allGaps, CADENCE_DAYS.monthly) >= 0.6;
      if (!readsMonthly) {
        if (dayParts.length === 1) emitPart(merchant, dayParts[0]);
        else emitSplit(dayParts.filter((p) => rawOverrides[partKey(merchant, p, dayParts)] !== "mute"));
        return plans;
      }
    }

    // Two jobs taking turns (Rosy's: $240 / $270 every other week).
    const turns = interleavedAmountParts(txs);
    if (turns) {
      emitInterleaved(turns);
      return plans;
    }
    // A fixed bill with usage on top (Anthropic: $20 monthly + top-ups).
    const core = regularCore(txs);
    if (core) {
      emitPart(merchant, { txs: core.txs, events: core.txs.map((t) => ({ date: t.date, amount: t.amount })) }, core.cadence);
      return plans;
    }

    // Amounts must be roughly consistent — measured by coefficient of variation
    // (stdev / |mean|), not "every charge within 15% of the mean". The strict
    // rule rejected real recurrings: subscriptions that raised prices over the
    // years (a few old cheap charges fall >15% below the multi-year mean) and
    // usage-based bills (utilities). CV is robust to a few outliers yet still
    // rejects wildly-variable spend (e.g. a plumber, CV ~2.4).
    const amounts = txs.map((t) => t.amount);
    if (!amountsConsistent(amounts)) return plans;

    // Gaps between consecutive dates must be regular.
    const dates = txs.map((t) => new Date(t.date + "T00:00:00Z").getTime());
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / DAY);
    let cadence = classifyCadence(medianGap(gaps));
    // Timing must be regular, not just a median that happens to land in range.
    if (cadence && onGridFraction(gaps, CADENCE_DAYS[cadence]) < 0.6) cadence = null;
    // Or the vendor is a plan that changed rhythm, regular in each era.
    if (!cadence) cadence = rhythmChange(gaps);
    if (!cadence) return plans;

    emitPart(merchant, { txs, events: txs.map((t) => ({ date: t.date, amount: t.amount })) }, cadence);
    return plans;
  };

  const commit = (p: Plan) => {
    if (p.inherit && settings[p.inherit] && !settings[p.key]) setRecurringSetting(p.key, settings[p.inherit]);
    // A charge the user put into this plan joins it as its own event, wherever
    // the detector's rules left it (a stray, a held fee, an off-day payment).
    for (const [hash, plan] of included) {
      const r = rowByHash.get(hash);
      if (plan !== p.key || !r || p.txs.includes(r)) continue;
      p.txs.push(r);
      p.events.push({ date: r.date, amount: r.amount });
    }
    p.events.sort((a, b) => a.date.localeCompare(b.date));
    const lastDate = p.events[p.events.length - 1].date;
    const categoryId = modalCategory(p.txs);
    const rec = {
      merchant: p.key,
      categoryId,
      avgAmount: Number(currentAmount(p.events.map((e) => e.amount)).toFixed(2)),
      cadence: p.cadence,
      lastDate,
      nextDate: addCadence(lastDate, p.cadence),
      count: p.events.length,
    };
    const info = insert.run(rec);
    for (const t of p.txs) linkByHash.run(info.lastInsertRowid, t.hash);
    if (categoryId != null) backfillCategory.run(categoryId, info.lastInsertRowid);
    out.push({ id: Number(info.lastInsertRowid), ...rec });
  };
  const linked = (plans: Plan[]) => plans.reduce((n, p) => n + p.txs.length, 0);

  // Plans the user confirmed (durable plans). Each keeps the key it had and
  // takes its charges before the detector sees the vendor: a pinned charge,
  // then any charge at its amount (1%, or 50 cents) near its billing day (the
  // timing test's slack: 10 days for monthly and longer, a third of the
  // period for weekly and every two weeks). The day window keeps one
  // confirmed house from taking the other's charges at the same price (Ben
  // Franklin's $11.99 on the 8th and the 25th); between two confirmed plans
  // at one amount the nearest day decides, and a plan without a charge yet
  // that month is preferred, so a late posting doesn't land in the plan
  // already paid. Only the charges left over are planned by the rules below.
  // A cadence the user set on the plan is its rhythm for the day window too.
  const confirmed = (
    db
      .prepare("SELECT key, vendor, amount, cadence, anchorDate FROM plans")
      .all() as { key: string; vendor: string; amount: number; cadence: Recurring["cadence"]; anchorDate: string }[]
  ).map((p) => ({ ...p, cadence: (settings[p.key]?.cadence as Recurring["cadence"] | null | undefined) ?? p.cadence }));
  const members = new Map(
    (db.prepare("SELECT hash, key FROM plan_charges").all() as { hash: string; key: string }[]).map((m) => [m.hash, m.key])
  );
  const keepCharge = db.prepare("INSERT OR IGNORE INTO plan_charges (hash, key) VALUES (?, ?)");
  const confirmedByCanon = new Map<string, typeof confirmed>();
  for (const p of confirmed) {
    const canon = canonicalMerchant(p.vendor, links);
    confirmedByCanon.set(canon, [...(confirmedByCanon.get(canon) ?? []), p]);
  }
  const claimConfirmed = (plans: typeof confirmed, txs: Tx[]): Map<string, Tx[]> => {
    const got = new Map<string, Tx[]>(plans.map((p) => [p.key, []]));
    const rest: Tx[] = [];
    for (const t of txs) {
      // The user's pin first, then the plan's own charges, whatever they cost.
      const k = included.get(t.hash) ?? members.get(t.hash);
      if (k && got.has(k)) got.get(k)!.push(t);
      else rest.push(t);
    }
    const often = (p: (typeof plans)[number]) => p.cadence === "weekly" || p.cadence === "biweekly";
    const filled = new Map(plans.map((p) => [p.key, new Set(got.get(p.key)!.map((t) => t.date.slice(0, 7)))]));
    const center = (p: (typeof plans)[number]) =>
      settings[p.key]?.expectedAmount != null ? Math.sign(p.amount) * settings[p.key]!.expectedAmount! : p.amount;
    const fits = (p: (typeof plans)[number], t: Tx) =>
      Math.sign(t.amount) === Math.sign(p.amount) &&
      Math.abs(t.amount - center(p)) <= Math.max(0.5, 0.01 * Math.abs(center(p)));
    const dayGap = (p: (typeof plans)[number], t: Tx) => {
      if (often(p)) {
        const period = CADENCE_DAYS[p.cadence];
        const off = ((((Date.parse(t.date) - Date.parse(p.anchorDate)) / DAY) % period) + period) % period;
        return Math.min(off, period - off);
      }
      const d = Math.abs(Number(t.date.slice(8, 10)) - Number(p.anchorDate.slice(8, 10)));
      return Math.min(d, 30 - d);
    };
    const window = (p: (typeof plans)[number]) => (often(p) ? Math.floor(0.35 * CADENCE_DAYS[p.cadence]) : 10);
    for (const t of [...rest].sort((x, y) => y.date.localeCompare(x.date))) {
      const open = (p: (typeof plans)[number]) => often(p) || !filled.get(p.key)!.has(t.date.slice(0, 7));
      const best = plans
        .filter((p) => fits(p, t) && dayGap(p, t) <= window(p))
        .sort((a, b) => Number(open(b)) - Number(open(a)) || dayGap(a, t) - dayGap(b, t) || a.key.localeCompare(b.key))[0];
      if (!best) continue;
      got.get(best.key)!.push(t);
      filled.get(best.key)!.add(t.date.slice(0, 7));
    }
    for (const list of got.values()) list.sort((x, y) => x.date.localeCompare(y.date));
    return got;
  };
  // A confirmed plan follows its bill: its newest charge sets its day.
  const followPlan = db.prepare("UPDATE plans SET day = ?, anchorDate = ? WHERE key = ?");

  for (const [name, canons] of byVendor) {
    const mine = canons.flatMap((c) => confirmedByCanon.get(c) ?? []);
    const firm: Plan[] = [];
    let rowsOf = (c: string) => byCanon.get(c)!;
    if (mine.length) {
      const vendorTxs = canons
        .flatMap((c) => byCanon.get(c)!)
        .filter((t) => !excluded.has(t.hash))
        .sort((a, b) => a.date.localeCompare(b.date));
      const taken = new Set<string>();
      for (const [key, txs] of claimConfirmed(mine, vendorTxs)) {
        if (!txs.length) continue; // no charge yet: it waits, confirmed, for one
        for (const t of txs) {
          taken.add(t.hash);
          keepCharge.run(t.hash, key);
        }
        const plan = mine.find((p) => p.key === key)!;
        firm.push({ key, txs, events: txs.map((t) => ({ date: t.date, amount: t.amount })), cadence: plan.cadence });
        const newest = txs[txs.length - 1].date;
        followPlan.run(Number(newest.slice(8, 10)), newest, key);
      }
      rowsOf = (c: string) => byCanon.get(c)!.filter((t) => !taken.has(t.hash));
      // The forced pass below reads a vendor's charges whole; it would fold
      // the confirmed plans and the purchases into one plan.
      for (const c of canons) created.add(c);
    }
    // Each descriptor on its own, as the user has seen and corrected it.
    const apart = canons.map((c) => planVendor(c, rowsOf(c), overrides[c]));
    let chosen = apart.flat();
    let together: Plan[] | null = null;
    if (canons.length > 1) {
      // As one vendor, under its busiest descriptor. The merge has to earn
      // it: it wins only when it links charges the descriptors alone could
      // not (a renamed subscription's new charges continuing the old series)
      // without losing a series. On a tie the descriptors stay apart, and so
      // they do when one blob would swallow several bills — Chubb's eight
      // policies under three bank formats read as one "biweekly" bill when
      // merged, and it links every charge.
      const status = canons.some((c) => overrides[c] === "force")
        ? "force"
        : canons.some((c) => overrides[c] === "mute")
          ? "mute"
          : undefined;
      // Descriptors arrive one after another; the vendor's charges must be in
      // date order for the gap math and the last/next charge.
      together = planVendor(
        name,
        canons.flatMap(rowsOf).sort((a, b) => a.date.localeCompare(b.date)),
        status
      );
      if (linked(together) > linked(chosen) && together.length >= chosen.length) {
        chosen = together;
        // Settings live under the descriptor the user edited; carry them to
        // the vendor's name once so it keeps its name and rules.
        if (!settings[name]) {
          const from = canons.find((c) => settings[c]);
          if (from) {
            setRecurringSetting(name, settings[from]);
            settings[name] = settings[from];
          }
        }
        for (const c of canons) created.add(c);
      }
    }
    if (chosen !== together) for (let i = 0; i < canons.length; i++) if (apart[i].length) created.add(canons[i]);
    // Plans the user started by hand ("Start a plan" on a charge): a charge
    // pinned to a plan key nothing above emitted. The detector could not see
    // it — two amounts on one day, or too few charges yet — so the user's word
    // makes the plan: the pinned charges, plus every charge of this vendor
    // at the same amount that no other plan claimed, so next month's joins on
    // its own. Monthly unless the plan's settings say otherwise.
    // Once the detector catches up with a plan the user started (a fourth
    // charge makes the 21st read as monthly), its own plan carries the user's
    // key, so the plan — and the name the user gave it — stays the same plan.
    // Only when it IS that plan: the pinned charges post on the plan's day.
    // A forced vendor's one plan takes every unclaimed charge, and it took a
    // second membership's first charge on the 25th into the plan of the 7th,
    // then wore the user's name for it: one plan, renamed, in place of the two
    // the user asked for. Off the plan's day, the pinned charges leave it and
    // start their own plan below — and so do the plan's charges at their
    // amount that post off its day (the 22nd's, once its mark is lifted),
    // which the catch-all took only because nothing else had.
    // Beside a confirmed plan, a detected plan is one of several: with the
    // confirmed plan's charges set aside it would read as the vendor's only
    // plan and take the vendor's bare name ("Ben" in place of "Ben · 8th"),
    // so it keeps its billing day. It can't wear a confirmed plan's key: then
    // it is named by its amount.
    const firmKeys = new Set(mine.map((p) => p.key));
    const firmCanons = new Set(mine.map((p) => canonicalMerchant(p.vendor, links)));
    for (const p of chosen) {
      if (!mine.length) break;
      // Only the confirmed plan's own descriptor: another descriptor's plan
      // under the same vendor keeps its name ("Youtube Tv Go G.co Helppay"
      // beside a confirmed "Youtube Tv · 3rd").
      if (!isSeriesKey(p.key) && firmCanons.has(p.key)) {
        const days = new Map<number, number>();
        for (const t of p.txs) days.set(Number(t.date.slice(8, 10)), (days.get(Number(t.date.slice(8, 10))) ?? 0) + 1);
        const day = [...days].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
        p.key = seriesKey(p.key, dayLabel(day));
        p.inherit = undefined;
      }
      if (firmKeys.has(p.key)) {
        const amounts = p.txs.map((t) => Math.abs(t.amount)).sort((a, b) => a - b);
        p.key = seriesKey(seriesVendor(p.key), amountLabel(amounts[amounts.length >> 1]));
      }
    }
    let emitted = new Set([...chosen.map((p) => p.key), ...firmKeys]);
    const bucket = (t: Tx) => Math.min(Number(t.date.slice(8, 10)), 28);
    for (const p of chosen) {
      const isMine = (t: Tx) => { const k = included.get(t.hash); return !!k && k !== p.key && !emitted.has(k); };
      const byKey = new Map<string, Tx[]>();
      for (const t of p.txs) if (isMine(t)) byKey.set(included.get(t.hash)!, [...(byKey.get(included.get(t.hash)!) ?? []), t]);
      if (byKey.size === 0) continue;
      const rest = p.txs.filter((t) => !isMine(t));
      const days = new Map<number, number>();
      for (const t of rest) days.set(bucket(t), (days.get(bucket(t)) ?? 0) + 1);
      const typical = [...days.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0];
      const offDay = (t: Tx) => Math.abs(bucket(t) - typical) > 2;
      const adopt: string[] = [];
      const leaving = new Set<Tx>();
      for (const [key, pinned] of byKey) {
        if (p.cadence !== "monthly" || rest.length === 0 || !pinned.some(offDay)) {
          adopt.push(key);
          continue;
        }
        const amount = Math.abs(pinned[pinned.length - 1].amount);
        const sameAmount = (t: Tx) => Math.abs(Math.abs(t.amount) - amount) <= Math.max(0.5, 0.01 * amount);
        for (const t of pinned) leaving.add(t);
        for (const t of rest) if (sameAmount(t) && offDay(t)) leaving.add(t);
      }
      if (adopt.length === 1) p.key = adopt[0];
      if (leaving.size) {
        p.txs = p.txs.filter((t) => !leaving.has(t));
        p.events = p.txs.map((t) => ({ date: t.date, amount: t.amount }));
      }
    }
    emitted = new Set([...chosen.map((p) => p.key), ...firmKeys]);
    const claimed = new Set([...chosen, ...firm].flatMap((p) => p.txs.map((t) => t.hash)));
    const vendorRows = canons.flatMap((c) => byCanon.get(c)!);
    const started = new Map<string, Tx[]>();
    for (const t of vendorRows) {
      const key = included.get(t.hash);
      if (key && !emitted.has(key) && !claimed.has(t.hash)) started.set(key, [...(started.get(key) ?? []), t]);
    }
    for (const [key, pinned] of started) {
      const amount = Math.abs(pinned[pinned.length - 1].amount);
      const same = (t: Tx) => !claimed.has(t.hash) && !excluded.has(t.hash) && Math.abs(Math.abs(t.amount) - amount) <= Math.max(0.5, 0.01 * amount);
      const txs = vendorRows.filter((t) => pinned.includes(t) || same(t)).sort((a, b) => a.date.localeCompare(b.date));
      for (const t of txs) claimed.add(t.hash);
      chosen.push({ key, txs, events: txs.map((t) => ({ date: t.date, amount: t.amount })), cadence: settings[key]?.cadence ?? "monthly" });
    }
    for (const p of [...firm, ...chosen]) commit(p);
  }

  // User-forced recurrings: create one for each 'force' merchant the auto pass
  // didn't already catch (cadence/amount inferred from its history).
  for (const [merchant, status] of Object.entries(overrides)) {
    if (status !== "force" || created.has(merchant)) continue;
    const all = byCanon.get(merchant);
    if (!all || all.length === 0) continue;
    const txs = all.filter((t) => !excluded.has(t.hash));
    if (txs.length === 0) continue;
    const amounts = txs.map((t) => t.amount);
    let cadence: Recurring["cadence"] = "monthly";
    if (txs.length >= 2) {
      const dates = txs.map((t) => new Date(t.date + "T00:00:00Z").getTime());
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / DAY);
      // Current rhythm first (handles a plan change), then median, then monthly.
      cadence = recentCadence(gaps) ?? classifyCadence(medianGap(gaps)) ?? "monthly";
    }
    const lastDate = txs[txs.length - 1].date;
    const categoryId = modalCategory(txs);
    const rec = {
      merchant,
      categoryId,
      avgAmount: Number(currentAmount(amounts).toFixed(2)),
      cadence,
      lastDate,
      nextDate: addCadence(lastDate, cadence),
      count: txs.length,
    };
    const info = insert.run(rec);
    for (const t of txs) linkByHash.run(info.lastInsertRowid, t.hash);
    if (categoryId != null) backfillCategory.run(categoryId, info.lastInsertRowid);
    out.push({ id: Number(info.lastInsertRowid), ...rec });
  }

  // Flagged one-offs never belong to a recurring, however their merchant was
  // stamped above (a sibling charge shares the same merchant string).
  db.prepare(
    "UPDATE transactions SET recurringId = NULL WHERE hash IN (SELECT hash FROM recurring_tx_exclusions)"
  ).run();

  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

// ---- Dashboard aggregation ------------------------------------------------
export type DashboardData = {
  monthLabel: string;
  income: number;
  expenses: number;
  net: number;
  // For an in-progress month, income is heavily back-loaded (paychecks post late),
  // so month-to-date income and net are misleading. These project the month-end
  // figures (income ≈ prior full month; net = projected income − projected spend).
  // Null on complete/past months, where the actuals are shown instead.
  projectedIncome: number | null;
  projectedNet: number | null;
  byCategory: {
    name: string;
    categoryId: number | null;
    color: string;
    icon: string;
    total: number;
    budget: number | null;
    // Monthly-equivalent of this category's detected recurring charges — the
    // committed "floor" of the category, marked on its bar so the discretionary
    // headroom (budget − recurring) is visible. 0 when nothing recurs here.
    recurringBaseline: number;
  }[];
  // `projected` is null when it's too early in an in-progress month to run-rate
  // a meaningful forecast (the UI shows a soft message instead of a false figure).
  budget: { total: number; spent: number; projected: number | null } | null;
  // Cumulative expenses per day (climbs from $0), with a dashed projection to
  // month-end. projectedMonthEnd is null when it's too early/late to forecast.
  pace: {
    series: {
      date: string;
      actual: number | null;
      projected: number | null;
      prev: number | null;
    }[];
    projectedMonthEnd: number | null;
    daysElapsed: number;
    daysInMonth: number;
  };
  recentCount: number;
  needsReview: number;
  // Previous month with data, for month-over-month comparison. null if none.
  // throughDay is set when the viewed month is still in progress: the baseline is
  // then bounded to the prior month's first `throughDay` days, so a partial month
  // is compared like-for-like (not month-to-date vs. a full prior month).
  prev: {
    month: string;
    income: number;
    expenses: number;
    net: number;
    throughDay: number | null;
  } | null;
  // Recurring expenses due in the next N days from today. Only populated when the
  // viewed month is the current one; empty otherwise (the card then hides).
  upcoming: {
    windowDays: number;
    total: number;
    count: number;
    items: {
      merchant: string;
      series: string | null; // the plan's key when the vendor carries several
      name: string;
      nextDate: string;
      amount: number;
      categoryName: string | null;
      categoryColor: string | null;
      categoryIcon: string | null;
    }[];
  };
};

export function dashboard(month?: string): DashboardData {
  const db = getDb();
  // Default to the most recent month that has data.
  const m =
    month ??
    (
      db
        .prepare("SELECT substr(COALESCE(effectiveDate,date),1,7) AS m FROM transactions ORDER BY COALESCE(effectiveDate,date) DESC LIMIT 1")
        .get() as { m: string } | undefined
    )?.m ??
    new Date().toISOString().slice(0, 7);

  const rows = db
    .prepare(
      `SELECT t.amount, COALESCE(t.effectiveDate, t.date) AS date, t.recurringId, t.categoryId AS cid, c.name AS cname, c.color AS ccolor, c.icon AS cicon, c.kind AS ckind
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
       WHERE substr(COALESCE(t.effectiveDate, t.date),1,7) = ? AND t.excluded = 0
         AND COALESCE(c.excludeFromTotals, 0) = 0
       ORDER BY COALESCE(t.effectiveDate, t.date)`
    )
    .all(m) as {
    amount: number;
    date: string;
    recurringId: number | null;
    cid: number | null;
    cname: string | null;
    ccolor: string | null;
    cicon: string | null;
    ckind: string | null;
  }[];

  const budgets = getBudgets();

  let income = 0;
  let expenses = 0;
  const catMap = new Map<
    string,
    { id: number | null; color: string; icon: string; total: number }
  >();
  const spendById = new Map<number, number>();
  // Variable (non-recurring) charges, overall and per category: what the
  // forecasts read (see forecast.ts) — never the lumpy recurring bills.
  const variableCharges: { mag: number; cid: number | null }[] = [];
  for (const r of rows) {
    if (r.amount >= 0) income += r.amount;
    else expenses += -r.amount;
    if (r.amount < 0 && r.cname) {
      const e = catMap.get(r.cname) ?? {
        id: r.cid,
        color: r.ccolor ?? "#999",
        icon: r.cicon ?? "•",
        total: 0,
      };
      e.total += -r.amount;
      catMap.set(r.cname, e);
      if (r.cid != null) {
        spendById.set(r.cid, (spendById.get(r.cid) ?? 0) - r.amount);
      }
    }
    if (r.amount < 0 && r.recurringId == null) variableCharges.push({ mag: -r.amount, cid: r.cid });
  }

  // Spending pace: cumulative EXPENSES per day (climbs from $0), plus a
  // projection to month-end. Projection = run-rate of *variable* (non-recurring)
  // spend over the days elapsed, applied to the days remaining, plus any
  // recurring bills actually scheduled in those remaining days. Splitting
  // recurring from variable avoids double-counting (a flat run-rate would both
  // bake in past recurring charges *and* re-add the scheduled future ones).
  const expenseByDate = new Map<string, number>();
  for (const r of rows) {
    if (r.amount >= 0) continue;
    expenseByDate.set(r.date, (expenseByDate.get(r.date) ?? 0) - r.amount);
  }
  let spendCum = 0;
  const series: {
    date: string;
    actual: number | null;
    projected: number | null;
    prev: number | null; // prior-month cumulative at the same day-of-month (ghost line)
  }[] = [...expenseByDate.keys()].sort().map((date) => {
    spendCum += expenseByDate.get(date)!;
    return { date, actual: Number(spendCum.toFixed(2)), projected: null, prev: null };
  });

  // Only project when we're partway through a month with enough days elapsed to
  // have a stable rate (else a flat or 1-point month yields a nonsense forecast).
  const MIN_ELAPSED_DAYS = 5;
  const [yy, mm] = m.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const lastDataDay = rows.length ? Number(rows[rows.length - 1].date.slice(8, 10)) : 0;
  // Like-for-like month-over-month: when the viewed month is the current month
  // and still in progress, the income/expenses above are month-to-date, so the
  // prior-month baseline must be bounded to the same day-of-month — otherwise a
  // 9-day partial gets compared against a full 30-day month. Past/complete
  // months compare full-vs-full (compareThroughDay = null).
  const isCurrentMonth = m === new Date().toISOString().slice(0, 7);
  // Days still to come — only the month we are in has any. Measured from the
  // last transaction alone, a FINISHED month whose last charge fell on the 28th
  // had "3 days remaining", so it was run-rated, projected, and captioned "so
  // far": a closed month presented as a forecast.
  const remainingDays = isCurrentMonth ? daysInMonth - lastDataDay : 0;
  const compareThroughDay =
    isCurrentMonth && lastDataDay > 0 && lastDataDay < daysInMonth ? lastDataDay : null;

  // Recurring bills scheduled in the month's remaining days — shared by the pace
  // forecast and the budget projection so they rest on the same basis (run-rate
  // the variable spend, then add these known future charges rather than
  // extrapolating past lumpy ones). Empty unless the month is still in progress.
  const pad = (d: number) => `${m}-${String(d).padStart(2, "0")}`;
  const scheduledRemaining =
    remainingDays > 0
      ? upcomingRecurringExpenses(pad(lastDataDay + 1), pad(daysInMonth))
      : [];

  // Large purchases in the recent finished months, for the forecast (forecast.ts):
  // the same rows the dashboard counts, outside any plan, over the large line.
  // A month with data and no large purchase counts as a zero, not as missing.
  const largeHistory = (categoryIds?: Set<number>): { large: number; days: number }[] => {
    if (remainingDays <= 0) return [];
    const prior: string[] = [];
    for (let i = 1; i <= HISTORY_MONTHS; i++) prior.push(new Date(Date.UTC(yy, mm - 1 - i, 1)).toISOString().slice(0, 7));
    const withData = new Set(
      (db.prepare(`SELECT DISTINCT substr(COALESCE(effectiveDate, date),1,7) AS ym FROM transactions WHERE substr(COALESCE(effectiveDate, date),1,7) IN (${prior.map(() => "?").join(",")})`).all(...prior) as { ym: string }[]).map((r) => r.ym)
    );
    const big = db
      .prepare(
        `SELECT substr(COALESCE(t.effectiveDate, t.date),1,7) AS ym, t.categoryId AS cid, -t.amount AS mag
         FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
         WHERE t.excluded = 0 AND COALESCE(c.excludeFromTotals, 0) = 0 AND t.recurringId IS NULL
           AND -t.amount > ? AND -t.amount <= ? AND substr(COALESCE(t.effectiveDate, t.date),1,7) IN (${prior.map(() => "?").join(",")})`
      )
      .all(LARGE_CHARGE, EXTRAORDINARY, ...prior) as { ym: string; cid: number | null; mag: number }[];
    return prior
      .filter((ym) => withData.has(ym))
      .map((ym) => ({
        large: big.filter((b) => b.ym === ym && (!categoryIds || (b.cid != null && categoryIds.has(b.cid)))).reduce((a, b) => a + b.mag, 0),
        days: new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate(),
      }));
  };

  let projectedMonthEnd: number | null = null;
  if (remainingDays > 0 && lastDataDay >= MIN_ELAPSED_DAYS) {
    const scheduled = scheduledRemaining.reduce((a, r) => a + Math.abs(r.avgAmount), 0);
    const projectedExtra =
      variableStillToCome({ seen: variableCharges.map((v) => v.mag), daysElapsed: lastDataDay, daysRemaining: remainingDays, history: largeHistory() }) + scheduled;
    projectedMonthEnd = Number((expenses + projectedExtra).toFixed(2));
    // Linear ramp for the dashed segment; anchor it to the last actual point.
    if (series.length) series[series.length - 1].projected = series[series.length - 1].actual;
    const perDay = projectedExtra / remainingDays;
    let p = expenses;
    for (let day = lastDataDay + 1; day <= daysInMonth; day++) {
      p += perDay;
      series.push({ date: pad(day), actual: null, projected: Number(p.toFixed(2)), prev: null });
    }
  }
  const pace = { series, projectedMonthEnd, daysElapsed: lastDataDay, daysInMonth };

  const recurringByCat = recurringMonthlyByCategory();
  const byCategory = [...catMap.entries()]
    .map(([name, v]) => ({
      name,
      categoryId: v.id,
      color: v.color,
      icon: v.icon,
      total: Number(v.total.toFixed(2)),
      budget: v.id != null ? budgets[v.id] ?? null : null,
      recurringBaseline: v.id != null ? Number((recurringByCat[v.id] ?? 0).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Overall budget status (Phase C): compares spend in *budgeted* categories to
  // the sum of their budgets — like-for-like, so unbudgeted spend doesn't make
  // you look over. null when no budgets are set.
  const budgetIds = Object.keys(budgets);
  let budgetSummary: DashboardData["budget"] = null;
  if (budgetIds.length > 0) {
    const budgetedSet = new Set(budgetIds.map(Number));
    let total = 0;
    let spent = 0;
    for (const idStr of budgetIds) {
      const id = Number(idStr);
      total += budgets[id];
      spent += spendById.get(id) ?? 0;
    }
    // Projection mirrors the pace forecast (the same variable-spend forecast,
    // plus scheduled recurring) restricted to budgeted categories — so a lumpy
    // early bill isn't multiplied out to an alarmist figure. Held back as null until
    // enough of an in-progress month has elapsed for a run-rate to mean anything;
    // a complete month simply reports its actuals.
    let projected: number | null;
    if (!isCurrentMonth || remainingDays <= 0) {
      projected = spent;
    } else if (lastDataDay >= MIN_ELAPSED_DAYS) {
      const scheduledBudgeted = scheduledRemaining
        .filter((r) => r.categoryId != null && budgetedSet.has(r.categoryId))
        .reduce((a, r) => a + Math.abs(r.avgAmount), 0);
      projected =
        spent +
        variableStillToCome({
          seen: variableCharges.filter((v) => v.cid != null && budgetedSet.has(v.cid)).map((v) => v.mag),
          daysElapsed: lastDataDay,
          daysRemaining: remainingDays,
          history: largeHistory(budgetedSet),
        }) +
        scheduledBudgeted;
    } else {
      projected = null;
    }
    budgetSummary = {
      total: Number(total.toFixed(2)),
      spent: Number(spent.toFixed(2)),
      projected: projected == null ? null : Number(projected.toFixed(2)),
    };
  }

  // Transactions still needing a category — the "you have work to do" signal.
  // Scoped to the viewed month and excludes transfers, matching the rest of the view.
  const needsReview = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE substr(COALESCE(effectiveDate,date),1,7) = ? AND excluded = 0 AND categoryId IS NULL`
      )
      .get(m) as { n: number }
  ).n;

  // Month-over-month baseline: the most recent earlier month that has data.
  // "With data" (not strict calendar-previous) avoids divide-by-zero / bogus
  // swings across gaps. Income/expense math mirrors the current-month logic above.
  const prevMonth = (
    db
      .prepare(
        `SELECT MAX(substr(COALESCE(effectiveDate,date),1,7)) AS m FROM transactions
         WHERE excluded = 0 AND substr(COALESCE(effectiveDate,date),1,7) < ?`
      )
      .get(m) as { m: string | null }
  ).m;

  let prev: DashboardData["prev"] = null;
  let priorFullIncome: number | null = null;
  if (prevMonth) {
    // Full prior-month income (unbounded by day) — the basis for projecting this
    // month's back-loaded income.
    priorFullIncome = (
      db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END), 0) AS income
           FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
           WHERE substr(COALESCE(t.effectiveDate, t.date),1,7) = ? AND t.excluded = 0
             AND COALESCE(c.excludeFromTotals, 0) = 0`
        )
        .get(prevMonth) as { income: number }
    ).income;
    // Bound the baseline to the same first-N days when comparing a partial month.
    const dayClause =
      compareThroughDay != null
        ? "AND CAST(substr(COALESCE(t.effectiveDate, t.date), 9, 2) AS INTEGER) <= ?"
        : "";
    const stmt = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.amount <  0 THEN -t.amount ELSE 0 END), 0) AS expenses
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
       WHERE substr(COALESCE(t.effectiveDate, t.date),1,7) = ? AND t.excluded = 0
         AND COALESCE(c.excludeFromTotals, 0) = 0
         ${dayClause}`
    );
    const t = (
      compareThroughDay != null
        ? stmt.get(prevMonth, compareThroughDay)
        : stmt.get(prevMonth)
    ) as { income: number; expenses: number };
    prev = {
      month: prevMonth,
      income: Number(t.income.toFixed(2)),
      expenses: Number(t.expenses.toFixed(2)),
      net: Number((t.income - t.expenses).toFixed(2)),
      throughDay: compareThroughDay,
    };

    // Prior-month cumulative spend by day-of-month, overlaid on the pace chart as
    // a faint "last month" reference so ahead/behind is visible at a glance. Built
    // across the full current month (carried flat past the prior month's last day)
    // and attached to each series point by its day-of-month.
    const prevByDay = db
      .prepare(
        `SELECT CAST(substr(COALESCE(t.effectiveDate, t.date), 9, 2) AS INTEGER) AS day,
                SUM(-t.amount) AS amt
         FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
         WHERE substr(COALESCE(t.effectiveDate, t.date),1,7) = ? AND t.excluded = 0
           AND COALESCE(c.excludeFromTotals, 0) = 0 AND t.amount < 0
         GROUP BY day`
      )
      .all(prevMonth) as { day: number; amt: number }[];
    const dayAmt = new Map(prevByDay.map((r) => [r.day, r.amt]));
    const prevCum: number[] = [];
    let acc = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      acc += dayAmt.get(d) ?? 0;
      prevCum[d] = Number(acc.toFixed(2));
    }
    for (const pt of series) {
      const d = Number(pt.date.slice(8, 10));
      pt.prev = prevCum[d] ?? null;
    }
  }

  // Forward-looking: recurring expenses due in the next N days from *today*.
  // This is a today-relative forecast ("what's about to hit my account"), so it
  // only makes sense on the current month — surfacing it while reviewing a past
  // (or future) month would show bills that have nothing to do with what's on
  // screen. Off-month: empty, and the card hides itself.
  const UPCOMING_WINDOW_DAYS = 14;
  const today = new Date().toISOString().slice(0, 10);
  const toDate = new Date(today + "T00:00:00Z");
  toDate.setUTCDate(toDate.getUTCDate() + UPCOMING_WINDOW_DAYS);
  const due = isCurrentMonth
    ? upcomingRecurringExpenses(today, toDate.toISOString().slice(0, 10))
    : [];
  const upcoming = {
    windowDays: UPCOMING_WINDOW_DAYS,
    total: Number(due.reduce((a, r) => a + Math.abs(r.avgAmount), 0).toFixed(2)),
    count: due.length,
    items: due.slice(0, 6).map((r) => ({
      // The shelf opens on the descriptor; a split series' key ("Netflix ·
      // 26th") is not one.
      merchant: seriesVendor(r.merchant),
      series: isSeriesKey(r.merchant) ? r.merchant : null,
      name: r.displayName,
      nextDate: r.nextDate,
      amount: r.avgAmount,
      categoryName: r.categoryName,
      categoryColor: r.categoryColor,
      categoryIcon: r.categoryIcon,
    })),
  };

  const monthLabel = new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  // Project this month's back-loaded income and net — only while a month is in
  // progress (we're already projecting spend) and we have a prior month to lean
  // on. Income recurs, so prior full-month income is the estimate; never below
  // what's already in.
  let projectedIncome: number | null = null;
  let projectedNet: number | null = null;
  if (projectedMonthEnd != null && priorFullIncome != null) {
    projectedIncome = Number(Math.max(income, priorFullIncome).toFixed(2));
    projectedNet = Number((projectedIncome - projectedMonthEnd).toFixed(2));
  }

  return {
    monthLabel,
    income: Number(income.toFixed(2)),
    expenses: Number(expenses.toFixed(2)),
    net: Number((income - expenses).toFixed(2)),
    projectedIncome,
    projectedNet,
    byCategory,
    budget: budgetSummary,
    pace,
    recentCount: rows.length,
    needsReview,
    prev,
    upcoming,
  };
}

