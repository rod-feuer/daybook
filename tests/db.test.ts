import { detectAndConfirm, cleanDbBeforeEach, seed, months, lastMonthlyDates } from "./helpers"; // first: points the DB at a throwaway file
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb, migrateMerchants } from "../src/lib/db";
import { detectRecurrings } from "../src/lib/core";
import {
  recurringsForMonth,
  linkMerchant,
  setRecurringSetting,
  setRecurringOverride,
  setTransactionRecurringIncluded,
  setTransactionRecurringExcluded,
  startPlanKey,
  merchantSummary,
  deleteCategory,
  categoriesWithTotals,
  categorySummary,
  getBudgetsFull,
} from "../src/lib/queries";
import { applyNameCleanup, undoRenormalizeMerchants } from "../src/lib/db";
import { nameCleanupSuggestions } from "../src/lib/nameCleanup";
import { categorizeSuggestions, applyCategorization, dismissCategorize, undismissCategorize } from "../src/lib/categorizeSuggest";
import { normalizeMerchant } from "../src/lib/merchant";

cleanDbBeforeEach();

test("detects a regular monthly bill", () => {
  seed("Netflix", months(1, 6, [-19.99, -19.99, -22.99, -22.99, -22.99, -22.99]));
  const recs = detectRecurrings();
  const r = recs.find((x) => x.merchant === "Netflix");
  assert.ok(r, "Netflix should be detected");
  assert.equal(r!.cadence, "monthly");
  assert.equal(r!.count, 6);
});

test("a forced plan-change recurring uses the current cadence and price, not the all-history median/mean", () => {
  // Headspace went monthly $12.99 → annual $69.99. The plan change makes the CV
  // too high for auto-detection, so the user forces it; it must then reflect what
  // the vendor does NOW (yearly, $69.99) — not the median gap (94d → quarterly)
  // or the mean amount ($41.49) dragged down by the old monthly intro charges.
  seed("Headspace", [
    { date: "2023-10-05", amount: -12.99 },
    { date: "2023-11-05", amount: -12.99 },
    { date: "2023-12-05", amount: -12.99 },
    { date: "2024-03-08", amount: -69.99 },
    { date: "2025-03-07", amount: -69.99 },
    { date: "2026-03-07", amount: -69.99 },
  ]);
  getDb().prepare("INSERT INTO recurring_overrides (merchant, status) VALUES (?, 'force')").run("Headspace");
  const r = detectRecurrings().find((x) => x.merchant === "Headspace");
  assert.ok(r, "forced Headspace should be created");
  assert.equal(r!.cadence, "yearly", "current rhythm is annual, not the median quarterly");
  assert.equal(r!.avgAmount, -69.99, "current price, not the $41.49 mean");
  assert.equal(r!.nextDate, "2027-03-07", "next due a year after the last charge");
});

test("budget suggestion is per-active-month, not /12 (a $259 bill seen once suggests $259)", () => {
  const db = getDb();
  const catId = Number(
    db.prepare("INSERT INTO categories (name,color,icon,kind) VALUES ('Premiums','#888','🛡️','expense')").run()
      .lastInsertRowid
  );
  const month = new Date().toISOString().slice(0, 7); // within the trailing window
  db.prepare(
    "INSERT INTO transactions (date,merchant,amount,account,source,hash,categoryId) VALUES (?,?,?,?,?,?,?)"
  ).run(`${month}-15`, "Acme Life", -259, "Checking", "prem1", "prem1", catId);
  const c = categoriesWithTotals(month).find((x) => x.id === catId)!;
  assert.equal(c.suggestedBudget, 259, "one $259 active month suggests $259, not $259/12");
});

