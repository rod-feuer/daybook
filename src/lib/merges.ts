import { getChargeMoves, vendorName } from "./chargeVendors";
import { seriesVendor } from "./series";
import { getDb, ensureMergeDismissals } from "./db";
import {
  getMerchantLinks,
  canonicalMerchant,
  linkMerchant,
  distinctMerchants,
  isRecurringActive,
  getRecurringOverrides,
  getRecurringSettings,
  merchantDisplayName,
  confirmedKey,
} from "./queries";
import { CADENCE_DAYS, type Cadence } from "./cadence";

// US state codes as normalizeMerchant title-cases them (e.g. "IN" -> "In").
const STATES = new Set(
  "Al Ak Az Ar Ca Co Ct De Fl Ga Hi Id Il In Ia Ks Ky La Me Md Ma Mi Mn Ms Mo Mt Ne Nv Nh Nj Nm Ny Nc Nd Oh Ok Or Pa Ri Sc Sd Tn Tx Ut Vt Va Wa Wv Wi Wy".split(
    " "
  )
);

// Approximate days between charges per cadence (for the "lands in the expected
// slot" timing test below).
const PERIOD: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  bimonthly: 61,
  quarterly: 91,
  semiannual: 182,
  yearly: 365,
};

// Strip a trailing location suffix from a bank descriptor — either
// "<name> - <city…> <ST>" or a bare "<name> <city> <ST>". The trailing token
// must be a real US state code, and the surviving prefix must be specific
// enough (≥ 4 chars) so it can't collapse to a generic like "The". Returns the
// stripped prefix, or null when there's no recognizable location suffix.
export function stripLocationSuffix(merchant: string): string | null {
  let m = merchant.match(/^(.+?) - .+ ([A-Z][a-z])$/); // "Name - City ST"
  if (!m) m = merchant.match(/^(.+?) [A-Za-z]+ ([A-Z][a-z])$/); // "Name City ST"
  if (!m || !STATES.has(m[2])) return null;
  const prefix = m[1].trim();
  return prefix.length >= 4 ? prefix : null;
}

export type MergeSuggestion = {
  canonical: string; // the vendor everything folds into (the link target)
  key: string; // unique UI id for this card
  dismissKeys: string[]; // keys to remember when the card is dismissed
  variants: { merchant: string; count: number }[];
  total: number;
  note?: string; // why it's suggested (recurring-match only)
  categoryId?: number; // recurring-match: set uncategorized variant charges to this
  lowConfidence?: boolean; // 0.8–0.9 name band — surface for confirmation, not certain
  // The bill a recurring-match card folds into, as a row elsewhere can say it
  // to decide there: "Same as Every ($20 monthly, the 4th)?".
  bill?: { name: string; amount: number; cadence: string; day: number };
};

function dismissedKeys(db: ReturnType<typeof getDb>): Set<string> {
  ensureMergeDismissals(db);
  return new Set(
    (
      db.prepare("SELECT canonical FROM merchant_merge_dismissals").all() as {
        canonical: string;
      }[]
    ).map((r) => r.canonical)
  );
}

