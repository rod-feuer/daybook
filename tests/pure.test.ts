import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMerchant, merchantKey } from "../src/lib/merchant";
import { classifyCadence, addCadence, txHash } from "../src/lib/core";
import { medianGap, monthlyFactor, CADENCE_DAYS, PER_YEAR, CADENCE_LABEL } from "../src/lib/cadence";
import { spendTrend } from "../src/lib/format";
import { seriesKey, seriesVendor, isSeriesKey } from "../src/lib/series";
import { parseCsv } from "../src/lib/import";
import { budgetOutlook, BUDGET_TOLERANCE, budgetSpent, isOverBudget } from "../src/lib/budgetOutlook";
import { buildVerdict, rangeAgainstBudget } from "../src/lib/verdict";
import { billStatus, billDelta, BILL_DELTA_MIN } from "../src/lib/bills";
import { variableStillToCome, LARGE_CHARGE, projectionBand, projectionRange } from "../src/lib/forecast";
import { canonicalMerchant } from "../src/lib/queries";
import { CATEGORY_EMOJIS } from "../src/lib/emoji";
import { createLatestGuard } from "../src/lib/latestGuard";

test("createLatestGuard discards a paged fetch superseded by a newer load", () => {
  // The transactions list relies on this: a loadMore still in flight when the
  // filter changes (a new page-1 load) must NOT append under the new filter.
  const g = createLatestGuard();

  // Page-1 load A starts; a loadMore for A rides the same generation.
  const loadA = g.begin();
  const moreA = g.current();
  assert.equal(g.isCurrent(loadA), true);
  assert.equal(g.isCurrent(moreA), true, "a loadMore rides the current result set");

  // Filter changes → page-1 load B supersedes A.
  const loadB = g.begin();
  assert.equal(g.isCurrent(loadA), false, "A's page-1 response is now stale");
  assert.equal(g.isCurrent(moreA), false, "A's in-flight loadMore must be discarded");
  assert.equal(g.isCurrent(loadB), true, "B is the live result set");

  // A loadMore for B still applies.
  assert.equal(g.isCurrent(g.current()), true);
});

test("createLatestGuard keeps only the newest of out-of-order loads", () => {
  // Two rapid filter changes: even if the first resolves last, only the second
  // may apply.
  const g = createLatestGuard();
  const first = g.begin();
  const second = g.begin();
  assert.equal(g.isCurrent(first), false, "the earlier load is superseded");
  assert.equal(g.isCurrent(second), true, "the latest load wins");
});

test("CATEGORY_EMOJIS are unique and keyword-searchable", () => {
  // Duplicate chars would collide React keys in the picker grid; uppercase
  // keywords would never match the lowercased search query.
  const chars = CATEGORY_EMOJIS.map((e) => e.char);
  assert.equal(new Set(chars).size, chars.length, "no duplicate emoji");
  for (const e of CATEGORY_EMOJIS) {
    assert.ok(e.keywords.trim().length > 0, `${e.char} must carry keywords`);
    assert.equal(e.keywords, e.keywords.toLowerCase(), "keywords must be lowercase");
  }
  // A representative search resolves to the expected glyph.
  assert.ok(
    CATEGORY_EMOJIS.some((e) => e.keywords.includes("car") && e.char === "🚗"),
    "searching 'car' surfaces 🚗"
  );
});

test("normalizeMerchant strips wallet prefixes, ids, dates; title-cases", () => {
  assert.equal(normalizeMerchant("Aplpay Target"), "Target");
  // Any short "LETTERS*" payment-gateway prefix, spaced or glued.
  assert.equal(normalizeMerchant("Mdc*south Central Indiana"), "South Central Indiana");
  assert.equal(normalizeMerchant("Sub*washpost"), "Washpost");
  assert.equal(normalizeMerchant("Ic* Instacart"), "Instacart");
  assert.equal(normalizeMerchant("McDonald's"), "Mcdonald's"); // "Mc" (no *) is not a prefix
  assert.equal(normalizeMerchant("Paypal Inst Xfer Pypl"), "Inst Xfer Pypl"); // word prefix, no *
  assert.equal(
    normalizeMerchant("JPMORGAN CHASE CHASE ACH PPD ID: 1000008113"),
    "Jpmorgan Chase Chase Ach"
  );
  assert.equal(
    normalizeMerchant("Payment to Chase card ending in 2601 06/01"),
    "Payment To Chase Card"
  );
});