test("mid-month, the category shelf compares last month over the same days, not the whole month", () => {
  // Sep 1–27 against all of August showed a fall early in every month and
  // understated a rise late in one. A finished month still compares whole months.
  const db = getDb();
  const catId = Number(db.prepare("INSERT INTO categories (name,color,icon,kind) VALUES ('Home','#888','🏠','expense')").run().lastInsertRowid);
  const now = new Date().toISOString();
  const month = now.slice(0, 7);
  const day = Number(now.slice(8, 10));
  const [y, m] = month.split("-").map(Number);
  const ago = (n: number) => new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
  const ins = db.prepare("INSERT INTO transactions (date,merchant,amount,account,source,hash,categoryId) VALUES (?,?,?,?,?,?,?)");
  for (const [mo, tag] of [[ago(1), "a"], [ago(2), "b"]]) {
    ins.run(`${mo}-01`, "Early", -100, "Checking", "t", `${tag}1`, catId);
    ins.run(`${mo}-28`, "Late", -500, "Checking", "t", `${tag}2`, catId);
  }
  // This month's data runs through today (the dashboard's "same days" basis).
  ins.run(`${month}-${String(day).padStart(2, "0")}`, "Today", -1, "Checking", "t", "c1", catId);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cur = categorySummary(catId, month)!;
  assert.equal(cur.prevThrough, day < lastDay ? day : null);
  assert.equal(cur.prevSpent, day < 28 ? 100 : 600, `through day ${day}, the 28th counts only once it has passed`);
  const past = categorySummary(catId, ago(1))!;
  assert.equal(past.prevThrough, null);
  assert.equal(past.prevSpent, 600, "a finished month compares with the whole month before");
});

test("a plan the user marked ended isn't upcoming on its category's shelf", () => {
  // The Epic Pass, ended Sep 27, still showed "$100 due Oct 1" there.
  const cat = Number(getDb().prepare("INSERT INTO categories (name,color,icon,kind) VALUES ('Trips','#888','✈️','expense')").run().lastInsertRowid);
  const month = new Date().toISOString().slice(0, 7);
  // Monthly on the 28th through last month, so this month's is still to come.
  const dates = lastMonthlyDates(6, 28).filter((d) => d.slice(0, 7) !== month).slice(-4);
  seed("Ski Pass Co", dates.map((date) => ({ date, amount: -100 })), { categoryId: cat });
  detectAndConfirm();
  assert.equal(categorySummary(cat, month)!.upcoming.length, 1, "fixture: this month's charge is upcoming");
  setRecurringSetting("Ski Pass Co", { endedDate: new Date().toISOString().slice(0, 10) });
  assert.deepEqual(categorySummary(cat, month)!.upcoming, [], "ended: not upcoming");
});

test("mid-month, the average month leaves the unfinished month out", () => {
  // The chart's dashed line and "Avg": counting a half-spent month as a whole
  // one pulled the average down early in every month.
  const db = getDb();
  const catId = Number(db.prepare("INSERT INTO categories (name,color,icon,kind) VALUES ('Avg','#888','•','expense')").run().lastInsertRowid);
  const month = new Date().toISOString().slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const ago = (n: number) => new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
  const ins = db.prepare("INSERT INTO transactions (date,merchant,amount,account,source,hash,categoryId) VALUES (?,?,?,?,?,?,?)");
  for (let n = 1; n <= 11; n++) ins.run(`${ago(n)}-10`, "Shop", -1100, "Checking", "t", `avg${n}`, catId);
  ins.run(`${month}-01`, "Shop", -50, "Checking", "t", "avg0", catId);
  assert.equal(categorySummary(catId, month)!.monthlyAvg, 1100, "11 finished months of $1,100 average $1,100, whatever the month so far");
  assert.equal(categorySummary(catId, ago(1))!.monthlyAvg, Number(((1100 * 11) / 12).toFixed(2)), "a finished month averages its twelve");
});

test("deleting a category clears a recurring that referenced it (FK no longer blocks the delete)", () => {
  const db = getDb();
  const catId = Number(
    db.prepare("INSERT INTO categories (name,color,icon,kind) VALUES ('Temp Cat','#888','🏷️','expense')").run()
      .lastInsertRowid
  );
  // A recurring pinned to it — the foreign key that used to make the delete fail.
  db.prepare(
    "INSERT INTO recurrings (merchant,categoryId,avgAmount,cadence,lastDate,nextDate,count) VALUES ('X',?,-10,'monthly','2026-01-01','2026-02-01',3)"
  ).run(catId);
  assert.doesNotThrow(() => deleteCategory(catId), "FK no longer blocks the delete");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM categories WHERE id=?").get(catId) as { c: number }).c,
    0,
    "category is removed"
  );
  assert.equal(
    (db.prepare("SELECT categoryId FROM recurrings WHERE merchant='X'").get() as { categoryId: number | null })
      .categoryId,
    null,
    "the recurring is cleared to uncategorized"
  );
});