// Candidate merges from location-suffix variants. Liberal by design — it's a
// review queue, so the user is the precision filter. Excludes anything already
// linked or previously dismissed. Dismiss key = the canonical (bare).
export function mergeSuggestions(): MergeSuggestion[] {
  const db = getDb();
  const dismissed = dismissedKeys(db);
  const links = getMerchantLinks();
  const merchants = distinctMerchants();
  const countOf: Record<string, number> = {};
  for (const m of merchants) countOf[m.merchant] = m.count;

  const groups: Record<string, Set<string>> = {};
  for (const { merchant } of merchants) {
    const canon = stripLocationSuffix(merchant);
    if (!canon) continue;
    if (canonicalMerchant(merchant, links) === canonicalMerchant(canon, links)) continue;
    (groups[canon] ??= new Set()).add(merchant);
  }

  const out: MergeSuggestion[] = [];
  for (const [canon, set] of Object.entries(groups)) {
    if (dismissed.has(canon)) continue;
    if (countOf[canon] != null) set.add(canon);
    if (set.size < 2) continue;
    const variants = [...set]
      .map((merchant) => ({ merchant, count: countOf[merchant] ?? 0 }))
      .sort((a, b) => b.count - a.count);
    out.push({
      canonical: canon,
      key: "loc:" + canon,
      dismissKeys: [canon], // bare canonical (back-compat with prior dismissals)
      variants,
      total: variants.reduce((s, v) => s + v.count, 0),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Vendor-name similarity lives in ./similarity (a leaf module, so queries.ts can
// use it too without an import cycle). Re-exported here for existing callers.
import { normName, nameAffinity, NAME_MATCH, LOW_MATCH } from "./similarity";
export { nameAffinity, NAME_MATCH, LOW_MATCH };

// Behavior + name detector: a rare, non-recurring charge whose name clearly
// echoes an active recurring's vendor (shared ≥6-char prefix) AND that posts
// around that bill's cadence with a plausible amount is almost certainly that
// vendor under a new descriptor — whatever the string change (location, spelling,
// processor prefix). Catches the class the location-suffix rule can't. The name
// filter is what disambiguates two similar monthly bills. `exclude` skips
// merchants already surfaced by the location detector. Dismiss key = "rec:<m>".
// Only plans the user added are bills to fold a stray into: a plan the
// detector merely suggested is a guess (Charleston's, a restaurant read as a
// quarterly bill, drew "Chatham" on a shared "Cha"), and since durable plans
// a guess counts nowhere else either.
export function recurringMatchSuggestions(exclude: Set<string>): MergeSuggestion[] {
  const db = getDb();
  const dismissed = dismissedKeys(db);
  const links = getMerchantLinks();

  const recs = (
    db
      .prepare(
        `SELECT r.id, r.merchant, r.categoryId, c.name AS categoryName, r.cadence, r.lastDate, r.avgAmount,
                MIN(ABS(t.amount)) lo, MAX(ABS(t.amount)) hi, GROUP_CONCAT(DISTINCT t.account) accounts, p.day
         FROM recurrings r JOIN transactions t ON t.recurringId = r.id
         LEFT JOIN categories c ON c.id = r.categoryId
         LEFT JOIN plans p ON p.key = r.merchant
         WHERE r.avgAmount < 0 AND ${confirmedKey("r.merchant")}
         GROUP BY r.id`
      )
      .all() as {
      merchant: string;
      categoryId: number | null;
      categoryName: string | null;
      cadence: string;
      lastDate: string;
      avgAmount: number;
      lo: number;
      hi: number;
      accounts: string | null;
      day: number | null;
    }[]
  )
    .filter((r) => isRecurringActive(r.lastDate, r.cadence))
    // A split series ("Netflix · 26th") stands in for its vendor here: orphans
    // echo the descriptor, and a merge must link onto the descriptor.
    .map((r) => ({ ...r, merchant: seriesVendor(r.merchant) }));

  const merchants = distinctMerchants();
  const countOf: Record<string, number> = {};
  for (const m of merchants) countOf[m.merchant] = m.count;
  const rare = new Set(merchants.filter((m) => m.count <= 2).map((m) => m.merchant));

  // All currently non-recurring expense charges of rare merchants, grouped.
  const charges = db
    .prepare(
      `SELECT merchant, COALESCE(effectiveDate, date) AS d, amount, categoryId, account
       FROM transactions
       WHERE recurringId IS NULL AND amount < 0 AND excluded = 0`
    )
    .all() as { merchant: string; d: string; amount: number; categoryId: number | null; account: string }[];
  const byMerchant: Record<string, typeof charges> = {};
  for (const c of charges) {
    if (!rare.has(c.merchant)) continue;
    (byMerchant[c.merchant] ??= []).push(c);
  }

  // Every name a vendor goes by (its plan's key and the names combined into
  // it): a stray is compared with all of them. "Every Media" scored 0.796
  // against the plan's key "Every Every.to-chargbrooklyn" and 0.82 against the
  // same vendor's "Every Every.to Charg", and was offered nowhere.
  const namesOf = new Map<string, Set<string>>();
  for (const name of [...merchants.map((m) => m.merchant), ...Object.keys(links), ...Object.values(links)]) {
    const c = canonicalMerchant(name, links);
    (namesOf.get(c) ?? namesOf.set(c, new Set()).get(c)!).add(name);
  }
  // A short name matches anything that contains its letters ("Adt", ADT's
  // other name, is in "pADThai": 0.81), so other names count from five letters.
  const letters = (n: string) => n.replace(/[^a-z]/gi, "").length;
  const affinityTo = (stray: string, recMerchant: string) =>
    Math.max(
      nameAffinity(stray, recMerchant),
      ...[...(namesOf.get(canonicalMerchant(recMerchant, links)) ?? [])].filter((n) => letters(n) >= 5).map((n) => nameAffinity(stray, n))
    );

  // Match each orphan merchant to its best recurring, then GROUP orphans by that
  // recurring so several stray descriptors of one vendor become a single card.
  const groups = new Map<
    string,
    { rec: (typeof recs)[number]; orphans: string[]; maxAffinity: number }
  >();
  for (const [merchant, cs] of Object.entries(byMerchant)) {
    if (exclude.has(merchant) || dismissed.has("rec:" + merchant)) continue;
    const cm = canonicalMerchant(merchant, links);
    // A name already combined into a vendor has had its decision (DESIGN.md
    // §2: one decision per vendor). "Southern Ridge", an alias of Southern,
    // was offered to "South Central Inmartinsville In" on a shared "South".
    if (cm !== merchant) continue;

    // Best recurring by name affinity (the disambiguator), confirmed by a
    // plausible amount and a charge that posts around the bill's cadence. The
    // LOW_MATCH..NAME_MATCH band is kept but flagged low-confidence below.
    let best: { rec: (typeof recs)[number]; affinity: number } | null = null;
    for (const c of cs) {
      const mag = Math.abs(c.amount);
      for (const r of recs) {
        if (canonicalMerchant(r.merchant, links) === cm) continue; // already same vendor
        const affinity = affinityTo(merchant, r.merchant);
        if (affinity < LOW_MATCH) continue; // names must at least echo each other
        // The same evidence plan matching asks for (planMatch.ts), since a
        // Combine joins the bill too. Within 10% of the bill's own amounts:
        // at half to one and a half times, a $3,900 Amex payment passed for
        // the $4,861 Chase mortgage (2026-10-05).
        if (mag < r.lo * 0.9 || mag > r.hi * 1.1) continue;
        // A monthly bill's day, within three: that payment posted four days
        // after the mortgage's 1st.
        if (r.cadence === "monthly") {
          const day = r.day ?? Number(r.lastDate.slice(8, 10)); // a plan without a stored day: its last charge's
          const d = Math.abs(Number(c.d.slice(8, 10)) - day);
          if (Math.min(d, 31 - d) > 3) continue;
        }
        // The card the bill is paid from, unless the names agree outright.
        if (affinity < NAME_MATCH && r.accounts != null && !r.accounts.split(",").includes(c.account)) continue;
        const period = PERIOD[r.cadence] ?? 30;
        const gap = (Date.parse(c.d) - Date.parse(r.lastDate)) / 86_400_000;
        if (gap < -period || gap > period * 2) continue; // not a current/forward charge
        if (!best || affinity > best.affinity) best = { rec: r, affinity };
      }
    }
    if (!best) continue;
    const g = groups.get(best.rec.merchant) ?? {
      rec: best.rec,
      orphans: [],
      maxAffinity: 0,
    };
    g.orphans.push(merchant);
    g.maxAffinity = Math.max(g.maxAffinity, best.affinity);
    groups.set(best.rec.merchant, g);
  }

  const out: MergeSuggestion[] = [];
  for (const { rec: r, orphans, maxAffinity } of groups.values()) {
    const lowConfidence = maxAffinity < NAME_MATCH;
    const variants = [
      ...orphans
        .map((m) => ({ merchant: m, count: countOf[m] ?? 0 }))
        .sort((a, b) => b.count - a.count),
      { merchant: r.merchant, count: countOf[r.merchant] ?? 0 },
    ];
    out.push({
      canonical: r.merchant,
      key: "rec:" + r.merchant,
      dismissKeys: orphans.map((m) => "rec:" + m),
      variants,
      total: variants.reduce((s, v) => s + v.count, 0),
      note: lowConfidence
        ? // Says the whole of what Combine does: it joins the bill as well as
          // the vendor. The note named only the category, so a Combine that
          // matched the charge into its plan read as a rename.
          `Possibly the same as your ${r.cadence} “${r.merchant}” bill — similar name, posts in the same slot at a similar amount. Combine only if it's the same vendor: ${
            orphans.length > 1 ? "they join" : "it joins"
          } that bill${r.categoryName ? ` and ${orphans.length > 1 ? "take" : "takes"} its category, ${r.categoryName}` : ""}.`
        : `Lands in your ${r.cadence} “${r.merchant}” slot at a similar amount — likely the same vendor renamed. Combining makes ${
            orphans.length > 1 ? "them" : "it"
          } recurring${r.categoryId != null ? " and sets the category" : ""}.`,
      categoryId: r.categoryId ?? undefined,
      lowConfidence,
      bill: {
        name: merchantDisplayName(r.merchant, getRecurringSettings(), links),
        amount: Math.abs(r.avgAmount),
        cadence: r.cadence,
        day: Number(r.lastDate.slice(8, 10)),
      },
    });
  }
  // Confident matches first, borderline ones last.
  return out.sort((a, b) => Number(a.lowConfidence) - Number(b.lowConfidence) || b.total - a.total);
}

// Normalized-equality detector: distinct descriptors that reduce to the SAME
// string once punctuation/spacing/case is stripped ("Jimmy John's" vs
// "Jimmy Johns") are unambiguously one vendor — the safe, high-precision way to
// catch non-recurring splits the location/behaviour detectors miss. Canonical =
// the most common spelling. `exclude` skips merchants already surfaced above.
// Dismiss key = "eq:<normalized name>".
export function nameEqualityMergeSuggestions(exclude: Set<string>): MergeSuggestion[] {
  const db = getDb();
  const dismissed = dismissedKeys(db);
  const links = getMerchantLinks();
  const groups: Record<string, { merchant: string; count: number }[]> = {};
  for (const m of distinctMerchants()) {
    if (exclude.has(m.merchant)) continue;
    const n = normName(m.merchant);
    if (n.length < 4) continue;
    (groups[n] ??= []).push({ merchant: m.merchant, count: m.count });
  }

  const out: MergeSuggestion[] = [];
  for (const [n, variants] of Object.entries(groups)) {
    const key = "eq:" + n;
    if (variants.length < 2 || dismissed.has(key)) continue;
    // Skip if they already fold into one vendor.
    if (new Set(variants.map((v) => canonicalMerchant(v.merchant, links))).size < 2) continue;
    const sorted = [...variants].sort((a, b) => b.count - a.count);
    out.push({
      canonical: sorted[0].merchant, // the most common spelling wins
      key,
      dismissKeys: [key],
      variants: sorted,
      total: sorted.reduce((s, v) => s + v.count, 0),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Handoff detector: a bank rename seen from behaviour alone. One plan stops, and
// within about one billing period another vendor starts at the same amount, on
// the same account, in the same category — and the old name never appears
// again. No name test is needed to find it (Uplift became Upgrade; "Adtsecurity
// Myadt.co" became "Adt"), which is why the name-based detectors above missed
// thirteen of these in one year, six of them on the day Plaid replaced the
// Copilot import and shortened every descriptor. Left split, the old plan
// reads as lapsed and the new one as three charges old.
//
// Precision comes from the conjunction, not from any one test:
// - the successor's first charge lands 0.5–1.6 periods after the plan's last;
// - the successor repeats at that amount (≥2 charges within 3%, and most of
//   its charges) — a gas fill-up at a similar price does not;
// - same account, and the successor's category is the plan's (or none yet);
// - the old vendor has no charge of any kind after the successor's first;
// - neither side is marked Not recurring: a mark on one name mutes the whole
//   combined vendor, so approving would erase the plan it meant to extend;
// - the old vendor carries ONE plan: a descriptor that held two policies has
//   no single successor (Chubb's old name billed the car and the house; its
//   successors are two vendors), and folding it into one drags the other along.
// A successor that carries several plans is read plan by plan. The bank folded
// the mortgage ("Sofi Lending Loan Paymt") and a personal loan into one new
// name, "Sofi": as a vendor its amounts are mixed and its first charge was the
// loan, so it matched nothing, and the mortgage read as lapsed beside its own
// continuation, "Sofi · 1st". Each of its plans stands as a successor on its
// own charges; the card still combines the two vendors, and says which plan.
// The names must share a word at this level — a catch-all descriptor (Apple's
// billing) has a plan at nearly every price.
// A pair whose names share no word is surfaced as a "possible match", and is
// dropped when either side also has a candidate whose name does (two $15
// newsletters that both changed descriptor in one month pair up four ways; the
// names say which two are real). The vendor that carries the user's settings
// stays canonical, else the newer name — the one future charges arrive under.
// Dismiss key = "handoff:<old>><new>".
export function handoffSuggestions(exclude: Set<string>): MergeSuggestion[] {
  const db = getDb();
  const dismissed = dismissedKeys(db);
  const links = getMerchantLinks();
  const overrides = getRecurringOverrides();
  const settings = getRecurringSettings();
  const DAY = 86_400_000;
  type Tx = { date: string; amount: number; account: string; merchant: string; recurringId: number | null; categoryId: number | null; hash: string };
  // Charges that count. (A split parent is excluded, so its parts stand for it.)
  const txs = db
    .prepare("SELECT date, amount, account, merchant, recurringId, categoryId, hash FROM transactions WHERE excluded = 0 ORDER BY date, id")
    .all() as Tx[];
  const moves = getChargeMoves();
  const byVendor = new Map<string, Tx[]>();
  for (const t of txs) {
    const c = canonicalMerchant(vendorName(t, moves), links);
    (byVendor.get(c) ?? byVendor.set(c, []).get(c)!).push(t);
  }
  const mode = <T,>(xs: T[]): T | undefined => {
    const n = new Map<T, number>();
    for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const near = (a: number, b: number) =>
    Math.sign(a) === Math.sign(b) && Math.abs(Math.abs(a) - Math.abs(b)) <= 0.03 * Math.max(Math.abs(a), Math.abs(b));
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4));
  const muted = (vendor: string) => (byVendor.get(vendor) ?? []).some((t) => overrides[t.merchant] === "mute") || overrides[vendor] === "mute";
  // A settings row that holds something: a row left behind with every field
  // empty is not the user's name for the vendor ("Sofi" had one, and would
  // have outranked "Sofi Mortgage (Carmel)").
  const hasName = (vendor: string) => Object.entries(settings).some(([k, s]) => canonicalMerchant(seriesVendor(k), links) === vendor && !!s.alias);
  const hasSettings = (vendor: string) =>
    Object.entries(settings).some(([k, s]) => canonicalMerchant(seriesVendor(k), links) === vendor && Object.values(s).some((v) => v != null && v !== ""));

  const plans = db.prepare("SELECT id, merchant, cadence FROM recurrings").all() as { id: number; merchant: string; cadence: Cadence }[];
  const linkedBy = new Map<number, Tx[]>();
  for (const t of txs) if (t.recurringId != null) (linkedBy.get(t.recurringId) ?? linkedBy.set(t.recurringId, []).get(t.recurringId)!).push(t);
  const plansOf = new Map<string, number>();
  for (const p of plans) {
    const v = canonicalMerchant(seriesVendor(p.merchant), links);
    plansOf.set(v, (plansOf.get(v) ?? 0) + 1);
  }
  // Successors in date order of their first charge, so each plan scans only
  // the ones that began inside its window. A vendor with one plan or none is a
  // successor as a whole; a vendor with several is one successor per plan.
  const planKeysOf = new Map<string, { id: number; key: string }[]>();
  for (const p of plans) {
    const v = canonicalMerchant(seriesVendor(p.merchant), links);
    (planKeysOf.get(v) ?? planKeysOf.set(v, []).get(v)!).push({ id: p.id, key: p.merchant });
  }
  const starts = [...byVendor.entries()]
    .flatMap(([vendor, t]): { vendor: string; planKey: string | null; t: Tx[] }[] => {
      const theirPlans = planKeysOf.get(vendor) ?? [];
      if (theirPlans.length < 2) return [{ vendor, planKey: null, t }];
      return theirPlans.map((p) => ({ vendor, planKey: p.key, t: linkedBy.get(p.id) ?? [] })).filter((s) => s.t.length > 0);
    })
    .map((s) => ({ ...s, first: s.t[0], at: Date.parse(s.t[0].date) }))
    .sort((a, b) => a.at - b.at);
  type Pair = { old: string; next: string; shared: boolean; note: string; categoryId: number | null };
  const pairs: Pair[] = [];
  for (const plan of plans) {
    const old = canonicalMerchant(seriesVendor(plan.merchant), links);
    const mine = byVendor.get(old);
    const linked = linkedBy.get(plan.id) ?? [];
    if (!mine || linked.length < 3 || plansOf.get(old) !== 1 || exclude.has(old) || muted(old)) continue;
    const period = CADENCE_DAYS[plan.cadence] ?? 30;
    const last = linked[linked.length - 1];
    const lastAt = Date.parse(last.date);
    const vendorLast = mine[mine.length - 1].date;
    const account = mode(linked.map((t) => t.account));
    const category = mode(linked.map((t) => t.categoryId)) ?? null;
    for (const { vendor: next, planKey, t: theirs, first, at } of starts) {
      const gap = (at - lastAt) / DAY;
      if (gap < 0.5 * period) continue;
      if (gap > 1.6 * period) break;
      if (next === old || exclude.has(next)) continue;
      if (first.date <= vendorLast) continue; // the old name never appears again
      const same = theirs.filter((t) => near(t.amount, last.amount));
      if (!near(first.amount, last.amount) || same.length < 2 || same.length < 0.6 * theirs.length) continue;
      if (mode(theirs.map((t) => t.account)) !== account) continue;
      const theirCategory = mode(theirs.map((t) => t.categoryId)) ?? null;
      if (theirCategory != null && theirCategory !== category) continue;
      if (muted(next) || dismissed.has(`handoff:${old}>${next}`)) continue;
      const shared = [...words(old)].some((w) => words(next).has(w));
      // Folding a vendor into one that carries several plans is a bigger act
      // than joining two names, so the names must agree. Without this, YouTube
      // TV ($72.98, billed by Google) was offered into "Apple.com-bill", a
      // 365-charge catch-all whose $74.89 plan began a month later.
      if (planKey && !shared) continue;
      pairs.push({
        old,
        next,
        shared,
        categoryId: category,
        note: `${planKey ? `Its plan “${planKey}” picks` : "Picks"} up where “${old}” left off: $${Math.abs(last.amount).toFixed(2)} ${plan.cadence}, ${Math.round(gap)} days after its last charge, same account${theirCategory != null ? " and category" : ""}`,
      });
    }
  }
  // Names break ties: a vendor with a name-sharing partner keeps only that one.
  const namedOld = new Set(pairs.filter((p) => p.shared).map((p) => p.old));
  const namedNext = new Set(pairs.filter((p) => p.shared).map((p) => p.next));
  const kept = pairs.filter((p) => p.shared || (!namedOld.has(p.old) && !namedNext.has(p.next)));
  const seen = new Set<string>();
  const out: MergeSuggestion[] = [];
  for (const p of kept) {
    if (seen.has(p.old) || seen.has(p.next)) continue; // one card per vendor
    seen.add(p.old).add(p.next);
    // The user's NAME for a vendor outranks any other setting: "Sofi" held a
    // cadence override and nothing else, and would have displaced "Sofi
    // Mortgage (Carmel)".
    const keepOld = hasName(p.old) !== hasName(p.next) ? hasName(p.old) : hasSettings(p.old) && !hasSettings(p.next);
    const canonical = keepOld ? p.old : p.next;
    const variants = [p.old, p.next].map((m) => ({ merchant: m, count: byVendor.get(m)!.length }));
    out.push({
      canonical,
      key: `handoff:${p.old}>${p.next}`,
      dismissKeys: [`handoff:${p.old}>${p.next}`],
      variants,
      total: variants.reduce((a, v) => a + v.count, 0),
      note: p.note,
      categoryId: p.categoryId ?? undefined,
      lowConfidence: !p.shared,
    });
  }
  return out;
}

// The full review queue: behaviour-based matches first (most time-sensitive),
// then punctuation/spacing twins, then location-suffix groups. A merchant
// surfaced by an earlier detector is not double-suggested by a later one.
export function allMergeSuggestions(): MergeSuggestion[] {
  const loc = mergeSuggestions();
  const covered = new Set(loc.flatMap((g) => g.variants.map((v) => v.merchant)));
  const rec = recurringMatchSuggestions(covered);
  for (const g of rec) for (const v of g.variants) covered.add(v.merchant);
  const handoff = handoffSuggestions(covered);
  for (const g of handoff) for (const v of g.variants) covered.add(v.merchant);
  const eq = nameEqualityMergeSuggestions(covered);
  const all = [...rec, ...handoff, ...eq, ...loc];
  // Confident suggestions keep their natural order; borderline ones sink to the end.
  return [...all.filter((s) => !s.lowConfidence), ...all.filter((s) => s.lowConfidence)];
}

// Approve: fold every variant into the canonical name; for a recurring-match,
// also tag any still-uncategorized variant charges with the recurring's
// category. The caller re-runs detection so recurrings regroup.
export function approveMerge(canonical: string, variants: string[], categoryId?: number) {
  const db = getDb();
  ensureMergeDismissals(db);
  const others = variants.filter((v) => v !== canonical);
  for (const v of others) linkMerchant(v, canonical);
  if (categoryId != null && others.length) {
    const ph = others.map(() => "?").join(",");
    db.prepare(
      `UPDATE transactions SET categoryId = ? WHERE merchant IN (${ph}) AND categoryId IS NULL`
    ).run(categoryId, ...others);
  }
}

// Recent charges under each given descriptor, so the queue can let the user
// eyeball whether the variants really are one vendor before combining.
export function mergePreview(
  merchants: string[],
  limit = 4
): Record<string, { date: string; amount: number; account: string }[]> {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT COALESCE(effectiveDate, date) AS date, amount, account
     FROM transactions WHERE merchant = ?
     ORDER BY COALESCE(effectiveDate, date) DESC, id DESC LIMIT ?`
  );
  const out: Record<string, { date: string; amount: number; account: string }[]> = {};
  for (const m of merchants)
    out[m] = stmt.all(m, limit) as { date: string; amount: number; account: string }[];
  return out;
}

// Dismiss: remember this suggestion's key so it never resurfaces.
export function dismissMerge(key: string) {
  const db = getDb();
  ensureMergeDismissals(db);
  db.prepare(
    "INSERT INTO merchant_merge_dismissals (canonical) VALUES (?) ON CONFLICT(canonical) DO NOTHING"
  ).run(key);
}