test("normalizeMerchant keeps possessives readable and is idempotent", () => {
  assert.equal(normalizeMerchant("McDonald's"), "Mcdonald's");
  assert.equal(normalizeMerchant("MCDONALD'S"), "Mcdonald's");
  for (const m of ["Aplpay Culvers Of Frfranklin In", "Sofi Lending Loan Paymt", "DSW"]) {
    assert.equal(normalizeMerchant(normalizeMerchant(m)), normalizeMerchant(m));
  }
});

test("normalizeMerchant strips a bare trailing ACH channel code, keeps real words", () => {
  // The lone trailing marker is payment-rail noise, not part of the name.
  assert.equal(normalizeMerchant("CARMELCLERKTREAS WATER BILL TEL"), "Carmelclerktreas Water Bill");
  assert.equal(normalizeMerchant("Payment Thank You - Web"), "Payment Thank You");
  // Meaningful words that merely look like codes must survive.
  assert.equal(normalizeMerchant("JPMORGAN CHASE CHASE ACH"), "Jpmorgan Chase Chase Ach");
  assert.equal(normalizeMerchant("Payment to Chase Card"), "Payment To Chase Card");
  // Stacked codes all go, and the result is still idempotent.
  assert.equal(normalizeMerchant("Acme Bill Web Tel"), "Acme Bill");
  assert.equal(normalizeMerchant(normalizeMerchant("Acme Bill Web Tel")), "Acme Bill");
});

test("classifyCadence buckets gaps, rejects off-cadence", () => {
  assert.equal(classifyCadence(7), "weekly");
  assert.equal(classifyCadence(14), "biweekly");
  assert.equal(classifyCadence(30), "monthly");
  assert.equal(classifyCadence(61), "bimonthly"); // every two months: between monthly and quarterly
  assert.equal(classifyCadence(45), null);
  assert.equal(classifyCadence(91), "quarterly");
  assert.equal(classifyCadence(182), "semiannual");
  assert.equal(classifyCadence(365), "yearly");
  assert.equal(classifyCadence(50), null); // ~7 weeks: not a recognized cadence
});

test("medianGap averages the two middle gaps on an even count", () => {
  // WHY: detection and suggestion used two medians — one averaged the middles,
  // one took the upper middle — so the same four gaps could classify as monthly
  // on one path and off-cadence on the other. [20,34,36,50] is the boundary:
  // averaged → 35 (monthly's upper edge); upper-middle → 36 (rejected).
  assert.equal(medianGap([20, 34, 36, 50]), 35);
  assert.equal(classifyCadence(medianGap([20, 34, 36, 50])), "monthly");
  assert.equal(medianGap([30]), 30);
  assert.equal(medianGap([]), 0);
});

test("addCadence advances by the cadence period (UTC)", () => {
  assert.equal(addCadence("2026-01-01", "weekly"), "2026-01-08");
  assert.equal(addCadence("2026-01-01", "monthly"), "2026-02-01");
  assert.equal(addCadence("2026-01-01", "quarterly"), "2026-04-01");
  assert.equal(addCadence("2026-01-01", "semiannual"), "2026-07-01");
  assert.equal(addCadence("2026-01-01", "yearly"), "2027-01-01");
});

test("canonicalMerchant follows the link chain (cycle-safe)", () => {
  assert.equal(canonicalMerchant("A", { A: "B" }), "B");
  assert.equal(canonicalMerchant("B", { A: "B" }), "B");
  assert.equal(canonicalMerchant("A", { A: "B", B: "C" }), "C"); // chain flattens
  assert.equal(canonicalMerchant("X", { X: "X" }), "X"); // self-link doesn't loop
  assert.equal(canonicalMerchant("Z", {}), "Z");
});