test("category suggestions: proposes from the vendor's history, applies (fills + learns), and dismiss hides it", () => {
  const db = getDb();
  const catId = Number(
    db.prepare("INSERT INTO categories (name, color, icon, kind) VALUES ('Books','#888','📚','expense')").run()
      .lastInsertRowid
  );
  const ins = db.prepare(
    "INSERT INTO transactions (date, merchant, amount, account, source, hash, categoryId) VALUES (?,?,?,?,?,?,?)"
  );
  ins.run("2026-01-01", "Powells Books", -20, "Checking", "ps1", "ps1", catId); // history…
  ins.run("2026-02-01", "Powells Books", -22, "Checking", "ps2", "ps2", catId);
  ins.run("2026-03-01", "Powells Books", -25, "Checking", "ps3", "ps3", null); // …and an uncategorized one

  const hit = categorizeSuggestions().suggestions.find((s) => s.merchant === "Powells Books");
  assert.ok(hit, "history yields a proposal");
  assert.equal(hit!.categoryId, catId);
  assert.equal(hit!.source, "history");
  assert.equal(hit!.count, 1, "one uncategorized row to fill");

  assert.equal(applyCategorization("Powells Books", catId), 1, "fills the uncategorized row");
  assert.equal(
    categorizeSuggestions().suggestions.find((s) => s.merchant === "Powells Books"),
    undefined,
    "nothing left to suggest"
  );

  // dismiss should hide a fresh uncategorized one
  ins.run("2026-04-01", "Powells Books", -30, "Checking", "ps4", "ps4", null);
  dismissCategorize("Powells Books");
  assert.equal(
    categorizeSuggestions().suggestions.find((s) => s.merchant === "Powells Books"),
    undefined,
    "dismissed vendor stays hidden"
  );
  // …but not for good: the queue counts it, and bringing dismissed vendors
  // back restores the proposal (declining a wrong guess once hid the vendor
  // permanently — 107 dismissals over 38 uncategorized vendors).
  assert.equal(categorizeSuggestions().dismissedCount, 1, "the queue says how many are dismissed");
  assert.equal(undismissCategorize(), 1, "one dismissal lifted");
  assert.ok(categorizeSuggestions().suggestions.find((s) => s.merchant === "Powells Books"), "back in the queue");
  assert.equal(categorizeSuggestions().dismissedCount, 0);
});

test("name-cleanup: suggests a stale name → its re-normalized form, applies just that pair, and undoes", () => {
  const db = getDb();
  const raw = "SQ *BLUE BOTTLE 0042 SAN FRANCISCO CA";
  const to = normalizeMerchant(raw);
  const ins = db.prepare(
    "INSERT INTO transactions (date, merchant, rawMerchant, amount, account, source, hash) VALUES (?,?,?,?,?,?,?)"
  );
  ins.run("2026-01-01", "Stale Coffee", raw, -5, "Checking", "test", "nc1");
  ins.run("2026-02-01", "Stale Coffee", raw, -5, "Checking", "test", "nc2");

  const hit = nameCleanupSuggestions().find((s) => s.from === "Stale Coffee");
  assert.ok(hit, "the stale name is suggested");
  assert.equal(hit!.to, to, "proposes the re-normalized form");
  assert.equal(hit!.count, 2);

  assert.equal(applyNameCleanup(db, "Stale Coffee", to), 2, "renames both rows");
  assert.equal(
    nameCleanupSuggestions().find((s) => s.from === "Stale Coffee"),
    undefined,
    "suggestion clears once applied"
  );

  assert.equal(undoRenormalizeMerchants(db), 2, "undo restores both");
  assert.ok(nameCleanupSuggestions().some((s) => s.from === "Stale Coffee"), "and the suggestion returns");
});

test("correcting a recurring's cadence re-anchors which months it's due (no second field to fix)", () => {
  seed("Gym", months(1, 6, -40, 2026)); // monthly Jan–Jun 2026, last charge June
  detectAndConfirm();
  setRecurringSetting("Gym", { cadence: "quarterly" }); // user corrects the rhythm only
  const due = (m: string) => recurringsForMonth(m).find((r) => r.merchant === "Gym")!;
  assert.equal(due("2026-06").cadence, "quarterly", "override applies");
  assert.equal(due("2026-06").expectedThisMonth, true, "anchor month (last charge) is due");
  assert.equal(due("2026-07").expectedThisMonth, false, "1 month from anchor is not a quarter");
  assert.equal(due("2026-09").expectedThisMonth, true, "3 months from anchor is");
});

test("detects a variable-amount utility (CV rule, not every-15%)", () => {
  // 90 is >15% below the mean (~108) — the old strict rule rejected this.
  seed("Duke Energy", months(1, 6, [-100, -130, -90, -115, -95, -120]));
  const r = detectRecurrings().find((x) => x.merchant === "Duke Energy");
  assert.ok(r, "variable-but-consistent monthly utility should detect");
  assert.equal(r!.cadence, "monthly");
});

test("rejects erratic discretionary spend (no cadence)", () => {
  seed("Coffee Shop", [
    { date: "2025-01-01", amount: -5 },
    { date: "2025-01-03", amount: -5 },
    { date: "2025-01-04", amount: -5 },
    { date: "2025-01-08", amount: -5 },
    { date: "2025-01-10", amount: -5 },
  ]);
  assert.equal(detectRecurrings().find((x) => x.merchant === "Coffee Shop"), undefined);
});

test("rejects wildly-variable amounts (high CV) even if monthly", () => {
  seed("Plumber", months(1, 3, [-50, -800, -200]));
  assert.equal(detectRecurrings().find((x) => x.merchant === "Plumber"), undefined);
});

test("recurringsForMonth marks the month's charge paid", () => {
  seed("Acme Sub", months(1, 6, -12.5));
  detectAndConfirm();
  const r = recurringsForMonth("2025-06").find((x) => x.merchant === "Acme Sub");
  assert.ok(r);
  assert.equal(r!.paid, true);
  assert.equal(r!.paidAmount, 12.5);
});

test("linking two descriptors merges them into one recurring", () => {
  seed("Gas A", months(1, 4, -60));
  seed("Gas B", months(5, 3, -60)); // continues the same monthly series
  linkMerchant("Gas B", "Gas A");
  const recs = detectRecurrings().filter((x) => /^Gas /.test(x.merchant));
  assert.equal(recs.length, 1, "should be a single combined recurring");
  assert.equal(recs[0].merchant, "Gas A");
  assert.equal(recs[0].count, 7);
});

test("migrateMerchants normalizes merchant and preserves the original", () => {
  seed("ALPHA BETA PPD ID: 999", months(1, 1, -10));
  migrateMerchants(getDb());
  const row = getDb()
    .prepare("SELECT merchant, rawMerchant FROM transactions LIMIT 1")
    .get() as { merchant: string; rawMerchant: string };
  assert.equal(row.merchant, "Alpha Beta");
  assert.equal(row.rawMerchant, "ALPHA BETA PPD ID: 999");
});

// WHY: a vendor that is both a store and a set of subscriptions (Apple: four
// monthly bills among one-off purchases, an iPhone included) fails the 80%
// rule that keeps a grocer from being split into "bills" — so it gets no plan.
// "Make recurring" is the user saying it IS recurring; forced, the day-parts
// are its subscriptions and the purchases stay unlinked. Before, forcing it
// made ONE weekly plan of every charge, the iPhone among them.
test("a forced vendor splits into its day-parts, leaving one-off purchases out, even below the store rule's 80%", () => {
  const subs = [
    ...months(6, 4, -9.99).map((r) => ({ ...r, date: r.date.replace(/-15$/, "-02") })),
    ...months(6, 4, -12.99).map((r) => ({ ...r, date: r.date.replace(/-15$/, "-26") })),
    ...months(6, 4, -26.74).map((r) => ({ ...r, date: r.date.replace(/-15$/, "-27") })),
  ];
  const purchases = [
    { date: "2025-06-21", amount: -5.34 },
    { date: "2025-08-04", amount: -1.06 },
    { date: "2025-08-15", amount: -22.44 },
    { date: "2025-08-17", amount: -832.46 },
    { date: "2025-08-25", amount: -21.39 },
    { date: "2025-08-16", amount: -5.49 },
    { date: "2025-09-16", amount: -5.49 },
  ];
  seed("Apple", [...subs, ...purchases]);
  const names = () => detectRecurrings().filter((r) => /^Apple/.test(r.merchant)).map((r) => `${r.merchant} ${r.avgAmount}`).sort();
  assert.deepEqual(names(), [], "12 of 19 charges in day-parts is a store, not bills: no plan on its own");

  setRecurringOverride("Apple", "force");
  assert.deepEqual(names(), ["Apple · 26th · $12.99 -12.99", "Apple · 26th · $26.74 -26.74", "Apple · 2nd -9.99"]);
  // The 12 subscription charges are linked, and the iPhone and the other
  // purchases are not — except the $21.39 of Aug 25, which the day-part rule
  // (as for any vendor) holds beside the 26th's $26.74 as a same-day bill.
  const linked = getDb().prepare("SELECT COUNT(*) AS n, ROUND(MIN(amount),2) AS biggest FROM transactions WHERE merchant = 'Apple' AND recurringId IS NOT NULL").get() as { n: number; biggest: number };
  assert.deepEqual(linked, { n: 13, biggest: -26.74 });
});