test("txHash is stable and case-insensitive on merchant", () => {
  const a = txHash("2026-01-01", "Foo", -10, "Checking");
  assert.equal(a, txHash("2026-01-01", "foo", -10, "Checking"));
  assert.notEqual(a, txHash("2026-01-01", "Foo", -11, "Checking"));
});

// A model reply cut off mid-array (a 143-merchant ask at a 1,024-token cap)
// used to parse as nothing and read as "no confident suggestions". Every
// complete proposal in a cut-off reply counts; the half-written last one
// does not; a whole array still parses as one.
test("parseProposals keeps every complete proposal in a cut-off reply", async () => {
  const { parseProposals } = await import("../src/lib/categorize");
  const whole = 'Here you go: [{"merchant":"Cvs","categoryId":3},{"merchant":"Target","categoryId":5}]';
  assert.deepEqual(parseProposals(whole), [{ merchant: "Cvs", categoryId: 3 }, { merchant: "Target", categoryId: 5 }]);
  const cut = '[{"merchant":"Cvs","categoryId":3},{"merchant":"Target","categoryId":5},{"merchant":"Wal';
  assert.deepEqual(parseProposals(cut), [{ merchant: "Cvs", categoryId: 3 }, { merchant: "Target", categoryId: 5 }]);
  assert.deepEqual(parseProposals("no json here"), []);
});

// WHY: the vendor key decides which bank descriptors are one vendor — the
// shelf's roll-up, the vendor filter, and (since the detector plans by vendor)
// whether a renamed subscription's new charges continue its plan. Too loose
// and distinct payees merge ("Not recurring" on one Zelle payee once muted all
// 38); too tight and a relabel orphans its charges (Liquid IV's 2026 charges).
test("merchantKey: a relabel shares a key; payees behind a payment rail do not", () => {
  // processor and wallet prefixes are not the vendor
  assert.equal(merchantKey("Sp Liquid I.v"), merchantKey("Liquid I.v"));
  assert.equal(merchantKey("Aplpay Culvers Of Frfranklin In"), merchantKey("Culvers Of Franklin"));
  assert.equal(merchantKey("Sq *Blue Bottle"), merchantKey("Blue Bottle Coffee #1204"));
  // the payee comes AFTER a rail or fee prefix
  assert.notEqual(merchantKey("Zelle Payment To Indy K-9"), merchantKey("Zelle Payment To Rosy Cleaning"));
  assert.equal(merchantKey("Plan Fee - Ticketmaster"), merchantKey("Ticketmaster"));
  // store numbers are not identity; the first two words are
  assert.equal(merchantKey("Target 00012345"), "target");
  assert.notEqual(merchantKey("Chase Mortgage"), merchantKey("Chase Card"));
});

// WHY: every cadence the detector can emit needs a period, a per-year count and
// a label. A cadence missing from one table silently falls back (quarterly
// bills were once counted at 12x their monthly cost), and the tables must
// agree with each other: period x charges-per-year is a year.
test("cadence tables cover every cadence and agree with each other", () => {
  const cadences = Object.keys(CADENCE_DAYS);
  assert.deepEqual(Object.keys(PER_YEAR).sort(), [...cadences].sort());
  assert.deepEqual(Object.keys(CADENCE_LABEL).sort(), [...cadences].sort());
  for (const c of cadences as (keyof typeof CADENCE_DAYS)[]) {
    const year = CADENCE_DAYS[c] * PER_YEAR[c];
    assert.ok(Math.abs(year - 365) <= 6, `${c}: ${CADENCE_DAYS[c]} days x ${PER_YEAR[c]} = ${year}`);
  }
  assert.equal(monthlyFactor("bimonthly"), 0.5, "a two-month bill is half a charge a month");
  assert.equal(monthlyFactor("yearly"), 1 / 12);
  assert.equal(monthlyFactor("not-a-cadence"), 1, "unknown reads as monthly, never as zero");
});