// WHY: a subscription the detector cannot see — Apple's $10.69 on the 21st,
// three charges with a skipped month between them — had no way in. "Not in plan" only removes evidence. "Start a plan" is the
// user's word: the plan exists from that charge, the vendor's other charges at
// that amount join it, and so does next month's, on its own.
test("Start a plan makes a plan from one charge; same-amount charges join it now and on later syncs", () => {
  // Apple's real shape: two subscriptions the detector splits out (the 2nd
  // and the 26th), the $10.69 on the 21st it cannot (it skipped a month, so
  // three charges don't read as monthly yet), and purchases. Forced, as the
  // owner had it.
  seed("Apple", [
    ...months(6, 3, -9.99).map((r) => ({ ...r, date: r.date.replace(/-15$/, "-02") })),
    ...months(6, 3, -12.99).map((r) => ({ ...r, date: r.date.replace(/-15$/, "-26") })),
    { date: "2025-06-21", amount: -5.34 },
    { date: "2025-06-21", amount: -10.69 },
    { date: "2025-07-21", amount: -10.69 },
    { date: "2025-09-21", amount: -10.69 },
    { date: "2025-08-17", amount: -832.46 },
    { date: "2025-08-04", amount: -1.06 },
  ]);
  setRecurringOverride("Apple", "force");
  const plans = () => detectRecurrings().filter((r) => /^Apple/.test(r.merchant)).map((r) => `${r.merchant} ${r.cadence} ${r.avgAmount} x${r.count}`).sort();
  assert.deepEqual(plans(), ["Apple · 26th monthly -12.99 x3", "Apple · 2nd monthly -9.99 x3"], "a skipped month on the 21st: no plan for the $10.69");

  const id = (getDb().prepare("SELECT id FROM transactions WHERE amount = -10.69 AND date = '2025-09-21'").get() as { id: number }).id;
  const key = startPlanKey(id)!;
  assert.equal(key, "Apple · $10.69");
  setTransactionRecurringIncluded(id, key);
  assert.deepEqual(plans(), ["Apple · $10.69 monthly -10.69 x3", "Apple · 26th monthly -12.99 x3", "Apple · 2nd monthly -9.99 x3"], "the pinned charge and the two earlier $10.69s; not the $5.34 or the iPhone");

  seed("Apple", [{ date: "2025-10-21", amount: -10.69 }]);
  assert.equal(plans()[0], "Apple · $10.69 monthly -10.69 x4", "next month's joins with no further tap — and the plan keeps its key (and so its name) once the detector can see it too");
  const linked = getDb().prepare("SELECT COUNT(*) AS n FROM transactions WHERE merchant = 'Apple' AND recurringId IS NOT NULL").get() as { n: number };
  assert.equal(linked.n, 10, "four $10.69, three $9.99, three $12.99; the $5.34, the iPhone and the $1.06 are not bills");
});

// WHY: Benjamin Franklin Plumbing bills $11.99 on the 7th for one house and,
// since August, $11.99 on the 22nd–25th for the other. The vendor is forced
// (the owner marked it recurring), so its one plan takes every unclaimed
// charge — and "Start a plan" on the 25th's charge pinned it to a key the
// detector had not emitted, the forced plan claimed the charge anyway, and the
// catch-up rule ("an auto plan holding a pinned charge IS the user's plan")
// renamed the plan of the 7th "Benjamin Franklin Pl · $11.99": one plan of
// sixteen, in place of the two the owner asked for. The rule now holds only
// when the pinned charges post on the plan's own day; otherwise they leave it
// and start theirs.
test("Start a plan on a forced vendor's off-day charge makes a second plan, not a renamed first", () => {
  const v = "Benjamin Franklin Pl";
  // Fourteen months on the 7th, then the second house's charges in the last
  // two of them, then the 7th of the month after: dated back from today, so
  // both plans still bill at any clock.
  const sevenths = lastMonthlyDates(15, 7);
  const m = (i: number) => sevenths[i].slice(0, 7);
  const aug21 = `${m(12)}-21`, aug22 = `${m(12)}-22`, sep25 = `${m(13)}-25`, oct7 = sevenths[14];
  seed(v, sevenths.slice(0, 14).map((date) => ({ date, amount: -11.99 })));
  seed(v, [{ date: aug21, amount: -89.95 }, { date: aug22, amount: -11.99 }, { date: sep25, amount: -11.99 }]);
  setRecurringOverride(v, "force");
  const plans = () => detectRecurrings().filter((r) => r.merchant.startsWith(v)).map((r) => `${r.merchant} ${r.cadence} ${r.avgAmount} x${r.count}`).sort();
  const idOf = (date: string) => (getDb().prepare("SELECT id FROM transactions WHERE merchant = ? AND date = ?").get(v, date) as { id: number }).id;
  // The owner's marks: the second house's first charges kept out of the first plan.
  setTransactionRecurringExcluded(idOf(aug21), true);
  setTransactionRecurringExcluded(idOf(aug22), true);
  assert.deepEqual(plans(), [`${v} monthly -11.99 x15`], "forced: one plan of the 7th, plus the 25th it cannot tell apart yet");

  const key = startPlanKey(idOf(sep25))!;
  assert.equal(key, `${v} · $11.99`);
  setTransactionRecurringIncluded(idOf(sep25), key);
  assert.deepEqual(plans(), [`${v} monthly -11.99 x14`, `${v} · $11.99 monthly -11.99 x1`], "two plans: the 7th keeps its name and charges; the 25th's starts its own");
  // Lifting the mark on Aug 22 (the same amount, in no plan) joins it to the new plan, not the old.
  setTransactionRecurringExcluded(idOf(aug22), false);
  assert.deepEqual(plans(), [`${v} monthly -11.99 x14`, `${v} · $11.99 monthly -11.99 x2`]);
  // The catch-up rule still holds on the plan's own day: a pinned charge on
  // the 7th belongs to the plan of the 7th, which then carries the key.
  seed(v, [{ date: oct7, amount: -11.99 }]);
  setTransactionRecurringIncluded(idOf(oct7), `${v} · Lake`);
  assert.deepEqual(plans(), [`${v} · $11.99 monthly -11.99 x2`, `${v} · Lake monthly -11.99 x15`]);
  // The keys are an amount and a name the owner typed. The shelf tells the
  // houses apart by the day each one bills, so neither has to be renamed.
  assert.deepEqual(
    merchantSummary(v).planList.map((p) => p.day).sort(),
    ["25th", "7th"]
  );
});

test("a split parent or a charge excluded from totals can't start a plan", () => {
  seed("Gym", [{ date: "2025-06-01", amount: -50 }]);
  const gym = (getDb().prepare("SELECT id, hash FROM transactions WHERE merchant = 'Gym'").get() as { id: number; hash: string });
  getDb().prepare("INSERT INTO transactions (date, merchant, amount, account, source, hash) VALUES ('2025-06-01','Gym',-50,'Checking','test',?)").run(gym.hash + ":s0");
  assert.equal(startPlanKey(gym.id), null, "a split parent: its parts are the charges");
  seed("Spa", [{ date: "2025-06-01", amount: -50 }]);
  const spa = (getDb().prepare("SELECT id FROM transactions WHERE merchant = 'Spa'").get() as { id: number });
  getDb().prepare("UPDATE transactions SET excluded = 1 WHERE id = ?").run(spa.id);
  assert.equal(startPlanKey(spa.id), null, "not counted in totals: not a bill");
});