// WHY: settings, overrides and aliases hang off a plan's key; the shelf, links
// and merge suggestions need the vendor behind it. The two must round-trip.
test("a plan's key resolves back to its vendor", () => {
  const key = seriesKey("Netflix", "23rd");
  assert.equal(isSeriesKey(key), true);
  assert.equal(seriesVendor(key), "Netflix");
  assert.equal(isSeriesKey("Netflix"), false);
  assert.equal(seriesVendor("Netflix"), "Netflix", "a bare vendor is its own vendor");
});

test("parseCsv keeps quoted commas and quotes, and ignores blank lines and CRLF", () => {
  const rows = parseCsv('Date,Name,Amount\r\n2026-03-01,"Smith, Jones ""LLC""",-12.50\r\n\r\n2026-03-02,Plain,4\n');
  assert.deepEqual(rows, [
    ["Date", "Name", "Amount"],
    ["2026-03-01", 'Smith, Jones "LLC"', "-12.50"],
    ["2026-03-02", "Plain", "4"],
  ]);
});

// WHY: a projection is an estimate, so a miss inside its own noise is not a miss.
// "$88 over" on a $42,530 budget — 0.2% — wore the same red as a real overrun,
// and the dashboard's headline shouted about nothing. Within 1% a forecast is ON
// budget. A finished month is a fact, not a forecast: $88 over is $88 over. The
// headline and the budget block both read this one function, so they can never
// disagree about which it is.
test("budgetOutlook: a forecast within 1% of the budget is on budget; a finished month is exact", () => {
  assert.equal(BUDGET_TOLERANCE, 0.01);
  assert.deepEqual(budgetOutlook(42530, 42618, true), { kind: "on", delta: 88 });
  assert.equal(budgetOutlook(42530, 42530 - 400, true).kind, "on", "and the same going under");
  assert.equal(budgetOutlook(42530, 43200, true).kind, "over", "1.6% is a real overrun");
  assert.equal(budgetOutlook(42530, 41000, true).kind, "under");
  assert.equal(budgetOutlook(42530, 42618, false).kind, "over", "once the month is done, $88 over is over");
  assert.equal(budgetOutlook(42530, 42530.4, false).kind, "on", "to the dollar");
});

// WHY: the month-end forecast drives the dashboard's headline. One daily pace for
// everything treated a $975 purchase as $51 a day for the rest of the month; but
// large purchases are not rare here either (about three a month, more than half
// of variable spend), so ignoring them under-forecasts. Everyday spending is
// paced from this month; large purchases are a monthly amount that arrives in
// lumps — expect the recent months' pace for the days left, but never more than
// what is left of a typical month once this month's own are counted. Backtested
// on 32 real months this halved the median miss (see forecast.ts).
test("variableStillToCome: everyday spending is paced; large purchases are a monthly amount that gets used up", () => {
  const history = Array.from({ length: 6 }, () => ({ large: 9000, days: 30 })); // $300 a day of large purchases, typically
  const everyday = Array.from({ length: 20 }, () => 100); // $100 a day so far
  const base = { daysElapsed: 20, daysRemaining: 10, history };
  assert.equal(LARGE_CHARGE, 1000);
  // A quiet month so far: $1,000 of everyday still to come, plus ten days of the usual large-purchase pace.
  assert.equal(variableStillToCome({ ...base, seen: everyday }), 1000 + 3000);
  // One large purchase is NOT spread over the days left — it only uses up part of the month's usual amount…
  assert.equal(variableStillToCome({ ...base, seen: [...everyday, 975 + 26] }), 1000 + 3000, "and at this size the pace is still the smaller bound");
  // …and a month that has already had most of its share expects only the rest.
  assert.equal(variableStillToCome({ ...base, seen: [...everyday, 4000, 3500] }), 1000 + 1500);
  assert.equal(variableStillToCome({ ...base, seen: [...everyday, 6000, 5000] }), 1000, "more than its share: no more expected, and never negative");
  // The old rule would have said (2000 + 11000) / 20 * 10 = 6,500 for that month.
  // A down payment is neither extrapolated nor counted against the month's usual large purchases.
  assert.equal(variableStillToCome({ ...base, seen: [...everyday, 50000] }), 1000 + 3000);
  // With no history to lean on, the old rule stands in — for a new database.
  assert.equal(variableStillToCome({ ...base, history: [], seen: [...everyday, 4000] }), 1000 + 2000);
  assert.equal(variableStillToCome({ ...base, daysRemaining: 0, seen: everyday }), 0, "a finished month has nothing still to come");
});

// WHY: these three rules were each written inside a page. The digests state
// the same facts in a message, so they live in lib, and these tests pin what
// the screens already said: a message must never disagree with the screen.
test("buildVerdict: withholds a projection it doesn't have, qualifies a forecast, and states a finished month as fact", () => {
  const base = { expenses: 3100, net: -400 };
  // too early: the budget is quoted, no month-end claim is made
  assert.deepEqual(buildVerdict({ ...base, budget: { total: 5000, spent: 800, projected: null, range: null } }, true), {
    tone: "neutral",
    text: "Too early to project the month",
  });
  // a forecast speaks in pace terms; a finished month in the past tense
  assert.equal(buildVerdict({ ...base, budget: { total: 5000, spent: 3100, projected: 4400, range: null } }, true).text, "On pace to finish $600 under budget");
  assert.deepEqual(buildVerdict({ ...base, budget: { total: 5000, spent: 5600, projected: 5600, range: null } }, false), { tone: "bad", text: "Finished $600 over budget" });
  // inside the forecast's own noise it is "on budget", with no dollar figure
  assert.equal(buildVerdict({ ...base, budget: { total: 5000, spent: 3100, projected: 5000 * (1 + BUDGET_TOLERANCE), range: null } }, true).text, "On pace to finish on budget");
  // no budgets: mid-month stays factual; a finished month calls the net
  assert.equal(buildVerdict({ ...base, budget: null }, true).text, "$3,100 spent so far this month");
  assert.equal(buildVerdict({ ...base, budget: null }, false).tone, "bad");
});

test("billStatus and billDelta: overdue is unpaid and past due; a difference under 50 cents is rounding", () => {
  assert.equal(billStatus({ paid: true, dueDate: "2026-03-01" }, "2026-03-10"), "pd");
  assert.equal(billStatus({ paid: false, dueDate: "2026-03-09" }, "2026-03-10"), "od");
  assert.equal(billStatus({ paid: false, dueDate: "2026-03-10" }, "2026-03-10"), "up", "due today is not overdue yet");
  const bill = { paid: true, dueDate: "2026-03-01", expectedAmount: 100, cadence: "monthly" as const, paidTimes: 1 };
  assert.equal(billDelta({ ...bill, paidAmount: 100 + BILL_DELTA_MIN - 0.01 }), null);
  assert.equal(billDelta({ ...bill, paidAmount: 100 + BILL_DELTA_MIN }), BILL_DELTA_MIN);
  assert.equal(billDelta({ ...bill, paidAmount: 81.46 }), 81.46 - 100, "paid less is a negative difference");
  assert.equal(billDelta({ ...bill, paid: false, paidAmount: null }), null, "an unpaid bill has no difference to report");
});