// WHY: a vendor's shelf spoke for the vendor with ONE plan's figures (the most
// recently charged), which is right for one bill under two bank spellings and
// wrong for Apple's six subscriptions: "$128 per year" on a vendor that costs
// $790. A vendor with several plans lists them, named as the user named them,
// with what the live ones add up to; a plan's own shelf is unchanged.
test("merchantSummary lists a multi-plan vendor's plans with their monthly total; a plan's own summary does not", () => {
  // Both plans still billing at any clock: a stopped plan isn't one of the
  // vendor's plans.
  seed("Apple", [
    ...lastMonthlyDates(4, 2).map((date) => ({ date, amount: -9.99 })),
    ...lastMonthlyDates(4, 26).map((date) => ({ date, amount: -12.99 })),
  ]);
  detectRecurrings();
  setRecurringSetting("Apple · 26th", { alias: "Apple TV", expectedAmount: 14.99 });
  const v = merchantSummary("Apple");
  assert.deepEqual(v.planList.map((p) => [p.key, p.day, p.name, p.amount, p.cadence, p.ended]).sort(), [
    ["Apple · 26th", "26th", "Apple TV", 14.99, "monthly", false],
    ["Apple · 2nd", "2nd", "2nd", 9.99, "monthly", false],
  ], "the day pill tells the plans apart; the user's name stays for the plan's own shelf");
  assert.equal(v.monthly, 24.98);
  // The single-plan figures are the plan that billed last.
  const latest = lastMonthlyDates(1, 2)[0] > lastMonthlyDates(1, 26)[0] ? 9.99 : 12.99;
  assert.equal(v.recurringDetail?.perCharge, latest, "the single-plan figures are still there for a caller that wants them");

  setRecurringSetting("Apple · 26th", { endedDate: new Date().toISOString().slice(0, 10) });
  assert.equal(merchantSummary("Apple").monthly, 9.99, "an ended plan is listed but not counted");

  assert.deepEqual(merchantSummary("Apple", "Apple · 2nd").planList, [], "a plan's own shelf is about that plan");

  // A one-off older than the plan charges falls out of the mixed last-8.
  // The vendor shelf still has to show it, and a plan charge has to say which plan.
  seed("Apple", [{ date: "2024-01-02", amount: -1299 }]);
  const withStray = merchantSummary("Apple");
  assert.ok(
    withStray.otherCharges.some((c) => c.amount === -1299),
    "a one-off crowded out of Recent is listed on its own, not dropped"
  );
  assert.ok(
    withStray.recent.every((c) => c.recurringId == null || c.planDay),
    "a charge in a plan carries that plan's day"
  );
  assert.equal(merchantSummary("Apple", "Apple · 2nd").otherCharges.length, 0, "a plan's shelf pulls one-offs into its own list");
});

test("budgets move to budget_entries with every month reading as before", () => {
  // The old table held one budget per category for all time. The migration
  // must keep each budget, period included, for every month — past, current
  // and future — or opening the app would quietly re-judge history.
  const db = getDb();
  const cat = (name: string) =>
    Number(db.prepare("INSERT INTO categories (name,color,icon,kind) VALUES (?,'#888','•','expense')").run(name).lastInsertRowid);
  const groceries = cat("Groceries");
  const travel = cat("Travel");
  db.exec(`CREATE TABLE budgets (categoryId INTEGER PRIMARY KEY, amount REAL NOT NULL, period TEXT NOT NULL DEFAULT 'monthly')`);
  db.prepare("INSERT INTO budgets VALUES (?, 800, 'monthly'), (?, 6000, 'annual')").run(groceries, travel);

  db.close();
  global.__copilotDb = undefined; // reopen: init runs the migration
  const reopened = getDb();

  for (const month of ["2019-04", "2026-10", "2031-01"]) {
    assert.deepEqual(getBudgetsFull(month), {
      [groceries]: { amount: 800, period: "monthly" },
      [travel]: { amount: 6000, period: "annual" },
    }, `${month} reads the old budgets`);
  }
  const old = reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'budgets'").get();
  assert.equal(old, undefined, "the old table is gone, so nothing reads a stale copy");
});