// WHY: a plan charged every week or two is paid more than once a month, and
// its paid amount is the month's sum. Held to one charge, Pay In 4's two
// $369.65 charges read "+$369.65", an overcharge that never happened. Held
// to one charge per payment, a real price change still shows.
test("billDelta holds a plan charged often to its expected amount per charge", () => {
  const payIn4 = { paid: true, dueDate: "2026-09-24", expectedAmount: 369.65, cadence: "biweekly" as const };
  assert.equal(billDelta({ ...payIn4, paidAmount: 739.3, paidTimes: 2 }), null, "two charges at the usual amount");
  const lawn = { paid: true, dueDate: "2026-09-22", expectedAmount: 63.1, cadence: "weekly" as const };
  assert.equal(billDelta({ ...lawn, paidAmount: 252.4, paidTimes: 4 }), null, "four charges at the usual amount");
  assert.equal(Number(billDelta({ ...lawn, paidAmount: 262.4, paidTimes: 4 })!.toFixed(2)), 10, "one charge $10 higher still says so");
  assert.equal(billDelta({ ...payIn4, cadence: "monthly", paidAmount: 739.3, paidTimes: 2 }), 369.65, "a monthly bill charged twice is still news");
});

test("isOverBudget: an annual budget is judged on the year so far, a monthly one on the month", () => {
  // $1,250 spent this year against $1,200 a year is over, though this month was only $100
  const annual = { budget: 1200, budgetPeriod: "annual" as const, ytdSpent: 1250, total: 100 };
  assert.equal(budgetSpent(annual), 1250);
  assert.equal(isOverBudget(annual), true);
  assert.equal(isOverBudget({ ...annual, ytdSpent: 1200 }), false, "at the budget is not over it");
  // a monthly budget ignores the year: $499 of $500 this month is fine whatever came before
  assert.equal(isOverBudget({ budget: 500, budgetPeriod: "monthly", ytdSpent: 9000, total: 499 }), false);
  assert.equal(isOverBudget({ budget: 500, budgetPeriod: "monthly", ytdSpent: 9000, total: 501 }), true);
  assert.equal(isOverBudget({ budget: null, budgetPeriod: "monthly", ytdSpent: 0, total: 999 }), false, "no budget, never over");
});

test("spendTrend: last month over the same days, and only once five days of the month have data", () => {
  // On October 1 the card said "↓ 16% vs Sep 1–1": $908 against $1,086, one
  // day each, mostly when a car payment posted. That's noise, not a trend,
  // so it waits as long as the dashboard's projection does.
  assert.equal(spendTrend(908, 1086, 1, "2026-10"), "too early to compare");
  assert.equal(spendTrend(908, 1086, 4, "2026-10"), "too early to compare");
  assert.equal(spendTrend(908, 1086, 5, "2026-10"), "↓ 16% vs Sep 1–5");
  assert.equal(spendTrend(1200, 1000, null, "2026-09"), "↑ 20% vs last month", "a finished month compares whole months");
  assert.equal(spendTrend(50, 0, 1, "2026-10"), "new this month", "nothing last month is said even early");
  assert.equal(spendTrend(0, 0, 1, "2026-10"), null);
});

import { achToLegacy } from "../src/lib/merchant";
import { nameAffinity as affinity, LOW_MATCH as LOW, NAME_MATCH as HIGH } from "../src/lib/similarity";

test("Chase's newer ACH text names the payee the way its older text did", () => {
  // WHY: the new layout ("ORIG CO NAME:… CO ENTRY DESCR:… SEC:… ORIG ID:…")
  // named every payment by its labels, so each became a new vendor; rewritten
  // into the older layout, it lands in the vendor the household already has.
  const cases: [string, string][] = [
    ["ORIG CO NAME:JPMORGAN CHASE CO ENTRY DESCR:CHASE ACH SEC:PPD ORIG ID:1000008113", "Jpmorgan Chase Chase Ach"],
    ["ORIG CO NAME:IN 529 DIR ACH CO ENTRY DESCR:CONTRIB SEC:WEB IND ID:000031915153015 ORIG ID:1356651600", "In 529 Dir Ach Contrib"],
    ["ORIG CO NAME:HUNTINGTON BANKS CO ENTRY DESCR:IL PAYMENT SEC:WEB IND ID:20069384048 ORIG ID:9000044231", "Huntington Banks Il Payment"],
    ["ORIG CO NAME:DANIEL J EDELMAN CO ENTRY DESCR:PAYMENTS SEC:CCD IND ID:EFT- ORIG ID:1234567890", "Daniel J Edelman Payments Eft"],
  ];
  for (const [raw, want] of cases) assert.equal(normalizeMerchant(raw), want, raw);
  assert.equal(
    merchantKey(normalizeMerchant("ORIG CO NAME:AMERICAN EXPRESS CO ENTRY DESCR:ACH PMT SEC:WEB IND ID:M6710 ORIG ID:2005032111")),
    merchantKey("American Express Ach"),
    "an Amex payment joins the American Express vendor"
  );
  assert.equal(achToLegacy("Spotify USA"), "Spotify USA", "other text passes through");
});

test("two payees don't look alike just because Chase labels both the same way", () => {
  // WHY: on the labels, an Amex payment scored as the Chase mortgage's vendor,
  // the merge queue offered Combine, and the payment read as the mortgage.
  const amex = "Orig Co Name:american Express Co Entry Descr:ach Pmt Sec:web Ind Id:m6710 Orig Id";
  const chase = "Orig Co Name:jpmorgan Chase Co Entry Descr:chase Ach Sec:ppd Orig Id";
  assert.ok(affinity(amex, chase) < LOW, `amex vs chase ${affinity(amex, chase)}`);
  assert.ok(affinity(chase, "Jpmorgan Chase Chase Ach") >= HIGH, "the same payee, old and new text, still matches");
});

// WHY: a projection made on day 5 missed by up to a quarter in 80% of past
// months (npm run backtest:pace). Said as one figure it claims a precision it
// hasn't got, so it's said as a range that narrows as the month fills in.
test("the projection's range narrows through the month, and never reaches below what's spent", () => {
  assert.equal(projectionBand(1, 31), projectionBand(5, 31), "before day 5, the widest band, never wider guesses");
  const days = [5, 7, 10, 15, 20, 25, 28, 30];
  const bands = days.map((d) => projectionBand(d, 31));
  assert.ok(bands.every((b, i) => i === 0 || b <= bands[i - 1]), `never wider on a later day: ${bands.map((b) => b.toFixed(3)).join(" ")}`);
  assert.equal(projectionBand(31, 31), 0, "the last day is a fact");
  assert.ok(projectionBand(12, 31) < 0.19 && projectionBand(12, 31) > 0.15, "between measured days, between their bands");
  assert.deepEqual(projectionRange(10000, 2000, 0.25), { low: 7500, high: 12500 });
  assert.equal(projectionRange(10000, 9000, 0.25).low, 9000, "money already spent can't be un-spent");
});

// WHY: green or red is a promise about where the month ends. While the range
// reaches both sides of the budget, neither is earned, so the words carry both
// ends and the colour stays neutral.
test("the verdict says the range, and takes a colour only when all of it is on one side of the budget", () => {
  const v = (low: number, high: number) =>
    buildVerdict({ expenses: 3000, net: 0, budget: { total: 10000, spent: 3000, projected: (low + high) / 2, range: { low, high } } }, true);
  assert.deepEqual(v(6000, 8000), { tone: "good", text: "On pace to finish $2,000–$4,000 under budget" });
  assert.deepEqual(v(11000, 13000), { tone: "bad", text: "On pace to finish $1,000–$3,000 over budget" });
  assert.deepEqual(v(7000, 12000), { tone: "neutral", text: "On pace to finish between $3,000 under and $2,000 over budget" });
  assert.equal(rangeAgainstBudget(10000, { low: 9960, high: 9980 }), "on budget", "a range within $50 of the budget, both ends round to it");
  assert.equal(rangeAgainstBudget(10000, { low: 6000, high: 9980 }), "up to $4,000 under budget", "one end at the budget");
  assert.equal(budgetOutlook(10000, 9500, true, { low: 8000, high: 11000 }).kind, "on", "spanning the budget is not under, though the middle is");
  // A finished month has no range: it's stated as fact, as before.
  assert.equal(buildVerdict({ expenses: 3000, net: 0, budget: { total: 10000, spent: 10600, projected: 10600, range: null } }, false).text, "Finished $600 over budget");
});
