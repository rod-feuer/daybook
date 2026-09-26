import { cleanDbBeforeEach, addCat, tx, daysAgo, daysFromNow } from "./helpers"; // first: points the DB at a throwaway file
import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  getDb,
  renormalizeMerchants,
  undoRenormalizeMerchants,
  cleanupUndoAvailable,
  ensurePlans,
} from "../src/lib/db";
import { dashboard, detectRecurrings, categorizeByHistory, categorizeByRules, learnRule } from "../src/lib/core";
import { importCsv } from "../src/lib/import";
import {
  listTransactions,
  merchantSummary,
  applyRecategorize,
  confirmPlan,
  unconfirmPlan,
  unconfirmPlansFor,
  planTookCharge,
  categoriesWithTotals,
  setRecurringSetting,
  setTransactionRecurringExcluded,
  setTransactionRecurringIncluded,
  getRecurringTxExclusions,
  getRecurringTxInclusions,
  clearRecurringTxExclusionsForMerchant,
  recurringsForMonth,
  setSeriesCategory,
  recurringMonthlyByCategory,
  isRecurringActive,
  setBudget,
  getBudgets,
  getBudgetsFull,
  setTransactionNote,
  setTransactionExcluded,
  updateCategory,
  recurringEnded,
  transactionsSummary,
  getMerchantLinks,
  canonicalMerchant,
  linkMerchant,
  setRecurringOverride,
  suggestedRecurrings,
  resetRecurringOverrides,
  getRecurringSettings,
  merchantVariants,
  upcomingRecurringExpenses,
  transactionById,
  setTransactionEffectiveDate,
  categorySummary,
} from "../src/lib/queries";
import {
  stripLocationSuffix,
  mergeSuggestions,
  recurringMatchSuggestions,
  nameEqualityMergeSuggestions,
  mergePreview,
  nameAffinity,
  NAME_MATCH,
  approveMerge,
  dismissMerge,
  handoffSuggestions,
  allMergeSuggestions,
} from "../src/lib/merges";
import { createSplitRule, applySplitRules, undoSplit, splitRulesFor, removeSplitRule } from "../src/lib/splits";
import { importPlaidTransactions, plaidSyncStartDate } from "../src/lib/plaid";

let CAT: number, CAT_INC: number, CAT_EXC: number, CAT_X: number;

before(() => {
  CAT = addCat("Groceries");
  CAT_INC = addCat("Income", "income");
  CAT_EXC = addCat("Transfers", "expense", 1); // excludeFromTotals
  CAT_X = addCat("Home");
});
cleanDbBeforeEach(["categories"]); // categories are created once in before()

test("merchantSummary carries next-due and match-rule overrides, and whether any override exists", () => {
  // WHY: the recurrings page's inline editor was the only place next-due and
  // matching could be edited. Moving them to the shelf means the shelf's data
  // must say what is set (auto vs edited) and whether "Reset all" applies.
  for (const d of ["2025-03-15", "2025-04-15", "2025-05-15"]) tx("Water Co", { amount: -40, date: d, categoryId: CAT });
  detectRecurrings();
  let s = merchantSummary("Water Co");
  assert.equal(s.nextDate, null); assert.equal(s.matchRule, null); assert.equal(s.hasSettings, false);
  setRecurringSetting("Water Co", { nextDate: "2025-06-20", matchMode: "contains", matchText: "water", amountTolerance: 0.1 });
  s = merchantSummary("Water Co");
  assert.equal(s.nextDate, "2025-06-20");
  assert.deepEqual(s.matchRule, { matchMode: "contains", matchText: "water", amountTolerance: 0.1 });
  assert.equal(s.hasSettings, true);
  setRecurringSetting("Water Co", { endedDate: "2025-06-01" });
  resetRecurringOverrides("Water Co");
  s = merchantSummary("Water Co");
  assert.equal(s.hasSettings, false, "ended is not an override; nothing else is left");
  assert.equal(s.endedDate, "2025-06-01", "and it survives the reset");
});

test("vendor variants: a payment-rail prefix is not the vendor", () => {
  // WHY: the variant key is the first two words after known prefixes. "Zelle
  // Payment To <payee>" keyed every payee to "zelle payment", so the shelf,
  // the vendor filter, recategorize, and "Not recurring" all treated 38 payees
  // as one vendor — muting one muted them all (real data, 2026-09-13). The
  // payee is what follows the rail; descriptor drift within a payee still rolls up.
  for (const m of [
    "Zelle Payment To Indy K-9 Llc",
    "Zelle Payment To Indy K-9",
    "Zelle Payment To Rosy's Cleaning",
    "Zelle Payment To Aurelio Juarez Jpm99abh1tph",
    "Zelle Payment To Aurelio Juarez Jpm99a9hjnaf",
    "Plan Fee - Ticketmast",
    "Plan Fee - Surroundings",
  ])
    tx(m, { amount: -50 });
  const sorted = (a: string[]) => [...a].sort();
  assert.deepEqual(
    sorted(merchantVariants("Zelle Payment To Indy K-9 Llc")),
    ["Zelle Payment To Indy K-9", "Zelle Payment To Indy K-9 Llc"],
    "K-9's two descriptors, and no other Zelle payee"
  );
  assert.deepEqual(
    sorted(merchantVariants("Zelle Payment To Aurelio Juarez Jpm99abh1tph")),
    ["Zelle Payment To Aurelio Juarez Jpm99a9hjnaf", "Zelle Payment To Aurelio Juarez Jpm99abh1tph"],
    "reference-suffix drift within one payee still rolls up"
  );
  assert.deepEqual(merchantVariants("Plan Fee - Ticketmast"), ["Plan Fee - Ticketmast"], "a fee is keyed by its merchant, not 'plan fee'");
});

test("merchantSummary lists descriptor names; only linked aliases are unlinkable", () => {
  linkMerchant("South Co", "Main Co");
  tx("Main Co", { amount: -10, categoryId: CAT });
  tx("South Co", { amount: -11, categoryId: CAT });

  const byName = Object.fromEntries(merchantSummary("Main Co").names.map((n) => [n.name, n]));
  assert.ok(byName["Main Co"] && byName["South Co"], "both descriptors are listed");
  assert.equal(byName["South Co"].canUnlink, true, "the linked alias can be split off");
  assert.equal(byName["Main Co"].canUnlink, false, "the primary has no link to remove");
});

test("a vendor's alias reads from the canonical merchant, whichever descriptor opened the shelf", () => {
  // WHY: per-vendor settings (alias, expected amount, cadence) belong to the
  // vendor, not the descriptor. The bug keyed them on whatever descriptor opened
  // the shelf, so opening on a folded-in variant ("Charlest") split the displayed
  // name from the saved alias — the header showed the old name and re-typing the
  // alias was a silent no-op (next === currentAlias).
  tx("Charlestons Carmel", { amount: -50, categoryId: CAT });
  tx("Charlest", { amount: -48, categoryId: CAT });
  linkMerchant("Charlest", "Charlestons Carmel"); // canonical = Charlestons Carmel
  setRecurringSetting("Charlestons Carmel", { alias: "Charleston's" });

  for (const m of ["Charlestons Carmel", "Charlest"]) {
    const s = merchantSummary(m);
    assert.equal(s.displayName, "Charleston's", `displayName must come from the canonical, via ${m}`);
    assert.equal(s.alias, "Charleston's", `alias must come from the canonical, via ${m}`);
  }
});

// WHY: Combine says "these bank names are one vendor". If the vendor was never
// renamed, its combined charges kept their own bank names in every list, so a
// combine that worked looked like one that failed ("Young Mens Chris" beside
// five "Ymca" rows, all one vendor). A combined charge is called what its
// vendor is called: the user's name for it, else the vendor's own.
test("a combined charge takes its vendor's name, whether or not the vendor was renamed", () => {
  tx("Ymca", { amount: -80, categoryId: CAT });
  tx("Young Mens Chris", { amount: -200, categoryId: CAT, hash: "new-name" });
  tx("Corner Bakery", { amount: -9, categoryId: CAT, hash: "unlinked" });
  linkMerchant("Young Mens Chris", "Ymca");
  const named = () => Object.fromEntries(listTransactions({}).map((r) => [r.merchant, r.displayName]));
  const id = (getDb().prepare("SELECT id FROM transactions WHERE hash = 'new-name'").get() as { id: number }).id;

  assert.equal(named()["Young Mens Chris"], "Ymca", "never renamed: the vendor's own name, not the charge's bank name");
  assert.equal(transactionById(id)!.displayName, "Ymca", "and the charge's shelf says the same");
  assert.equal(transactionById(id)!.merchant, "Young Mens Chris", "the bank's wording is kept, for the line under the name");
  assert.equal(named()["Corner Bakery"], "Corner Bakery", "a charge that was never combined is untouched");

  setRecurringSetting("Ymca", { alias: "YMCA" });
  assert.deepEqual([named()["Ymca"], named()["Young Mens Chris"]], ["YMCA", "YMCA"], "renamed: both take the user's name");
});

test("a per-transaction note is trimmed, isolated to its row, and cleared by whitespace", () => {
  // WHY: a generic payment vendor (Venmo) covers many unrelated purchases. A note
  // explaining one charge must attach to THAT transaction only — never bleed to
  // the vendor's other rows (the whole point of a per-transaction memo).
  tx("Venmo", { amount: -40, categoryId: CAT_EXC });
  tx("Venmo", { amount: -25, categoryId: CAT_EXC });
  const rows = listTransactions({});
  const a = rows.find((r) => r.amount === -40)!;
  const b = rows.find((r) => r.amount === -25)!;

  setTransactionNote(a.id, "  basketball coaching for my son  ");
  let after = listTransactions({});
  assert.equal(
    after.find((r) => r.id === a.id)!.note,
    "basketball coaching for my son",
    "note is saved trimmed"
  );
  assert.equal(after.find((r) => r.id === b.id)!.note, null, "the other Venmo row is untouched");

  setTransactionNote(a.id, "   ");
  after = listTransactions({});
  assert.equal(after.find((r) => r.id === a.id)!.note, null, "whitespace-only clears the note");
});

test("updateCategory changes only the attributes given, never clobbering the rest", () => {
  // WHY: setting an icon on an existing category (the only post-creation edit)
  // must not silently reset its color or name — a partial PATCH stays partial.
  const id = addCat("Cody"); // addCat seeds color "#888", icon "•"
  const read = () =>
    getDb().prepare("SELECT name, icon, color FROM categories WHERE id = ?").get(id) as {
      name: string;
      icon: string;
      color: string;
    };

  updateCategory(id, { icon: "🏀" });
  let c = read();
  assert.equal(c.icon, "🏀", "icon updated");
  assert.equal(c.color, "#888", "color untouched when only icon changes");
  assert.equal(c.name, "Cody", "name untouched");

  updateCategory(id, { color: "#ef4444" });
  c = read();
  assert.equal(c.color, "#ef4444", "color updated");
  assert.equal(c.icon, "🏀", "icon retained across a later color edit");

  updateCategory(id, {}); // empty patch is a no-op, not a wipe
  c = read();
  assert.equal(c.icon, "🏀");
  assert.equal(c.color, "#ef4444");
});

test("setTransactionExcluded drops one charge from the net, and re-including restores it", () => {
  // WHY: the per-transaction exclude is a real one-off correction (a reimbursed
  // charge), distinct from a category-wide exclude — so flagging a single row
  // must remove exactly its amount from the summary net, and unflagging must put
  // it back. A toggle that didn't reconcile would silently misstate the total.
  tx("Kroger", { amount: -100, categoryId: CAT, hash: "exA" });
  tx("Refunded Thing", { amount: -60, categoryId: CAT, hash: "exB" });
  const id = (getDb().prepare("SELECT id FROM transactions WHERE hash = 'exB'").get() as { id: number }).id;

  assert.equal(transactionsSummary({ month: "2025-06" }).net, -160, "both charges count before exclusion");
  setTransactionExcluded(id, true);
  assert.equal(transactionsSummary({ month: "2025-06" }).net, -100, "the excluded $60 drops out of net");
  assert.equal(transactionsSummary({ month: "2025-06" }).count, 2, "but it still shows in the list (count unchanged)");
  setTransactionExcluded(id, false);
  assert.equal(transactionsSummary({ month: "2025-06" }).net, -160, "re-including restores it exactly");
});

test("updateCategory kind flips how the category's rows are summed (expense↔income)", () => {
  // WHY: kind is editable as a correction, and it isn't cosmetic — an expense
  // category sums outflows, an income category sums inflows. Changing kind must
  // re-derive the total against the same rows, or the figure would lie.
  const id = addCat("Side Gig"); // seeded as expense
  tx("Client A", { amount: 800, categoryId: id, hash: "kA" }); // inflow
  tx("Stripe Fee", { amount: -20, categoryId: id, hash: "kB" }); // outflow

  const totalFor = () => categoriesWithTotals("2025-06").find((c) => c.id === id)!;
  assert.equal(totalFor().total, 20, "as an expense category it sums the outflow only");
  updateCategory(id, { kind: "income" });
  assert.equal(totalFor().kind, "income", "kind is updated");
  assert.equal(totalFor().total, 800, "as income it now sums the inflow instead");
});

test("display name resolves consistently in drawer and transactions list", () => {
  tx("Jpmorgan Chase Chase Ach", { amount: -4800, categoryId: CAT_X });
  setRecurringSetting("Jpmorgan Chase Chase Ach", { alias: "Chase Mortgage (Lake)" });
  assert.equal(merchantSummary("Jpmorgan Chase Chase Ach").displayName, "Chase Mortgage (Lake)");
  const rows = listTransactions({});
  const r = rows.find((x) => x.merchant === "Jpmorgan Chase Chase Ach");
  assert.equal(r!.displayName, "Chase Mortgage (Lake)");
});

test("paginated list returns disjoint pages; summary spans the full filtered set", () => {
  // WHY: the list is fetched page by page, so the header's count + net total
  // can't be derived from the loaded rows — the server must report them over the
  // whole filtered set, with the same excluded-aware net the dashboard uses.
  for (let i = 1; i <= 5; i++)
    tx(`Shop ${i}`, { amount: -10 * i, date: `2025-06-1${i}`, categoryId: CAT });
  tx("Transfer X", { amount: -1000, date: "2025-06-16", categoryId: CAT_EXC }); // excludeFromTotals

  const s = transactionsSummary({ month: "2025-06" });
  assert.equal(s.count, 6, "count spans every matched row, including the excluded one");
  assert.equal(s.net, -150, "net excludes the excludeFromTotals category (−10−20−30−40−50)");

  const p1 = listTransactions({ month: "2025-06", sort: "date", dir: "desc", limit: 2, offset: 0 });
  const p2 = listTransactions({ month: "2025-06", sort: "date", dir: "desc", limit: 2, offset: 2 });
  assert.equal(p1.length, 2, "first page is one page worth");
  assert.equal(p2.length, 2, "second page continues from the offset");
  assert.equal(new Set([...p1, ...p2].map((r) => r.id)).size, 4, "pages don't overlap");
});

test("excluded rows and excluded categories never count toward totals", () => {
  tx("Kroger", { amount: -100, categoryId: CAT });
  tx("Kroger", { amount: -40, categoryId: CAT, excluded: 1 }); // row-excluded
  tx("Bank Transfer", { amount: -500, categoryId: CAT_EXC }); // excludeFromTotals category
  // categoriesWithTotals filters row-level excluded (so $40 doesn't count)…
  const groceries = categoriesWithTotals("2025-06").find((c) => c.id === CAT)!;
  assert.equal(groceries.total, 100, "row-excluded $40 must not count");
  // …and the dashboard applies excludeFromTotals (so the $500 transfer is out too).
  const d = dashboard("2025-06");
  assert.equal(d.expenses, 100, "dashboard expenses excludes both row + category exclusions");
});

test("dashboard income, expenses, net, prior net and category totals are the fixture's figures", () => {
  // WHY: `net === income − expenses` recomputed from the same object only proves
  // the net formula. A fault on the income side (say `> 0` instead of `>= 0`), a
  // sign flip in prev.net, or a category keyed wrong would all survive it. Pin
  // every figure to the fixture so each has exactly one way to be right.
  tx("Paycheck", { amount: 5000, categoryId: CAT_INC });
  tx("Kroger", { amount: -120, categoryId: CAT });
  tx("Home Depot", { amount: -80, categoryId: CAT_X });
  tx("May Pay", { amount: 1000, date: "2025-05-10", categoryId: CAT_INC });
  tx("May Spend", { amount: -300, date: "2025-05-12", categoryId: CAT });
  const d = dashboard("2025-06");
  assert.equal(d.income, 5000);
  assert.equal(d.expenses, 200);
  assert.equal(d.net, 4800);
  assert.equal(d.prev!.income, 1000);
  assert.equal(d.prev!.expenses, 300);
  assert.equal(d.prev!.net, 700, "prior month net keeps its sign");
  const cat = (id: number) => d.byCategory.find((c) => c.categoryId === id)!.total;
  assert.equal(cat(CAT), 120, "groceries total keyed by category id");
  assert.equal(cat(CAT_X), 80);
});

test("in-progress month compares like-for-like against the prior month's same days", () => {
  // The viewed month is the *current* month, so its totals are month-to-date.
  // The baseline must be the prior month through the same day-of-month — else a
  // partial month is compared against a full one (the "▼ $33k vs May" bug).
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  const pm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);

  // Current month: data only through the 5th (income + expense).
  tx("Paycheck", { amount: 2000, date: `${cm}-05`, categoryId: CAT_INC });
  tx("Kroger", { amount: -100, date: `${cm}-05`, categoryId: CAT });
  // Prior month: one charge inside the first 5 days, one after — only the first
  // must count toward the baseline.
  tx("Prior Early", { amount: -70, date: `${pm}-03`, categoryId: CAT });
  tx("Prior Late", { amount: -1000, date: `${pm}-25`, categoryId: CAT });
  tx("Prior Pay", { amount: 1500, date: `${pm}-02`, categoryId: CAT_INC });

  const d = dashboard(cm);
  assert.ok(d.prev, "prev baseline exists");
  assert.equal(d.prev!.throughDay, 5, "baseline bounded to the 5th, matching MTD");
  assert.equal(d.prev!.expenses, 70, "only the prior-month charge through the 5th counts");
  assert.equal(d.prev!.income, 1500, "prior income on the 2nd is within the window");
  // The bug would have surfaced $1070 of prior expenses against $100 MTD.
  assert.notEqual(d.prev!.expenses, 1070, "must not compare against the full prior month");
});

test("a complete past month still compares full-vs-full (throughDay null)", () => {
  // 2025-06 is historical, so no MTD bounding — the whole prior month is the
  // baseline. This guards against the partial fix leaking into past months.
  tx("June Spend", { amount: -200, date: "2025-06-15", categoryId: CAT });
  tx("May Early", { amount: -80, date: "2025-05-03", categoryId: CAT });
  tx("May Late", { amount: -300, date: "2025-05-28", categoryId: CAT });

  const d = dashboard("2025-06");
  assert.ok(d.prev);
  assert.equal(d.prev!.throughDay, null, "no day-bounding for a complete month");
  assert.equal(d.prev!.expenses, 380, "full May counts (80 + 300)");
});

test("an annual budget tracks calendar-YTD spend, not a single month, and reads as monthly-equivalent", () => {
  // WHY: a once-a-year-ish bill (e.g. a $259/mo policy paid in lumps) budgeted
  // annually must be judged on the whole year's spend — comparing this month's
  // charge to a $3,108 annual cap would always look wildly under budget. The top
  // summary, which compares a single month, instead needs the annual cap divided
  // back to a monthly-equivalent so every budget sits on one basis.
  const year = new Date().getUTCFullYear();
  const cat = addCat("Life Insurance");
  tx("Northwestern Mutual", { amount: -259, date: `${year}-01-15`, categoryId: cat });
  tx("Northwestern Mutual", { amount: -259, date: `${year}-03-15`, categoryId: cat });
  tx("Northwestern Mutual", { amount: -259, date: `${year - 1}-11-15`, categoryId: cat }); // prior year

  setBudget(cat, 3108, "annual"); // 259 × 12

  assert.deepEqual(getBudgetsFull()[cat], { amount: 3108, period: "annual" }, "full config keeps the period");
  assert.equal(getBudgets()[cat], 259, "single-month consumers see the annual cap ÷ 12");

  const row = categoriesWithTotals(`${year}-03`).find((c) => c.id === cat)!;
  assert.equal(row.budget, 3108, "the row carries the full annual amount");
  assert.equal(row.budgetPeriod, "annual");
  assert.equal(row.total, 259, "month total is still the viewed month's single charge");
  assert.equal(row.ytdSpent, 518, "calendar-YTD sums this year's charges only; last year is excluded");
});

test("recurringEnded: ended only until a charge lands after the end date (auto-heal)", () => {
  assert.equal(recurringEnded(null, "2026-06-10"), false, "no end date set");
  assert.equal(recurringEnded("2026-06-12", "2026-05-10"), true, "last charge before the end date");
  assert.equal(recurringEnded("2026-06-12", "2026-06-12"), true, "charge on the end date still counts as ended");
  assert.equal(
    recurringEnded("2026-06-12", "2026-07-01"),
    false,
    "a charge AFTER the end date reactivates — never hide a real future charge"
  );
});

test("ending a subscription drops it from expected outflow immediately, and reactivates on a later charge", () => {
  // WHY: a canceled subscription keeps inflating expected spend until it ages out
  // (~1.5 cycles). Marking it ended must remove it from the recurring outflow NOW,
  // while keeping history — and a charge after the end date must bring it back.
  const M = "Streamflix";
  // Dates are relative to now, not pinned: the first assertion only means
  // something while the bill is still active, and pinned dates age past that
  // window and start failing on a date nobody chose.
  const lastCharge = daysAgo(5);
  for (const d of [daysAgo(95), daysAgo(65), daysAgo(35), lastCharge])
    tx(M, { amount: -16, date: d, categoryId: CAT });
  detectRecurrings();
  const active = recurringMonthlyByCategory()[CAT] ?? 0;
  assert.ok(active >= 16, `expected the bill to count while active, got ${active}`);

  setRecurringSetting(M, { endedDate: daysAgo(4) }); // after the last charge → ended
  assert.equal(
    recurringMonthlyByCategory()[CAT] ?? 0,
    0,
    "an ended subscription stops counting toward expected outflow"
  );

  setRecurringSetting(M, { endedDate: daysAgo(6) }); // before the last charge → resubscribed
  assert.ok(
    (recurringMonthlyByCategory()[CAT] ?? 0) >= 16,
    "a charge after the end date reactivates the bill"
  );
});

test("Reset all clears overrides but keeps a subscription ended", () => {
  // WHY: "Reset all" on the recurrings page means "forget my tuning" — rename,
  // amount, cadence, matching. It used to send every field to null, including
  // endedDate, so resetting a canceled subscription silently reactivated it and
  // its amount reappeared in expected outflow. Ended is a fact, not a tuning.
  const M = "Streamflix";
  for (const d of [daysAgo(95), daysAgo(65), daysAgo(35), daysAgo(5)])
    tx(M, { amount: -16, date: d, categoryId: CAT });
  detectRecurrings();
  setRecurringSetting(M, { alias: "Stream Flix", expectedAmount: 18, endedDate: daysAgo(4) });
  assert.equal(recurringMonthlyByCategory()[CAT] ?? 0, 0, "ended → not counted");

  resetRecurringOverrides(M);
  const s = getRecurringSettings()[M];
  assert.equal(s.alias, null, "rename cleared");
  assert.equal(s.expectedAmount, null, "expected amount cleared");
  assert.equal(s.endedDate, daysAgo(4), "ended date survives a reset");
  assert.equal(
    recurringMonthlyByCategory()[CAT] ?? 0,
    0,
    "a reset must not reactivate a canceled subscription"
  );
});

test("an excluded charge is not evidence of a bill and never joins a series", () => {
  // WHY: split parents are excluded (their parts count) and land on the same
  // day as their children. Fed to the detector, the zero-day gaps pulled the
  // median down and a monthly bill read as biweekly — 2.17× its real monthly
  // share in the category baseline (Chubb, real data). Transfers and reimbursed
  // one-offs the user excluded are the same class: not spending, not a bill.
  for (const d of [daysAgo(95), daysAgo(65), daysAgo(35), daysAgo(5)]) {
    tx("Gym", { amount: -50, date: d, categoryId: CAT });
    tx("Gym", { amount: -120, date: d, categoryId: CAT, excluded: 1 }); // same-day excluded twin
  }
  detectRecurrings();
  const rec = getDb().prepare("SELECT cadence, avgAmount FROM recurrings WHERE merchant = 'Gym'").get() as { cadence: string; avgAmount: number };
  assert.equal(rec.cadence, "monthly", "same-day excluded rows must not halve the gaps");
  assert.equal(rec.avgAmount, -50, "the excluded amounts are not part of the bill");
  const members = getDb().prepare("SELECT excluded, recurringId FROM transactions WHERE merchant = 'Gym'").all() as { excluded: number; recurringId: number | null }[];
  assert.ok(members.filter((m) => m.excluded).every((m) => m.recurringId == null), "excluded rows are not series members");
  assert.ok(members.filter((m) => !m.excluded).every((m) => m.recurringId != null), "posted rows are");
});

test("a series' last and next due follow the effective date, like every reader of it", () => {
  // WHY: the user moves a charge that posts on the 31st into the next month on
  // purpose. Paid-matching and the month views judge it there; the detector
  // alone used the posted date, so "last charge" and "next due" sat on a
  // different calendar from the months the bill was counted in.
  tx("Lake Mortgage", { amount: -4800, date: "2025-03-31", effectiveDate: "2025-04-01", categoryId: CAT_X });
  tx("Lake Mortgage", { amount: -4800, date: "2025-04-30", effectiveDate: "2025-05-01", categoryId: CAT_X });
  tx("Lake Mortgage", { amount: -4800, date: "2025-05-31", effectiveDate: "2025-06-01", categoryId: CAT_X });
  detectRecurrings();
  const rec = getDb().prepare("SELECT cadence, lastDate, nextDate FROM recurrings WHERE merchant = 'Lake Mortgage'").get() as { cadence: string; lastDate: string; nextDate: string };
  assert.equal(rec.cadence, "monthly");
  assert.equal(rec.lastDate, "2025-06-01", "last charge on the effective calendar");
  assert.equal(rec.nextDate, "2025-07-01", "next due one period on from it");
});

test("a series that has gone quiet is not an upcoming bill, even with a next-due override", () => {
  // WHY: the category baseline, the shelf, and the recurrings page all apply
  // isRecurringActive; the dashboard's upcoming list (and the month-end spend
  // projection it feeds) did not. A stale series normally falls out of the
  // window on its own, but a user-set next-due or cadence override could put
  // it back — so the projection counted a bill that had stopped.
  // Live: monthly, last charged 5 days ago. Quiet: monthly, last charged 200 days ago.
  for (const d of [95, 65, 35, 5]) tx("Power Co", { amount: -100, date: daysAgo(d), categoryId: CAT });
  for (const d of [290, 260, 230, 200]) tx("Old Box", { amount: -30, date: daysAgo(d), categoryId: CAT });
  detectRecurrings();
  // Both get a next-due override 10 days from now, inside the window.
  setRecurringSetting("Power Co", { nextDate: daysFromNow(10) });
  setRecurringSetting("Old Box", { nextDate: daysFromNow(10) });
  const names = upcomingRecurringExpenses(daysFromNow(1), daysFromNow(30)).map((u) => u.merchant);
  assert.ok(names.includes("Power Co"), "a live series with a due date in the window is upcoming");
  assert.ok(!names.includes("Old Box"), "a quiet series is not, whatever its override says");
});

test("a quarterly bill counts one third per month toward the category baseline", () => {
  // WHY: the baseline feeds the dashboard bar marker and the budget suggestion.
  // A cadence missing from the monthly-factor table silently fell back to 1×,
  // so a $300 quarterly bill was counted as $300 every month (3× too high)
  // and a semiannual one 6× too high. Every cadence the detector can emit must
  // have an explicit per-month factor.
  for (const d of [daysAgo(275), daysAgo(184), daysAgo(93), daysAgo(2)]) // 91-day gaps → quarterly
    tx("Water District", { amount: -300, date: d, categoryId: CAT });
  for (const d of [daysAgo(366), daysAgo(184), daysAgo(2)]) // 182-day gaps → semiannual
    tx("Car Insurance", { amount: -600, date: d, categoryId: CAT_X });
  detectRecurrings();
  const byCat = recurringMonthlyByCategory();
  assert.equal(byCat[CAT], 100, "quarterly $300 → $100/month, not $300");
  assert.equal(byCat[CAT_X], 100, "semiannual $600 → $100/month, not $600");
});

test("marking a vendor not-recurring clears its per-charge one-off exclusions", () => {
  // WHY: a muted vendor has no series, so a lingering "excluded from the series"
  // flag is a ghost marker on the charge (the Jimmy John's bug). Muting must
  // clear it — which is what the override route now does for each variant.
  tx("Jimmy Johns", { amount: -12, date: "2026-03-03", categoryId: CAT, hash: "jj-x" });
  const id = listTransactions({}).find((r) => r.hash === "jj-x")!.id;
  setTransactionRecurringExcluded(id, true);
  assert.equal(
    listTransactions({}).find((r) => r.id === id)!.recurringExcluded,
    1,
    "charge starts flagged as a one-off"
  );

  clearRecurringTxExclusionsForMerchant("Jimmy Johns");
  assert.equal(
    listTransactions({}).find((r) => r.id === id)!.recurringExcluded,
    0,
    "the stale exclusion is cleared, so no ghost 'excluded' marker remains"
  );
});

test("forcing recurring on a linked alias marks the whole canonical vendor", () => {
  // WHY: overrides are stored under the descriptor the user clicked, but
  // detection groups by canonical merchant. A force set on a linked alias must
  // still create the recurring and link every descriptor's charges — before the
  // fix, byMerchant.get(<alias>) missed the canonical group and silently did
  // nothing (the user's "mark recurring" appeared to fail).
  tx("Jimmy Johns", { amount: -12, date: "2026-01-05", categoryId: CAT });
  tx("Jimmy John's", { amount: -13, date: "2026-02-09", categoryId: CAT }); // alias descriptor
  linkMerchant("Jimmy John's", "Jimmy Johns"); // canonical = "Jimmy Johns"
  setRecurringOverride("Jimmy John's", "force"); // user clicked the ALIAS row

  detectRecurrings();

  const rows = getDb()
    .prepare("SELECT recurringId FROM transactions WHERE merchant IN ('Jimmy Johns', 'Jimmy John''s')")
    .all() as { recurringId: number | null }[];
  assert.equal(rows.length, 2, "both descriptor charges are present");
  assert.ok(
    rows.every((r) => r.recurringId != null),
    "both descriptors' charges link to the forced recurring"
  );
  const recs = getDb()
    .prepare("SELECT COUNT(*) n FROM recurrings WHERE merchant = 'Jimmy Johns'")
    .get() as { n: number };
  assert.equal(recs.n, 1, "exactly one recurring, on the canonical merchant");
});

test("a lumpy recurring bill is not amplified into the budget projection", () => {
  // The classic false-precision bug: a mortgage paid on the 1st, run-rated by a
  // few elapsed days, balloons the month-end projection. The fix projects only
  // *variable* spend and adds scheduled recurring — so the already-paid mortgage
  // is counted once, not multiplied out.
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  setBudget(CAT_X, 4500);
  // A detected recurring whose next charge already fell on the 1st (outside the
  // remaining-days window, so it adds nothing to the projection's scheduled part).
  const recId = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES ('Mortgage', @cat, -4000, 'monthly', @d, @d, 6)`
      )
      .run({ cat: CAT_X, d: `${cm}-01` }).lastInsertRowid
  );
  tx("Mortgage", { amount: -4000, date: `${cm}-01`, categoryId: CAT_X, recurringId: recId });
  tx("Hardware Store", { amount: -100, date: `${cm}-10`, categoryId: CAT_X });

  const d = dashboard(cm);
  assert.ok(d.budget, "budget summary exists");
  assert.equal(d.budget!.spent, 4100, "spent = mortgage + variable");
  assert.ok(d.budget!.projected != null, "past MIN_ELAPSED_DAYS, a projection is shown");
  // Naive run-rate (4100 × daysInMonth / 10) would project ~$12k and scream "over".
  // Correct: 4100 + run-rate of the $100 variable spend ≈ $4.3k, comfortably under.
  assert.ok(
    d.budget!.projected! < 4400,
    `expected a projection near actuals, got ${d.budget!.projected}`
  );
  assert.ok(d.budget!.projected! < d.budget!.total, "must not falsely project over budget");
});

test("the budget projection is withheld until enough of the month has elapsed", () => {
  // Two days of data can't support a run-rate; show nothing rather than a number
  // the dashboard can't stand behind. (null → UI renders "too early to project".)
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  setBudget(CAT, 1000);
  tx("Kroger", { amount: -50, date: `${cm}-02`, categoryId: CAT });

  const d = dashboard(cm);
  assert.ok(d.budget);
  assert.equal(d.budget!.spent, 50);
  assert.equal(d.budget!.projected, null, "no projection on day 2");
});

test("a complete past month projects to its actuals, not a run-rate", () => {
  setBudget(CAT, 1000);
  tx("Kroger", { amount: -300, date: "2025-06-10", categoryId: CAT });
  const d = dashboard("2025-06");
  assert.ok(d.budget);
  assert.equal(d.budget!.projected, d.budget!.spent, "finished month: projection = actuals");
});

test("a suggestion reflects a user-set name and expected amount", () => {
  const dates = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"];
  [-30, -300, -50, -250].forEach((a, i) => tx("Foo Utility", { amount: a, date: dates[i], categoryId: CAT }));
  setRecurringSetting("Foo Utility", { alias: "Foo", expectedAmount: 120 });

  const s = suggestedRecurrings().find((x) => x.merchant === "Foo Utility");
  assert.ok(s, "still a suggestion");
  assert.equal(s!.displayName, "Foo", "the user's name (alias) is the display name");
  assert.equal(s!.avgAmount, -120, "the expected amount overrides the detected average");
});

test("same-vendor variable-amount suggestions cluster into one with aliases", () => {
  // Two descriptors of one vendor (a renamed seasonal utility), both regular-but-
  // variable so neither auto-confirms — should suggest as ONE entry.
  const dates = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"];
  const amts = [-30, -300, -50, -250]; // high CV → "variable" suggestion
  const mk = (m: string) => amts.forEach((a, i) => tx(m, { amount: a, date: dates[i], categoryId: CAT }));
  mk("Acme Power Bill One");
  mk("Acme Power Bill Two");

  const sugg = suggestedRecurrings().filter((s) => s.merchant.startsWith("Acme Power Bill"));
  assert.equal(sugg.length, 1, "the two descriptors cluster into one suggestion");
  assert.equal(sugg[0].aliases.length, 1, "the other descriptor folds in as an alias");
  assert.equal(sugg[0].count, 8, "counts combine across descriptors");
});

test("an inactive recurring does not claim another vendor's charge by category fallback", () => {
  const cm = new Date().toISOString().slice(0, 7);
  // A long-stale recurring (last charged ~2 years ago) in category CAT.
  getDb()
    .prepare(
      `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
       VALUES ('Old Salon', @cat, -60, 'monthly', '2024-01-15', '2024-02-15', 12)`
    )
    .run({ cat: CAT });
  // A current-month charge: same category + amount, DIFFERENT vendor.
  tx("New Place", { amount: -60, date: `${cm}-15`, categoryId: CAT });

  const old = recurringsForMonth(cm).find((r) => r.merchant === "Old Salon");
  assert.ok(old, "the stale recurring still appears (it'll sit in Inactive)");
  assert.equal(old!.paid, false, "stale recurring is NOT falsely marked paid via category fallback");
});

test("upcoming bills appear on the current month only, never on a past one", () => {
  // "Upcoming · next 14 days" is a today-relative forecast: each recurring has a
  // single forward nextDate, so it must not bleed into a month being reviewed.
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  const soon = new Date(now.getTime());
  soon.setUTCDate(soon.getUTCDate() + 3); // within the 14-day window
  const nd = soon.toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
       VALUES ('Netflix', @cat, -15.99, 'monthly', @nd, @nd, 6)`
    )
    .run({ cat: CAT, nd });

  const cur = dashboard(cm);
  assert.ok(cur.upcoming.count >= 1, "current month surfaces the upcoming bill");

  // A past month is a closed book — the forecast must be empty there, not show
  // next week's bills.
  const past = dashboard("2024-01");
  assert.equal(past.upcoming.count, 0, "past month shows no upcoming bills");
  assert.equal(past.upcoming.items.length, 0);
  assert.equal(past.upcoming.total, 0);
});

test("isRecurringActive: live within ~1.5 cycles of its last charge, dead beyond", () => {
  // WHY: the window is `period × 1.5 + 5` days. Fixtures far from the edge
  // (9d, 130d) let the constants drift — 1.0×, 2.0×, +0 all passed. Bracket
  // each edge by one day so a changed multiplier or grace fails here.
  const now = Date.UTC(2026, 5, 10); // 2026-06-10
  // Monthly window = 30*1.5+5 = 50 days.
  assert.equal(isRecurringActive("2026-06-02", "monthly", now), true, "9 days → active");
  assert.equal(isRecurringActive("2026-04-22", "monthly", now), true, "49 days → still active");
  assert.equal(isRecurringActive("2026-04-20", "monthly", now), false, "51 days → inactive");
  assert.equal(isRecurringActive("2026-02-01", "monthly", now), false, "130 days → inactive");
  // Weekly window = 7*1.5+5 = 15.5 days.
  assert.equal(isRecurringActive("2026-06-05", "weekly", now), true, "5 days → active");
  assert.equal(isRecurringActive("2026-05-26", "weekly", now), true, "15 days → still active");
  assert.equal(isRecurringActive("2026-05-25", "weekly", now), false, "16 days → inactive");
  assert.equal(isRecurringActive("2026-05-20", "weekly", now), false, "21 days → inactive");
});

test("categorizeByHistory reuses a vendor's dominant past category across linked descriptors", () => {
  linkMerchant("Calico Corners Cityindy In", "Calico Corners");
  tx("Calico Corners", { amount: -100, categoryId: CAT });
  tx("Calico Corners Cityindy In", { amount: -200, categoryId: CAT });
  tx("Calico Corners", { amount: -50, categoryId: CAT_X }); // one-off in another category

  // A new uncategorized charge under the same vendor → dominant past category.
  assert.equal(categorizeByHistory("Calico Corners"), CAT, "2 of 3 → dominant category wins");
  assert.equal(categorizeByHistory("Totally New Vendor"), null, "no history → no guess");

  // A 50/50 split is not a confident signal.
  tx("Split Vendor", { amount: -10, categoryId: CAT });
  tx("Split Vendor", { amount: -10, categoryId: CAT_X });
  assert.equal(categorizeByHistory("Split Vendor"), null, "no clear majority → no guess");
});

test("a charge joining a categorized recurring inherits the recurring's modal category", () => {
  // Three categorized monthly charges + a newest one that's uncategorized (e.g.
  // it posted under a new descriptor with no matching rule).
  tx("Acme Utility", { amount: -50, date: daysAgo(90), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: daysAgo(60), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: daysAgo(30), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: daysAgo(0), categoryId: null });

  const r = detectRecurrings().find((x) => x.merchant === "Acme Utility");
  assert.ok(r, "the series is detected");
  assert.equal(r!.categoryId, CAT, "recurring category is the modal, not the latest (null) charge");
  const newest = getDb()
    .prepare("SELECT categoryId FROM transactions WHERE merchant=? ORDER BY date DESC LIMIT 1")
    .get("Acme Utility") as { categoryId: number | null };
  assert.equal(newest.categoryId, CAT, "the uncategorized member inherited the recurring's category");
});

test("a stale (renamed/stopped) recurring stops counting toward the category baseline", () => {
  // When a vendor is renamed its descriptor drifts to a new merchant and the old
  // recurring goes silent. The category recurring baseline must drop the dead
  // series, or it double-counts with its successor — the Better Bodies / Better
  // Bodies Inc gym bug, where one $59 membership read as $145. This is the same
  // active filter the shelf's "upcoming this month" already applies.
  const ins = (merchant: string, amt: number, lastOffset: number) =>
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?, ?, ?, 'monthly', ?, ?, 6)`
      )
      .run(merchant, CAT_X, amt, daysAgo(lastOffset), daysAgo(lastOffset));
  ins("Gym Inc", -59, 5); // live: charged 5 days ago
  ins("Gym", -52, 200); // dead: renamed away, silent for 200 days

  const byCat = recurringMonthlyByCategory();
  assert.equal(
    byCat[CAT_X],
    59,
    "only the active recurring counts; the stale duplicate is dropped"
  );
});

test("a recurring spanning linked descriptors dates from the globally latest charge", () => {
  // Canonical is "Zzz Vendor"; the most recent charge posts under the
  // alphabetically EARLIER alias "Aaa Vendor". Detection groups by canonical, and
  // the SELECT is ordered (merchant, date) — so without a per-group date sort the
  // series ends on the alias's older charge and lastDate/gaps are wrong.
  linkMerchant("Aaa Vendor", "Zzz Vendor");
  tx("Zzz Vendor", { amount: -50, date: "2026-01-01", categoryId: CAT });
  tx("Zzz Vendor", { amount: -50, date: "2026-02-01", categoryId: CAT });
  tx("Zzz Vendor", { amount: -50, date: "2026-03-01", categoryId: CAT });
  tx("Aaa Vendor", { amount: -50, date: "2026-04-01", categoryId: CAT });

  const recs = detectRecurrings();
  const r = recs.find((x) => x.merchant === "Zzz Vendor");
  assert.ok(r, "the linked descriptors form one recurring");
  assert.equal(r!.count, 4, "all four charges across both descriptors are counted");
  assert.equal(r!.lastDate, "2026-04-01", "lastDate is the globally latest charge, not the alias's");
});

test("nameAffinity matches vendor renames but rejects distinct same-prefix vendors", () => {
  const same = (a: string, b: string) => nameAffinity(a, b) >= NAME_MATCH;
  // Descriptor drift for one vendor → match (prefix / punctuation / Jaro-Winkler).
  assert.ok(same("Gap Outletcom", "Gapoutlet.com"), "spacing/punctuation twin");
  assert.ok(same("Duke Energy", "Dukeenergy Bill Pay"), "appended junk suffix");
  assert.ok(same("Upgrade", "Upgrade, Inc. Payment"), "subset of tokens");
  assert.ok(same("Netflix", "Netflix.com"));
  // Distinct vendors that merely share a prefix must NOT match — the old 6-char
  // prefix rule wrongly matched these on "carmel".
  assert.ok(!same("Carmel Dental", "Carmel Clay Schools"), "shared city prefix is not a match");
  assert.ok(!same("Jimmy Johns", "Benjamin Franklin Pl"));
  assert.ok(!same("Wendys", "Arbys"));
});

test("recurring-match picks the renamed vendor by name, not a same-amount decoy", () => {
  const last = daysAgo(28); // recurring's last charge 28 days ago → active monthly
  const mkRec = (merchant: string) =>
    Number(
      getDb()
        .prepare(
          `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(merchant, CAT, -100, "monthly", last, daysAgo(-2), 3).lastInsertRowid
    );
  const rid = mkRec("Acme Power Bill");
  tx("Acme Power Bill", { amount: -100, date: daysAgo(88), categoryId: CAT, recurringId: rid });
  tx("Acme Power Bill", { amount: -105, date: daysAgo(58), categoryId: CAT, recurringId: rid });
  tx("Acme Power Bill", { amount: -100, date: last, categoryId: CAT, recurringId: rid });
  // A decoy bill: same amount and cadence, unrelated name.
  const did = mkRec("Zeta Water");
  tx("Zeta Water", { amount: -100, date: last, categoryId: CAT, recurringId: did });
  // The orphan: a new descriptor for Acme, uncategorized, posting ~1 month later.
  tx("Acme Power", { amount: -102, date: daysAgo(0), categoryId: null });

  const g = recurringMatchSuggestions(new Set()).find((x) =>
    x.variants.some((v) => v.merchant === "Acme Power")
  );
  assert.ok(g, "the orphan charge is matched to a recurring");
  assert.equal(g!.canonical, "Acme Power Bill", "matched by name, not the same-amount Zeta decoy");
  assert.equal(g!.categoryId, CAT, "carries the recurring's category for the approve step");
});

test("a borderline name match surfaces as a low-confidence suggestion", () => {
  const last = daysAgo(28);
  const rid = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run("Metro Fibernet L Metfibenet", CAT, -93, "monthly", last, daysAgo(-2), 2).lastInsertRowid
  );
  tx("Metro Fibernet L Metfibenet", { amount: -93, date: daysAgo(58), categoryId: CAT, recurringId: rid });
  tx("Metro Fibernet L Metfibenet", { amount: -93, date: last, categoryId: CAT, recurringId: rid });
  // Orphan "Metronet" scores ~0.84 against "Metro Fibernet…" — same vendor to a
  // human, below the 0.9 auto-bar.
  tx("Metronet", { amount: -93, date: daysAgo(0), categoryId: null });

  const g = recurringMatchSuggestions(new Set()).find((x) =>
    x.variants.some((v) => v.merchant === "Metronet")
  );
  assert.ok(g, "the borderline match is still surfaced");
  assert.equal(g!.lowConfidence, true, "0.8–0.9 band → flagged low-confidence, not auto-applied");
});

test("multiple stray descriptors of one vendor collapse into a single suggestion", () => {
  const last = daysAgo(28);
  const rid = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run("Upgrade, Inc. Payment", CAT, -100, "monthly", last, daysAgo(-2), 3).lastInsertRowid
  );
  tx("Upgrade, Inc. Payment", { amount: -100, date: daysAgo(58), categoryId: CAT, recurringId: rid });
  tx("Upgrade, Inc. Payment", { amount: -100, date: last, categoryId: CAT, recurringId: rid });
  // Two different stray descriptors, both Upgrade, both posting this cycle.
  tx("Upgrade", { amount: -100, date: daysAgo(1), categoryId: null });
  tx("Upgrade, Inc. Co Entry Descr", { amount: -100, date: daysAgo(2), categoryId: null });

  const s = recurringMatchSuggestions(new Set());
  const up = s.filter((g) => g.canonical === "Upgrade, Inc. Payment");
  assert.equal(up.length, 1, "the two strays form ONE card, not two");
  assert.equal(up[0].dismissKeys.length, 2, "dismissing the card remembers both descriptors");
  assert.ok(
    up[0].variants.some((v) => v.merchant === "Upgrade") &&
      up[0].variants.some((v) => v.merchant === "Upgrade, Inc. Co Entry Descr"),
    "both strays are listed as variants to fold in"
  );
});

test("approving a recurring-match links the orphan and fills its missing category", () => {
  tx("Acme Power", { amount: -102, date: "2026-06-10", categoryId: null });
  approveMerge("Acme Power Bill", ["Acme Power", "Acme Power Bill"], CAT);
  assert.equal(
    canonicalMerchant("Acme Power", getMerchantLinks()),
    "Acme Power Bill",
    "orphan descriptor linked to the vendor"
  );
  const row = getDb()
    .prepare("SELECT categoryId FROM transactions WHERE merchant = ?")
    .get("Acme Power") as { categoryId: number | null };
  assert.equal(row.categoryId, CAT, "the uncategorized orphan was tagged with the recurring's category");
});

test("plaid sync reconciles a pending charge against its posted twin, sparing coincidences", () => {
  // Plaid returns both versions of a charge mid-transition (different ids, drifted
  // name). The pending Gap twin should be dropped; two coincidental $11.99 charges
  // from different vendors must both survive.
  const item = {
    accounts: [{ account_id: "a1", name: "Amex Gold" }],
    transactions: [
      { transaction_id: "g-posted", account_id: "a1", date: "2026-06-07", name: "Gapoutlet.com", merchant_name: "Gapoutlet.com", amount: -53.47, pending: false },
      { transaction_id: "g-pending", account_id: "a1", date: "2026-06-07", name: "Gap Outletcom", merchant_name: "Gap Outletcom", amount: -53.47, pending: true },
      { transaction_id: "jj-pending", account_id: "a1", date: "2026-06-09", name: "Jimmy Johns", merchant_name: "Jimmy Johns", amount: 11.99, pending: true },
      { transaction_id: "bf-posted", account_id: "a1", date: "2026-06-10", name: "Benjamin Franklin Pl", merchant_name: "Benjamin Franklin Pl", amount: 11.99, pending: false },
    ],
  };
  const res = importPlaidTransactions([item]);
  const all = getDb()
    .prepare("SELECT amount, pending FROM transactions WHERE source='plaid'")
    .all() as { amount: number; pending: number }[];

  assert.equal(res.reconciled, 1, "the pending Gap twin is reconciled away");
  assert.equal(all.length, 3, "4 pulled, 1 pending duplicate dropped");
  assert.equal(all.filter((r) => r.amount === 53.47).length, 1, "only the posted Gap refund remains");
  assert.equal(all.find((r) => r.amount === 53.47)!.pending, 0, "and it's the posted one");
  assert.equal(all.filter((r) => r.amount === -11.99).length, 2, "both coincidental $11.99 charges survive");
  assert.equal(all.filter((r) => r.pending === 1).length, 1, "only the un-twinned pending remains");
});

test("a category set on a pending Plaid charge survives the next sync and follows it to posted", () => {
  // WHY: a category the user set on a still-pending charge must survive the
  // next sync (the "Asymmetrically won't keep its category" bug, when pending
  // rows were wiped and recreated) and must follow the charge onto its posted
  // twin (a new transaction_id) so it isn't lost at the pending→posted
  // transition either.
  const pendingPull = {
    accounts: [{ account_id: "a1", name: "Checking" }],
    transactions: [
      { transaction_id: "asym-pending", account_id: "a1", date: "2026-06-12", name: "Asymmetrically", merchant_name: "Asymmetrically", amount: 10, pending: true },
    ],
  };
  importPlaidTransactions([pendingPull]);
  // User categorizes the pending charge.
  getDb().prepare("UPDATE transactions SET categoryId = ? WHERE hash = 'asym-pending'").run(CAT);

  // Sync again — the still-pending charge comes back and is re-wiped/re-imported.
  importPlaidTransactions([pendingPull]);
  const resync = getDb()
    .prepare("SELECT categoryId, pending FROM transactions WHERE hash = 'asym-pending'")
    .get() as { categoryId: number; pending: number };
  assert.equal(resync.categoryId, CAT, "category is retained across the pending wipe");
  assert.equal(resync.pending, 1, "and the charge is still pending");

  // The charge posts: Plaid returns the posted version (new id) alongside the
  // still-pending one mid-transition; the pending twin reconciles away.
  const postedPull = {
    accounts: [{ account_id: "a1", name: "Checking" }],
    transactions: [
      { transaction_id: "asym-posted", account_id: "a1", date: "2026-06-13", name: "Asymmetrically", merchant_name: "Asymmetrically", amount: 10, pending: false },
      { transaction_id: "asym-pending", account_id: "a1", date: "2026-06-12", name: "Asymmetrically", merchant_name: "Asymmetrically", amount: 10, pending: true },
    ],
  };
  importPlaidTransactions([postedPull]);
  const posted = getDb()
    .prepare("SELECT categoryId FROM transactions WHERE hash = 'asym-posted'")
    .get() as { categoryId: number };
  const pendingGone = getDb()
    .prepare("SELECT COUNT(*) n FROM transactions WHERE hash = 'asym-pending'")
    .get() as { n: number };
  assert.equal(posted.categoryId, CAT, "category follows the charge onto its posted twin");
  assert.equal(pendingGone.n, 0, "the pending row is reconciled away");
});

// WHY: the app holds transaction ids in an open page — a tapped charge fetches
// by id. Pending rows were wiped and re-inserted on every sync, so a pending
// charge came back under a new id and a tap in the seconds after launch (while
// the launch sync ran) got a 404: "Couldn't load this charge". And every row
// the pull contained counted as "updated", so the launch toast read
// "Synced 0 new · 1002 updated" when nothing had changed.
test("plaid sync keeps a pending charge's id, and counts updated only when something changed", () => {
  const pull = (amount: number) => ({
    accounts: [{ account_id: "a1", name: "Checking" }],
    transactions: [
      { transaction_id: "mh-pending", account_id: "a1", date: "2026-09-18", name: "Massage Heights", merchant_name: "Massage Heights", amount, pending: true },
      { transaction_id: "cc-posted", account_id: "a1", date: "2026-09-17", name: "Classic Cleaners", merchant_name: "Classic Cleaners", amount: 175.15, pending: false },
    ],
  });
  const first = importPlaidTransactions([pull(59.99)]);
  assert.deepEqual([first.inserted, first.updated], [2, 0]);
  const id = (getDb().prepare("SELECT id FROM transactions WHERE hash = 'mh-pending'").get() as { id: number }).id;

  const again = importPlaidTransactions([pull(59.99)]);
  assert.deepEqual([again.inserted, again.updated], [0, 0], "the same pull changes nothing");
  assert.equal((getDb().prepare("SELECT id FROM transactions WHERE hash = 'mh-pending'").get() as { id: number }).id, id, "the pending row keeps its id");

  const changed = importPlaidTransactions([pull(64.99)]);
  assert.deepEqual([changed.inserted, changed.updated], [0, 1], "an amount change is one update");
  assert.equal((getDb().prepare("SELECT id FROM transactions WHERE hash = 'mh-pending'").get() as { id: number }).id, id, "still the same row");
});

test("a pending charge Plaid stops returning is dropped, its category carried to the posted row that replaced it", () => {
  const pending = {
    accounts: [{ account_id: "a1", name: "Checking" }],
    transactions: [
      { transaction_id: "mh-pending", account_id: "a1", date: "2026-09-18", name: "Massage Heights", merchant_name: "Massage Heights", amount: 59.99, pending: true },
    ],
  };
  importPlaidTransactions([pending]);
  getDb().prepare("UPDATE transactions SET categoryId = ? WHERE hash = 'mh-pending'").run(CAT);
  // The next pull carries only the posted version, under a new id.
  const posted = {
    accounts: [{ account_id: "a1", name: "Checking" }],
    transactions: [
      { transaction_id: "mh-posted", account_id: "a1", date: "2026-09-19", name: "Massage Heights", merchant_name: "Massage Heights", amount: 59.99, pending: false },
    ],
  };
  const res = importPlaidTransactions([posted]);
  assert.equal(res.inserted, 1);
  const rows = getDb().prepare("SELECT hash, categoryId FROM transactions WHERE source = 'plaid'").all() as { hash: string; categoryId: number | null }[];
  assert.deepEqual(rows, [{ hash: "mh-posted", categoryId: CAT }], "one row: the posted charge, with the category the user set while it was pending");
});

test("mergePreview returns each descriptor's recent charges, newest first", () => {
  tx("Foo Bar", { amount: -5, date: "2026-01-01", categoryId: CAT, account: "Visa" });
  tx("Foo Bar", { amount: -6, date: "2026-03-01", categoryId: CAT, account: "Visa" });
  tx("Foo-bar", { amount: -7, date: "2026-02-01", categoryId: CAT, account: "Amex" });

  const pv = mergePreview(["Foo Bar", "Foo-bar"], 5);
  assert.equal(pv["Foo Bar"].length, 2, "each descriptor keyed separately");
  assert.equal(pv["Foo Bar"][0].date, "2026-03-01", "newest charge first");
  assert.equal(pv["Foo-bar"][0].account, "Amex", "carries the account for eyeballing");
});

test("normalized-equality groups punctuation/spacing twins under the common spelling", () => {
  tx("Jimmy Johns", { amount: -10, categoryId: CAT });
  tx("Jimmy Johns", { amount: -10, categoryId: CAT });
  tx("Jimmy John's", { amount: -11, categoryId: CAT });
  tx("Unrelated Cafe", { amount: -5, categoryId: CAT });

  const s = nameEqualityMergeSuggestions(new Set());
  const g = s.find((x) => x.variants.some((v) => v.merchant === "Jimmy John's"));
  assert.ok(g, "the apostrophe/no-apostrophe twins are grouped");
  assert.equal(g!.canonical, "Jimmy Johns", "canonical is the more common spelling");
  assert.equal(g!.variants.length, 2);
  assert.ok(
    !s.some((x) => x.variants.some((v) => v.merchant === "Unrelated Cafe")),
    "a vendor with no twin is never suggested"
  );
});

test("stripLocationSuffix peels a trailing City ST, keeps specific names, rejects the rest", () => {
  assert.equal(stripLocationSuffix("Crew Carwash - Westfcarmel In"), "Crew Carwash");
  assert.equal(stripLocationSuffix("Turf Kings Carmel In"), "Turf Kings");
  assert.equal(stripLocationSuffix("The Gardcarmel In"), null, "prefix too short → no collapse to 'The'");
  assert.equal(stripLocationSuffix("Kroger"), null, "no location suffix");
  assert.equal(stripLocationSuffix("Acme Widgets Go"), null, "trailing token is not a US state");
});

test("merge suggestions group location-suffix variants and honor dismissal", () => {
  tx("Turf Kings Carmel In", { amount: -80, categoryId: CAT });
  tx("Turf Kings Fishers In", { amount: -80, categoryId: CAT });
  tx("Turf Kings", { amount: -80, categoryId: CAT });
  tx("Kroger", { amount: -20, categoryId: CAT });

  const g = mergeSuggestions().find((x) => x.canonical === "Turf Kings");
  assert.ok(g, "a Turf Kings merge is suggested");
  assert.equal(g!.variants.length, 3, "both location descriptors + the clean name grouped");
  assert.ok(
    !mergeSuggestions().some((x) => x.canonical === "Kroger"),
    "a lone merchant is never suggested"
  );

  dismissMerge("Turf Kings");
  assert.ok(
    !mergeSuggestions().some((x) => x.canonical === "Turf Kings"),
    "a dismissed group does not resurface"
  );
});

test("approving a merge folds the descriptors into one vendor and clears the suggestion", () => {
  tx("Turf Kings Carmel In", { amount: -80, categoryId: CAT });
  tx("Turf Kings Fishers In", { amount: -80, categoryId: CAT });
  tx("Turf Kings", { amount: -80, categoryId: CAT });

  approveMerge("Turf Kings", ["Turf Kings Carmel In", "Turf Kings Fishers In", "Turf Kings"]);
  const links = getMerchantLinks();
  assert.equal(canonicalMerchant("Turf Kings Carmel In", links), "Turf Kings");
  assert.equal(canonicalMerchant("Turf Kings Fishers In", links), "Turf Kings");
  assert.ok(
    !mergeSuggestions().some((x) => x.canonical === "Turf Kings"),
    "once linked, the group is no longer suggested"
  );
});

// Simulate already-imported rows: backfill rawMerchant = merchant, as the
// original import-time migration would have, so renormalize (not the first-pass
// backfill) is what re-cleans them.
function backfillRaw() {
  getDb().prepare("UPDATE transactions SET rawMerchant = merchant WHERE rawMerchant IS NULL").run();
}

test("renormalize re-cleans existing rows from their preserved original", () => {
  // A row imported before the normalizer learned to drop a trailing channel code.
  tx("Carmel Water Bill Tel", { amount: -78, categoryId: CAT });
  backfillRaw();
  const changed = renormalizeMerchants(getDb());
  assert.ok(changed >= 1, "the stale name was refreshed");
  const row = getDb()
    .prepare("SELECT merchant, rawMerchant FROM transactions WHERE rawMerchant = 'Carmel Water Bill Tel'")
    .get() as { merchant: string; rawMerchant: string };
  assert.equal(row.merchant, "Carmel Water Bill", "the channel code is gone");
  assert.equal(row.rawMerchant, "Carmel Water Bill Tel", "original is preserved (reversible)");
});

test("renormalize carries a user's alias onto the renamed merchant", () => {
  tx("Acme Bill Web", { amount: -20, categoryId: CAT });
  backfillRaw();
  setRecurringSetting("Acme Bill Web", { alias: "Acme Subscription" }); // aliased pre-cleanup
  renormalizeMerchants(getDb());
  const moved = getDb()
    .prepare("SELECT alias FROM recurring_settings WHERE merchant = 'Acme Bill'")
    .get() as { alias: string } | undefined;
  assert.equal(moved?.alias, "Acme Subscription", "alias followed the rename");
  const orphan = getDb()
    .prepare("SELECT 1 FROM recurring_settings WHERE merchant = 'Acme Bill Web'")
    .get();
  assert.equal(orphan, undefined, "no setting left stranded on the old name");
});

test("undo restores the pre-cleanup names (not the raw descriptor) and aliases", () => {
  // Prior name differs from both the raw descriptor and the cleaned form, so we
  // can prove undo restores the *previous* name, not just merchant = rawMerchant.
  tx("Acme Bill Stale", { amount: -20, categoryId: CAT });
  getDb()
    .prepare("UPDATE transactions SET rawMerchant = 'ACME BILL WEB' WHERE merchant = 'Acme Bill Stale'")
    .run();
  setRecurringSetting("Acme Bill Stale", { alias: "Acme Subscription" });

  const changed = renormalizeMerchants(getDb());
  assert.ok(changed >= 1);
  assert.equal(cleanupUndoAvailable(getDb()), true, "undo available after a cleanup");
  assert.ok(
    getDb().prepare("SELECT 1 FROM transactions WHERE merchant = 'Acme Bill'").get(),
    "cleanup applied"
  );

  const restored = undoRenormalizeMerchants(getDb());
  assert.equal(restored, changed, "every changed row was restored");
  const row = getDb()
    .prepare("SELECT merchant FROM transactions WHERE rawMerchant = 'ACME BILL WEB'")
    .get() as { merchant: string };
  assert.equal(row.merchant, "Acme Bill Stale", "the prior name is back, not the raw descriptor");
  const s = getDb()
    .prepare("SELECT alias FROM recurring_settings WHERE merchant = 'Acme Bill Stale'")
    .get() as { alias: string } | undefined;
  assert.equal(s?.alias, "Acme Subscription", "alias keyed back to the restored name");
  assert.equal(cleanupUndoAvailable(getDb()), false, "undo is consumed once applied");
});

test("a charge can be excluded from its recurring without muting the whole vendor", () => {
  // Five regular monthly charges → one recurring series.
  for (const d of ["2025-01-15", "2025-02-15", "2025-03-15", "2025-04-15", "2025-05-15"])
    tx("Acme Sub", { amount: -100, date: d, categoryId: CAT });
  detectRecurrings();
  const before = getDb()
    .prepare("SELECT id, date, recurringId FROM transactions WHERE merchant='Acme Sub' ORDER BY date")
    .all() as { id: number; date: string; recurringId: number | null }[];
  assert.ok(before.every((r) => r.recurringId != null), "all five start stamped recurring");

  // Flag the last charge as a one-off; the series stays intact for the rest.
  const last = before[before.length - 1];
  setTransactionRecurringExcluded(last.id, true);
  detectRecurrings();
  const after = getDb()
    .prepare("SELECT id, recurringId FROM transactions WHERE merchant='Acme Sub'")
    .all() as { id: number; recurringId: number | null }[];
  assert.equal(after.find((r) => r.id === last.id)!.recurringId, null, "the flagged charge is no longer recurring");
  assert.equal(after.filter((r) => r.recurringId != null).length, 4, "the other four remain recurring");
  const rec = getDb()
    .prepare("SELECT count FROM recurrings WHERE merchant='Acme Sub'")
    .get() as { count: number };
  assert.equal(rec.count, 4, "the series stats reflect only the four kept charges");

  // Add it back; it rejoins the series.
  setTransactionRecurringExcluded(last.id, false);
  detectRecurrings();
  const restored = getDb()
    .prepare("SELECT recurringId FROM transactions WHERE id=?")
    .get(last.id) as { recurringId: number | null };
  assert.ok(restored.recurringId != null, "re-included charge is recurring again");
});

test("auto-split children carry the rule's exact signed amounts and categories; the parent is excluded", () => {
  // WHY: summing |amount| would pass even if the children came out as inflows
  // (a dropped minus at the insert), and a wrong categoryId would move money
  // to the wrong bar with the total still reconciling. Assert each child
  // exactly: sign, amount, category, in rule order.
  createSplitRule("chubb", 1115.55, [
    { categoryId: CAT_X, amount: 847.75, label: "Home" },
    { categoryId: CAT, amount: 267.8, label: "Other" },
  ]);
  tx("Chubb Insurance", { amount: -1115.55, categoryId: CAT_X });
  applySplitRules();
  const children = getDb()
    .prepare("SELECT amount, categoryId, merchant FROM transactions WHERE hash LIKE '%:s%' ORDER BY hash")
    .all() as { amount: number; categoryId: number; merchant: string }[];
  assert.deepEqual(
    children.map((c) => [c.amount, c.categoryId, c.merchant]),
    [
      [-847.75, CAT_X, "Chubb Insurance — Home"],
      [-267.8, CAT, "Chubb Insurance — Other"],
    ]
  );
  const parent = getDb()
    .prepare("SELECT excluded FROM transactions WHERE merchant = 'Chubb Insurance' AND hash NOT LIKE '%:s%'")
    .get() as { excluded: number };
  assert.equal(parent.excluded, 1);
});

test("a pending charge is not split until it posts", () => {
  // WHY: a sync replaces a pending row (remove + add). If the pending row had
  // been split, it comes back un-excluded while its child rows survive, and
  // the charge counts twice. Found by splitting the newest row in a real DB
  // copy and letting the launch sync run. Rules wait for the posted row.
  createSplitRule("chubb", 1115.55, [
    { categoryId: CAT_X, amount: 847.75, label: "Home" },
    { categoryId: CAT, amount: 267.8, label: "Other" },
  ]);
  tx("Chubb Insurance", { amount: -1115.55, categoryId: CAT_X });
  getDb().prepare("UPDATE transactions SET pending = 1 WHERE merchant = 'Chubb Insurance'").run();
  assert.equal(applySplitRules(), 0, "pending: left alone");
  getDb().prepare("UPDATE transactions SET pending = 0 WHERE merchant = 'Chubb Insurance'").run();
  assert.equal(applySplitRules(), 1, "posted: split");
});

test("undo split removes the children, restores the parent, and deletes the rule", () => {
  // WHY: a split persists a rule that re-splits every future matching charge.
  // Without an inverse, one mistaken split is permanent. Undo must reverse all
  // three effects — otherwise the parent double-counts (excluded + children
  // gone), or the next sync silently re-splits it from the surviving rule.
  createSplitRule("chubb", 1115.55, [
    { categoryId: CAT_X, amount: 847.75, label: "Home" },
    { categoryId: CAT, amount: 267.8, label: "Other" },
  ]);
  tx("Chubb Insurance", { amount: -1115.55, categoryId: CAT_X });
  const before = dashboard("2025-06").expenses;
  applySplitRules();
  assert.equal(dashboard("2025-06").expenses, before, "a split moves money between categories, not the total");
  const parent = listTransactions({ month: "2025-06" }).find((r) => r.merchant === "Chubb Insurance")!;
  assert.equal(parent.splitParts, 2, "the list knows the parent is split");
  assert.equal(parent.excluded, 1);
  const children = () =>
    getDb().prepare("SELECT amount FROM transactions WHERE hash LIKE '%:s%'").all() as { amount: number }[];
  assert.ok(children().every((c) => c.amount < 0), "children are outflows like their parent");

  assert.equal(undoSplit(parent.id), 1, "one parent restored");
  assert.equal(children().length, 0, "child rows gone");
  const after = listTransactions({ month: "2025-06" }).find((r) => r.id === parent.id)!;
  assert.equal(after.excluded, 0, "parent counts again");
  assert.equal(after.splitParts, 0);
  const rules = getDb().prepare("SELECT COUNT(*) AS n FROM split_rules").get() as { n: number };
  assert.equal(rules.n, 0, "rule gone");
  assert.equal(dashboard("2025-06").expenses, before, "total unchanged through split and undo");
  assert.equal(applySplitRules(), 0, "nothing re-splits on the next sync");
  assert.equal(undoSplit(parent.id), 0, "nothing left to undo");
});

test("effectiveDate overrides the accounting month (COALESCE everywhere)", () => {
  // Posted in March, but accounted to April.
  tx("Lake Mortgage", { amount: -4800, date: "2025-03-31", effectiveDate: "2025-04-01", categoryId: CAT_X });
  assert.equal(listTransactions({ month: "2025-04" }).length, 1, "shows in April");
  assert.equal(listTransactions({ month: "2025-03" }).length, 0, "not in March");
});

test("duplicate transaction hash is rejected (dedup invariant)", () => {
  tx("Once", { amount: -10, hash: "dup" });
  assert.throws(() => tx("Again", { amount: -10, hash: "dup" }));
});

test("empty month produces finite figures, not NaN, and never throws", () => {
  tx("Solo", { amount: -10, date: "2025-06-15", categoryId: CAT });
  // A month with no transactions at all.
  const d = dashboard("2030-01");
  for (const n of [d.income, d.expenses, d.net])
    assert.ok(Number.isFinite(n), `expected finite, got ${n}`);
  // projectedMonthEnd is intentionally null when it can't forecast — just never NaN.
  assert.ok(d.pace.projectedMonthEnd === null || Number.isFinite(d.pace.projectedMonthEnd));
  assert.doesNotThrow(() => recurringsForMonth("2030-01"));
  for (const c of categoriesWithTotals("2030-01"))
    assert.ok(Number.isFinite(c.total) && Number.isFinite(c.recurringBaseline));
});

// The month view folds descriptor-drift clones of ONE bill into a single row.
// It must never fold two different vendors that merely share a category and a
// price band: on real data Hulu ($19.99) swallowed 27 other $15–$20
// subscriptions, and X Corp ($40) swallowed the $38.99 WSJ the moment it was
// categorized Subscriptions — the bill vanished from the page and its charge
// then "paid" X Corp. A fold requires the same vendor: a shared coarse vendor
// key, or a user Combine (merchant link).
test("recurrings dedupe folds only clones of the same vendor, not same-price neighbours", () => {
  const subs = addCat("Subscriptions");
  const ins = getDb().prepare(
    `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
     VALUES (?, ?, ?, 'monthly', ?, ?, ?)`
  );
  ins.run("X Corp. Paid Featurebastrop", subs, -40, "2026-08-31", "2026-09-30", 20);
  ins.run("D J*wsj", subs, -38.99, "2026-05-25", "2026-06-25", 19); // WSJ, the bank's old descriptor
  ins.run("D J", subs, -38.99, "2026-08-18", "2026-09-18", 3); // WSJ since the bank changed it
  ins.run("Michaeljburry.substasaratoga", subs, -39, "2026-08-11", "2026-09-11", 10);
  ins.run("Willywoo.substack.cocentral Hk", subs, -39, "2026-08-26", "2026-09-26", 7);
  ins.run("Chase Mortgage", subs, -40, "2026-08-01", "2026-09-01", 6); // distinct name, Combined below
  ins.run("Chase Home Lending", subs, -40, "2026-08-01", "2026-09-01", 4);
  linkMerchant("Chase Home Lending", "Chase Mortgage");

  const rows = recurringsForMonth("2026-09");
  assert.deepEqual(
    rows.map((r) => r.merchant).sort(),
    ["Chase Mortgage", "D J*wsj", "Michaeljburry.substasaratoga", "Willywoo.substack.cocentral Hk", "X Corp. Paid Featurebastrop"],
    "same-vendor clones fold (D J → D J*wsj by key, Chase by link); different vendors in the same price band all stay"
  );

  // The fold is a merge: the face keeps its key but takes the newest clone's
  // last/next charge and the combined count — otherwise the face's own stale
  // lastDate (May) files a bill that charged in August under "Inactive".
  const wsj = rows.find((r) => r.merchant === "D J*wsj")!;
  assert.equal(wsj.lastDate, "2026-08-18", "face carries the newest clone's last charge");
  assert.equal(wsj.dueDate, "2026-09-18", "due day follows the live descriptor's charges");
  assert.equal(wsj.count, 22, "history is the sum of the clones");
  assert.equal(wsj.paid, false);

  // A charge on the newer key pays the face (exact match through the fold, not
  // the loose category+amount fallback).
  tx("D J", { amount: -38.99, date: "2026-09-18", categoryId: subs });
  const paid = recurringsForMonth("2026-09").find((r) => r.merchant === "D J*wsj")!;
  assert.equal(paid.paid, true, "the clone's charge counts as the face's payment");
  assert.equal(paid.paidAmount, 38.99);
});

// One bank descriptor, two monthly bills. Netflix charges $26.99 on the 23rd
// and on the 26th (one account per home); grouped by descriptor the detector
// read that as one bill, so the page showed one Netflix and counted the second
// charge as an overpayment. Sofi is the same shape with different amounts (the
// mortgage on the 1st, a loan on the 21st) and came out as a "$2,902 biweekly"
// that is neither payment. Two monthly plans keep their days of the month;
// that is what separates them from one true biweekly bill, which drifts.
test("detector splits a descriptor that carries two monthly bills into one series per day", () => {
  const subs = addCat("Streaming");
  const home = addCat("Lake House");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 8; m++) {
    tx("Netflix", { amount: -26.99, date: `${ym(m)}-23`, categoryId: subs });
    tx("Netflix", { amount: -26.99, date: `${ym(m)}-26`, categoryId: home });
  }
  for (let m = 1; m <= 8; m++) {
    tx("Sofi", { amount: -4453.91, date: `${ym(m)}-01`, categoryId: home });
    if (m >= 4) tx("Sofi", { amount: -1350.95, date: `${ym(m)}-21`, categoryId: subs });
  }
  // A true biweekly plan: 14-day steps drift through the month — one series.
  const start = Date.UTC(2026, 0, 3);
  for (let i = 0; i < 12; i++)
    tx("Gym", { amount: -25, date: new Date(start + i * 14 * 86_400_000).toISOString().slice(0, 10), categoryId: subs });
  // A bill whose day moved (8th, then 22nd) never overlaps itself — one series.
  for (let m = 1; m <= 4; m++) tx("Water", { amount: -40, date: `${ym(m)}-08`, categoryId: home });
  for (let m = 5; m <= 8; m++) tx("Water", { amount: -40, date: `${ym(m)}-22`, categoryId: home });
  // Two policies billed the same day are one bill (one event, summed); the
  // 17th policy is another. A weekend slip (1st → 3rd) stays in its cluster.
  for (let m = 1; m <= 6; m++) {
    const d = m === 3 ? "03" : "01";
    tx("Chubb", { amount: -494.75, date: `${ym(m)}-${d}`, categoryId: home });
    tx("Chubb", { amount: -494.75, date: `${ym(m)}-${d}`, categoryId: home, account: "Savings" });
    tx("Chubb", { amount: -544.94, date: `${ym(m)}-17`, categoryId: home });
  }

  // Two 529 contributions, $200 and $300, on the 18th each month (one per
  // account) — same day, different amounts: two bills, keyed by amount. July's
  // pair posted on the 20th (weekend slip, within the cluster's two days). Two
  // deposits of different amounts on a payday are two paychecks, split alike.
  // Real posting days: 16th, 17th, 18th, 18th, 20th … — the 20th is a weekend
  // slip two days past a cluster that began on the 16th; it must still join.
  for (let m = 1; m <= 8; m++) {
    const d = m === 1 ? "16" : m === 2 ? "17" : m === 7 ? "20" : "18";
    tx("In 529 Dir Ach Contrib", { amount: -200, date: `${ym(m)}-${d}`, categoryId: home });
    tx("In 529 Dir Ach Contrib", { amount: -300, date: `${ym(m)}-${d}`, categoryId: home, account: "Savings" });
    tx("Payroll", { amount: 9738.55, date: `${ym(m)}-15`, categoryId: home });
    tx("Payroll", { amount: 7553.94, date: `${ym(m)}-15`, categoryId: home, account: "Savings" });
  }

  // Two policies of different amounts on the 1st, three months, plus a pair
  // that posted a month early on the 31st: two same-day plans that together
  // hold most of the charges are the bills; the early pair stays unlinked.
  for (const d of ["2026-01-31", "2026-03-01", "2026-04-01", "2026-05-03"]) {
    tx("Chubb Prs", { amount: -259.75, date: d, categoryId: home });
    tx("Chubb Prs", { amount: -729.75, date: d, categoryId: home, account: "Savings" });
  }

  // A grocery store visited every few days lands in every day-bucket month
  // after month; that is one variable vendor, not a stack of monthly bills.
  const g0 = Date.UTC(2026, 0, 2);
  for (let i = 0; i < 60; i++)
    tx("Market District", { amount: -(40 + ((i * 37) % 90)), date: new Date(g0 + i * 4 * 86_400_000).toISOString().slice(0, 10), categoryId: home });

  const recs = detectRecurrings();
  const by = (m: string) => recs.find((r) => r.merchant === m);
  assert.ok(!recs.some((r) => r.merchant.startsWith("Market District · ")), "a weekly store never splits into monthly bills");
  assert.deepEqual(
    recs.map((r) => r.merchant).filter((m) => !m.startsWith("Market District")).sort(),
    ["Chubb Prs · $259.75", "Chubb Prs · $729.75", "Chubb · 17th", "Chubb · 1st", "Gym", "In 529 Dir Ach Contrib · $200", "In 529 Dir Ach Contrib · $300", "Netflix · 23rd", "Netflix · 26th", "Payroll · $7,553.94", "Payroll · $9,738.55", "Sofi · 1st", "Sofi · 21st", "Water"],
    "two bills per descriptor become two series; a drifting biweekly and a bill that changed its day stay one"
  );
  assert.equal(by("Chubb · 1st")!.avgAmount, -989.5, "same-day charges are one event, summed");
  assert.equal(by("Chubb · 1st")!.count, 6, "count is events (months), not charges");
  assert.equal(by("Chubb · 17th")!.avgAmount, -544.94);
  assert.equal(by("In 529 Dir Ach Contrib · $200")!.count, 8, "the weekend slip on the 20th is a member");
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE merchant = 'In 529 Dir Ach Contrib' AND recurringId IS NULL").get() as { n: number }).n,
    0,
    "no 529 charge is left unlinked"
  );
  assert.equal(by("In 529 Dir Ach Contrib · $300")!.avgAmount, -300);
  assert.equal(by("Payroll · $9,738.55")!.count, 8, "two deposits of different amounts on a payday are two paychecks");
  assert.equal(by("Payroll · $7,553.94")!.avgAmount, 7553.94);

  assert.equal(by("Chubb Prs · $729.75")!.count, 3, "the early pair on the 31st is not a member");
  assert.equal(by("Gym")!.cadence, "biweekly");
  assert.equal(by("Water")!.cadence, "monthly");
  assert.equal(by("Netflix · 23rd")!.count, 8);
  assert.equal(by("Netflix · 26th")!.categoryId, home, "each series carries its own charges' category");
  assert.equal(by("Sofi · 1st")!.avgAmount, -4453.91, "each series has its own amount, not the blend");
  assert.equal(by("Sofi · 21st")!.avgAmount, -1350.95);
  assert.equal(by("Sofi · 21st")!.count, 5);

  // Charges link to the series they belong to (by row, not by descriptor).
  const linked = getDb()
    .prepare("SELECT date, recurringId FROM transactions WHERE merchant = 'Netflix' ORDER BY date")
    .all() as { date: string; recurringId: number }[];
  for (const t of linked)
    assert.equal(
      t.recurringId,
      t.date.endsWith("-23") ? by("Netflix · 23rd")!.id : by("Netflix · 26th")!.id,
      `${t.date} links to its own series`
    );

  // The month view: each series is paid by its own charge, once.
  const aug = recurringsForMonth("2026-08").filter((r) => r.vendor === "Netflix");
  assert.equal(aug.length, 2);
  for (const r of aug) {
    assert.equal(r.paid, true, `${r.merchant} paid`);
    assert.equal(r.paidAmount, 26.99, `${r.merchant} paid once, not both charges`);
    assert.equal(r.vendor, "Netflix", "the shelf opens on the descriptor, not the series key");
  }
  // Recategorizing one series moves only its charges.
  const boat = addCat("Boat (split)");
  setSeriesCategory(by("Netflix · 26th")!.id, boat);
  const cats = getDb()
    .prepare("SELECT date, categoryId FROM transactions WHERE merchant = 'Netflix' ORDER BY date")
    .all() as { date: string; categoryId: number }[];
  assert.ok(cats.filter((t) => t.date.endsWith("-26")).every((t) => t.categoryId === boat), "the 26th moved");
  assert.ok(cats.filter((t) => t.date.endsWith("-23")).every((t) => t.categoryId === subs), "the 23rd stayed");

  // Two people's raises cross in amount: A 8,854 → 9,738 in June; B 7,480 →
  // 8,295 → 8,177. Amount bands can't cut that into two; rank can — the
  // larger deposit each payday is one paycheck, the smaller the other.
  const A = [8854.62, 8854.62, 8854.62, 9738.55, 9738.55, 9738.55, 9738.55, 9738.55];
  const B = [7480.78, 7480.78, 7480.78, 7480.78, 8295.23, 8177.01, 8177.01, 8177.01];
  for (let m = 1; m <= 8; m++) {
    tx("Acme Payroll", { amount: A[m - 1], date: `${ym(m)}-28`, categoryId: home });
    tx("Acme Payroll", { amount: B[m - 1], date: `${ym(m)}-28`, categoryId: home, account: "Savings" });
  }
  const acme = detectRecurrings().filter((r) => r.merchant.startsWith("Acme Payroll"));
  assert.deepEqual(acme.map((r) => r.merchant).sort(), ["Acme Payroll · larger", "Acme Payroll · smaller"], "ranked, not banded — the keys survive raises");
  assert.equal(acme.find((r) => r.merchant.endsWith("larger"))!.avgAmount, 9738.55);
  assert.equal(acme.find((r) => r.merchant.endsWith("smaller"))!.count, 8);
});

// One monthly plan plus strays. Benjamin Franklin bills $11.99 on the 8th; in
// August a $89.95 service call posted on the 21st and a second plan's first
// $11.99 on the 22nd. Gap math over the whole descriptor read "biweekly"; the
// 8th plan holds most of the charges and IS the bill — the strays stay
// unlinked until the second plan has three charges, when the descriptor
// splits and the vendor's name stays with the established plan.
test("detector keeps the dominant monthly plan when strays break the rhythm, then splits and keeps the name", () => {
  const home = addCat("Lake House (bf)");
  const bf = "Benjamin Franklin Pl";
  for (const m of ["06", "07", "08", "09"]) tx(bf, { amount: -11.99, date: `2026-${m}-08`, categoryId: home });
  tx(bf, { amount: -89.95, date: "2026-08-21", categoryId: home });
  tx(bf, { amount: -11.99, date: "2026-08-22", categoryId: home });
  setRecurringSetting(bf, { alias: "Benjamin Franklin Plumbing" });

  let recs = detectRecurrings().filter((r) => r.merchant.startsWith(bf));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].merchant, bf, "one plan keeps the bare descriptor as its key");
  assert.equal(recs[0].cadence, "monthly", "not biweekly");
  assert.equal(recs[0].count, 4);
  const linked = getDb().prepare("SELECT date FROM transactions WHERE merchant = ? AND recurringId IS NOT NULL ORDER BY date").all(bf) as { date: string }[];
  assert.deepEqual(linked.map((t) => t.date), ["2026-06-08", "2026-07-08", "2026-08-08", "2026-09-08"], "the strays are not members");

  // Two more months: the second plan reaches three charges and the descriptor splits.
  tx(bf, { amount: -11.99, date: "2026-09-22", categoryId: home });
  tx(bf, { amount: -11.99, date: "2026-10-08", categoryId: home });
  tx(bf, { amount: -11.99, date: "2026-10-22", categoryId: home });
  setTransactionRecurringExcluded(
    (getDb().prepare("SELECT id FROM transactions WHERE merchant = ? AND amount = -89.95").get(bf) as { id: number }).id,
    true
  ); // the service call, flagged as a one-off
  recs = detectRecurrings().filter((r) => r.merchant.startsWith(bf));
  assert.deepEqual(recs.map((r) => r.merchant).sort(), [`${bf} · 22nd`, `${bf} · 8th`]);
  const s = getRecurringSettings();
  assert.equal(s[`${bf} · 8th`]?.alias, "Benjamin Franklin Plumbing", "the name follows the established plan");
  assert.equal(s[`${bf} · 22nd`], undefined, "the new plan is unnamed until the user names it");
});

// Two jobs taking turns under one descriptor. Rosy's Cleaning is paid every
// two weeks — $240, then $270, then $240 — two homes alternating. Read as one
// biweekly bill it expects $270 every time. The amounts interleave, and each
// runs on its own four-week grid: two bills, keyed by amount, the odd $480
// double-payment left unlinked. A price change never interleaves (six $240s
// then six $270s) and stays one biweekly bill.
test("detector splits amounts that take turns into their own series; a price change stays one bill", () => {
  const home = addCat("Lake House (rosy)");
  const rosy = "Zelle Payment To Rosy's Cleaning";
  const d0 = Date.UTC(2026, 0, 9);
  const day = (i: number) => new Date(d0 + i * 14 * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < 14; i++) tx(rosy, { amount: i % 2 ? -270 : -240, date: day(i), categoryId: home });
  tx(rosy, { amount: -480, date: "2026-04-01", categoryId: home });
  for (let i = 0; i < 12; i++) tx("Window Washer", { amount: i < 6 ? -240 : -270, date: day(i), categoryId: home });

  const recs = detectRecurrings();
  const by = (m: string) => recs.find((r) => r.merchant === m);
  assert.deepEqual(
    recs.map((r) => r.merchant).filter((m) => m.startsWith(rosy)).sort(),
    [`${rosy} · $240`, `${rosy} · $270`]
  );
  assert.equal(by(`${rosy} · $240`)!.count, 7);
  assert.equal(by(`${rosy} · $270`)!.avgAmount, -270);
  assert.equal(by(`${rosy} · $240`)!.cadence, "monthly", "a 28-day turn reads as monthly");
  const orphan = getDb().prepare("SELECT recurringId FROM transactions WHERE merchant = ? AND amount = -480").get(rosy) as { recurringId: number | null };
  assert.equal(orphan.recurringId, null, "the double payment is nobody's member");
  const ww = recs.filter((r) => r.merchant.startsWith("Window Washer"));
  assert.equal(ww.length, 1, "a price change is one bill");
  assert.equal(ww[0].merchant, "Window Washer");
  assert.equal(ww[0].cadence, "biweekly");
});

// The shelf on ONE plan of a vendor that carries two: figures, next due, the
// price-change check, and the charge list come from that plan's own charges,
// and overrides live under the plan's key. The vendor-level summary is
// unchanged for a vendor with one plan.
test("merchantSummary scoped to a series answers for that plan only", () => {
  const home = addCat("Lake House (529)");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 8; m++) {
    tx("In 529 Dir Ach Contrib", { amount: -200, date: `${ym(m)}-18`, categoryId: home });
    tx("In 529 Dir Ach Contrib", { amount: -300, date: `${ym(m)}-18`, categoryId: home, account: "Savings" });
  }
  detectRecurrings();
  const key200 = "In 529 Dir Ach Contrib · $200";
  const plan = merchantSummary("In 529 Dir Ach Contrib", key200);
  assert.equal(plan.series, key200);
  assert.equal(plan.settingsKey, key200, "overrides from this shelf land on the plan");
  assert.equal(plan.plans, 2);
  assert.equal(plan.count, 8, "only this plan's charges");
  assert.equal(plan.recurringDetail?.perCharge, 200);
  assert.equal(plan.recurringDetail?.annualized, 2400);
  assert.equal(plan.priceChange, null, "two plans alternating is not a price change");
  assert.ok(plan.recent.every((r) => r.amount === -200), "Recent lists the plan's charges");
  assert.equal(plan.displayName, key200);
  // The plan's list also carries the vendor's charges in no plan, so one can
  // be pulled in or flagged out — but never a charge excluded from totals,
  // which can't join. A split parent is off every shelf, plan or vendor: it
  // is not a charge any more, its parts are (Chubb's $1,115.55 parents sat on
  // the Lake Home shelf as "not counted" noise between the plan's charges).
  tx("In 529 Dir Ach Contrib", { amount: -500, date: "2026-09-02", categoryId: home, excluded: 1, hash: "p529" });
  tx("In 529 Dir Ach Contrib — A", { amount: -250, date: "2026-09-02", categoryId: home, hash: "p529:s1" });
  tx("In 529 Dir Ach Contrib — B", { amount: -250, date: "2026-09-02", categoryId: home, hash: "p529:s2" });
  tx("In 529 Dir Ach Contrib", { amount: -90, date: "2026-09-04", categoryId: home, excluded: 1 });
  tx("In 529 Dir Ach Contrib", { amount: -75, date: "2026-09-03", categoryId: home });
  const again = merchantSummary("In 529 Dir Ach Contrib", key200);
  assert.ok(!again.recent.some((r) => r.excluded === 1), "nothing excluded from totals sits on a plan's shelf");
  assert.ok(again.recent.some((r) => r.amount === -75 && r.recurringId == null), "a stray in no plan does, so it can be pulled in");
  const vendor = merchantSummary("In 529 Dir Ach Contrib");
  assert.equal(vendor.series, null);
  assert.ok(!vendor.recent.some((r) => r.amount === -500), "a split parent is off the vendor shelf too");
  assert.ok(vendor.recent.some((r) => r.amount === -90 && r.excluded === 1), "a charge the user excluded from totals stays, as 'not counted'");
  assert.equal(vendor.settingsKey, "In 529 Dir Ach Contrib");
});

// A vendor whose descriptor changed carries two series. The page folds them
// and takes the newer one's dates; the shelf must agree — the most recently
// charged series speaks for the vendor, not whichever row is found first.
// And a price change is news, not history: the banner leaves after three
// charges at the new price.
test("the vendor shelf follows the newer series of a folded vendor, and a price change expires", () => {
  const subs = addCat("Subscriptions (wsj)");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 5; m++) tx("D J*wsj", { amount: -38.99, date: `${ym(m)}-25`, categoryId: subs });
  for (let m = 6; m <= 8; m++) tx("D J", { amount: -38.99, date: `${ym(m)}-18`, categoryId: subs });
  detectRecurrings();
  const shelf = merchantSummary("D J*wsj");
  // Next due rolls forward from today (the clock sweep runs this at many
  // dates), so assert the day it lands on and that it is not in the past.
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(shelf.recurringDetail?.nextDate.slice(8), "18", "next due follows the newer descriptor's charges (the 18th), not the stale series (the 25th)");
  assert.ok((shelf.recurringDetail?.nextDate ?? "") >= "2026-09-18" && (shelf.recurringDetail?.nextDate ?? "") >= today.slice(0, 8) + "01", "never in the past");
  assert.equal(shelf.priceChange, null, "no change to report");

  // A promo price then five charges at the real price: the change is old news.
  for (let m = 1; m <= 6; m++) tx("Paper", { amount: m === 1 ? -4 : -38.99, date: `${ym(m)}-05`, categoryId: subs });
  detectRecurrings();
  assert.equal(merchantSummary("Paper").priceChange, null, "five charges at the new price: the banner has expired");
  // Two charges at the new price: still news.
  for (let m = 1; m <= 5; m++) tx("Mag", { amount: m <= 3 ? -10 : -12, date: `${ym(m)}-05`, categoryId: subs });
  detectRecurrings();
  assert.deepEqual(merchantSummary("Mag").priceChange, { from: 10, to: 12, since: "2026-04-05" });
});

// A fixed bill with usage on top. Anthropic: $20 on the 17th every month plus
// $15-ish API top-ups on random days. The bill is the $20 group; the top-ups
// stay unlinked. A variable utility whose amounts wander but whose every
// charge sits on the monthly grid stays one whole series.
test("detector keeps the regular amount group and leaves irregular usage charges unlinked", () => {
  const subs = addCat("Subscriptions (core)");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 8; m++) tx("Anthropic", { amount: -20, date: `${ym(m)}-17`, categoryId: subs });
  // Usage top-ups land whenever the balance runs low: 3 days apart, then 40.
  for (const [m, d, amt] of [[1, 4, 15.01], [1, 7, 15.14], [1, 9, 15.34], [2, 26, 15.06], [3, 2, 100], [3, 3, 15.0], [5, 26, 107.59], [5, 29, 15.01], [7, 30, 15.2]] as [number, number, number][])
    tx("Anthropic", { amount: -amt, date: `${ym(m)}-${String(d).padStart(2, "0")}`, categoryId: subs });
  for (let m = 1; m <= 8; m++) tx("Duke Energy", { amount: -[31, 44, 58, 72, 65, 49, 38, 33][m - 1], date: `${ym(m)}-11`, categoryId: subs });

  const recs = detectRecurrings();
  const a = recs.find((r) => r.merchant === "Anthropic")!;
  assert.equal(a.cadence, "monthly");
  assert.equal(a.count, 8, "the eight $20 charges");
  assert.equal(a.avgAmount, -20);
  const unlinked = (getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE merchant = 'Anthropic' AND recurringId IS NULL").get() as { n: number }).n;
  assert.equal(unlinked, 9, "every top-up is left out of the series");
  const shelf = merchantSummary("Anthropic");
  assert.equal(shelf.recurringDetail?.perCharge, 20);
  assert.equal(shelf.priceChange, null, "the price walk is over the series' charges, not the top-ups");
  const duke = recs.find((r) => r.merchant === "Duke Energy")!;
  assert.equal(duke.count, 8, "a variable bill on one grid stays whole");

  // A plan that changed price: ten $20 months in 2024, then $100 months in
  // 2026 with usage around them. The core is the CURRENT plan, not the
  // largest group — the series must not end in 2024.
  const ym25 = (i: number) => `2025-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 10; m++) tx("Claude", { amount: -20, date: `${ym25(m)}-18`, categoryId: subs });
  for (let m = 3; m <= 8; m++) tx("Claude", { amount: -100, date: `${ym(m)}-18`, categoryId: subs });
  for (const [m, d, amt] of [[3, 2, 15.06], [3, 5, 15.14], [5, 26, 107.59], [5, 29, 15.01], [7, 30, 15.2]] as [number, number, number][])
    tx("Claude", { amount: -amt, date: `${ym(m)}-${String(d).padStart(2, "0")}`, categoryId: subs });
  const claude = detectRecurrings().find((r) => r.merchant === "Claude")!;
  assert.equal(claude.avgAmount, -100, "the current plan sets the price");
  assert.equal(claude.lastDate, "2026-08-18");
  assert.equal(claude.count, 16, "the $20 era is the same bill at an old price — history, not usage");
  const claudeUnlinked = (getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE merchant = 'Claude' AND recurringId IS NULL").get() as { n: number }).n;
  assert.equal(claudeUnlinked, 5, "only the usage leaves");

  // Six similar-priced lunches that happen to skip months are not a bill.
  for (const [ym2, amt] of [["2025-01-10", 26.65], ["2025-02-04", 26.65], ["2025-04-01", 27.3], ["2025-04-22", 26.65], ["2025-06-30", 27.63], ["2025-10-20", 25.89], ["2025-03-03", 10.66], ["2025-05-15", 1.84], ["2025-08-01", 11.31], ["2025-09-09", 6.21]])
    tx("Potbelly", { amount: -(amt as number), date: ym2 as string, categoryId: subs });
  // A monthly $25 credit sometimes posted as $21 + $4 is one credit, not a core plus usage.
  for (let m = 1; m <= 8; m++) {
    if (m === 3 || m === 6) { tx("Amex Credit", { amount: 21, date: `${ym(m)}-10`, categoryId: subs }); tx("Amex Credit", { amount: 4, date: `${ym(m)}-10`, categoryId: subs }); }
    else tx("Amex Credit", { amount: 25, date: `${ym(m)}-10`, categoryId: subs });
  }
  const again = detectRecurrings();
  // The core rule must decline (a core would be the six lunches); whatever
  // the ordinary whole-vendor path makes of the ten charges is its business.
  const potbelly = again.find((r) => r.merchant === "Potbelly");
  assert.ok(!potbelly || potbelly.count === 10, "skipping the grid is a coincidence, not a core");
  const credit = again.find((r) => r.merchant === "Amex Credit");
  assert.ok(!credit || credit.count === 10, "a credit is never split into a core plus usage (all ten postings, or none)");
});

// WHY: the timing test lets a bill skip a period, so a gap of two or three
// months still counts as on schedule. It let any gap count: past three
// periods the tolerance covers most of a month, so long gaps land "on" the
// grid by chance. Pies & Pints (nine restaurant visits over fifteen months,
// gaps of 90, 119 and 189 days) read as a monthly bill. A real bill that
// skips one or two months must still be one.
test("a gap of more than three periods is not a skipped bill", () => {
  const pies: [string, number][] = [
    ["2025-06-06", -60.7], ["2025-06-14", -93.51], ["2025-06-20", -44.06], ["2025-06-28", -87.59],
    ["2025-07-25", -71.42], ["2025-08-23", -69.8], ["2026-02-28", -102.34], ["2026-05-29", -37.03],
    ["2026-09-25", -15.71],
  ];
  for (const [date, amount] of pies) tx("Pies Gap", { amount, date });
  const bill: string[] = ["2026-01-05", "2026-02-05", "2026-04-05", "2026-05-05", "2026-08-05", "2026-09-05"];
  for (const date of bill) tx("Mortgage Gap", { amount: -1850, date });
  const plans = detectRecurrings();
  assert.equal(plans.find((r) => r.merchant === "Pies Gap"), undefined, "restaurant visits months apart are not a bill");
  const mortgage = plans.find((r) => r.merchant === "Mortgage Gap");
  assert.equal(mortgage?.cadence, "monthly", "a bill that skips one month, then two, is still monthly");
  assert.equal(mortgage?.count, 6);
});

// A bank rename is not a new vendor. Cursor billed $20 on the 20th as "Cursor
// Ai Powered" for three months, then as "Cursor, Ai Powered Isan Francisco";
// grouped by descriptor, the new charge was a one-charge vendor the shelf
// showed as "not detected" while the old series read as stopped. Descriptors
// that share the shelf's vendor key are also planned together, and the merge
// wins only when it links charges the descriptors alone could not, without
// losing a series. Chubb is the counter-case: descriptors that each carry
// their own policy link nothing more together, so they stay apart (merged on
// the real data, its eight policies read as one "biweekly" bill).
test("detector joins a renamed descriptor to its vendor only when the merge earns it", () => {
  const tools = addCat("Dev Tools");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 3; m++) tx("Cursor Ai Powered", { amount: -20, date: `${ym(m)}-20`, categoryId: tools });
  tx("Cursor, Ai Powered Isan Francisco", { amount: -20, date: "2026-04-20", categoryId: tools });
  for (let m = 1; m <= 6; m++) {
    tx("Chubb Prs Debitpmt", { amount: -163.75, date: `${ym(m)}-05`, categoryId: tools });
    tx("Chubb-prs Direct Deb Prs", { amount: -903.48, date: `${ym(m)}-20`, categoryId: tools });
  }
  const recs = detectRecurrings();
  const cursor = recs.filter((r) => /cursor/i.test(r.merchant));
  assert.deepEqual(
    cursor.map((r) => [r.merchant, r.count]),
    [["Cursor Ai Powered", 4]],
    "the renamed charge continues the series under the vendor's busiest descriptor"
  );
  const renamed = getDb()
    .prepare("SELECT recurringId FROM transactions WHERE merchant = ?")
    .get("Cursor, Ai Powered Isan Francisco") as { recurringId: number | null };
  assert.equal(renamed.recurringId, cursor[0].id, "the renamed charge is a member, not 'not detected'");
  assert.equal(cursor[0].lastDate, "2026-04-20", "the vendor's charges are read in date order across descriptors");
  // The month view pays the series with the renamed charge, not only with
  // charges on the series' own descriptor.
  const april = recurringsForMonth("2026-04").find((r) => r.merchant === "Cursor Ai Powered");
  assert.equal(april?.paid, true);
  assert.equal(april?.paidAmount, 20);
  const chubb = recs
    .filter((r) => /chubb/i.test(r.merchant))
    .map((r) => [r.merchant, r.count])
    .sort();
  assert.deepEqual(
    chubb,
    [
      ["Chubb Prs Debitpmt", 6],
      ["Chubb-prs Direct Deb Prs", 6],
    ],
    "a merge that links no more charges than the descriptors alone does not happen"
  );
});

// The month view's last-resort match pays a bill only with a charge on its own
// vendor key. It used to accept any charge of the same category within 5% of
// the amount: Rosy's $240 cleaning read as paid — "$249, +$9" — by a $249
// irrigation bill filed under the same home, while Rosy's own charge was still
// two weeks out. A relabeled descriptor on the same key ("Sp Liquid I.v" billed
// as "Liquid I.v") still pays.
test("month view pays a bill only with its own vendor's charge", () => {
  const home = addCat("Carmel Home Bills");
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
     VALUES (?, ?, ?, 'monthly', ?, ?, 9)`
  );
  const last = daysAgo(20);
  const next = daysFromNow(10);
  const month = next.slice(0, 7);
  ins.run("Zelle Payment To Rosy's Cleaning · $240", home, -240, last, next);
  ins.run("Sp Liquid I.v", home, -52.48, last, next);
  tx("Barthuly Irrigat", { amount: -249, date: next, categoryId: home });
  tx("Liquid I.v", { amount: -52.48, date: next, categoryId: home });
  const rows = recurringsForMonth(month);
  const rosy = rows.find((r) => r.merchant.startsWith("Zelle Payment To Rosy"));
  assert.equal(rosy?.paid, false, "another vendor's charge of the same category and amount is not this bill");
  const liquid = rows.find((r) => r.merchant === "Sp Liquid I.v");
  assert.equal(liquid?.paid, true, "the same vendor under a relabeled descriptor is");
  assert.equal(liquid?.paidAmount, 52.48);
});

// The billing day alone does not make a charge the bill. The dance academy
// bills tuition on the 4th: nine months of $195, then a $16.85 fee that
// happened to post on Jun 5, then the new season's $353 on Sep 4 (its first
// $353 posted on Aug 14). Membership by day alone took the fee, and the shelf
// announced "price changed $16.85 → $353". A lone charge on the day, more
// than half off a fixed-price plan and never repeated anywhere in the vendor's
// history, is held out — but still counts as explained by the day, so the
// plan survives the same strays that made it need rescuing. The $353 joins:
// the vendor has charged it twice. A variable bill keeps every charge.
test("detector holds a lone off-price charge off a fixed-price plan's billing day", () => {
  const kids = addCat("Dance");
  const home = addCat("Gas Utility");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  const v = "Central Indiana Academ";
  // nine tuition charges on the 4th (Sep 2025 – May 2026)
  for (let m = 9; m <= 12; m++) tx(v, { amount: -195, date: `2025-${m}-04`, categoryId: kids });
  for (let m = 1; m <= 5; m++) tx(v, { amount: -195, date: `${ym(m)}-04`, categoryId: kids });
  // strays: registration, costumes, a fee on tuition day, the ensemble
  tx(v, { amount: -235, date: "2025-08-13", categoryId: kids });
  tx(v, { amount: -164.8, date: "2025-10-28", categoryId: kids });
  tx(v, { amount: -112.15, date: "2025-11-29", categoryId: kids });
  tx(v, { amount: -300, date: "2026-05-18", categoryId: kids });
  tx(v, { amount: -832.5, date: "2026-05-29", categoryId: kids });
  tx(v, { amount: -16.85, date: "2026-06-05", categoryId: kids });
  tx(v, { amount: -65, date: "2026-07-31", categoryId: kids });
  // the new season: $353, first off the day, then on it
  tx(v, { amount: -353, date: "2026-08-14", categoryId: kids });
  tx(v, { amount: -353, date: "2026-09-04", categoryId: kids });
  // a utility on the 4th whose amounts swing with the season: every charge is the bill
  const gas = [210, 190, 120, 80, 60, 55, 70, 110, 160];
  gas.forEach((a, i) => tx("Vectren Gas", { amount: -a, date: `${ym(i + 1)}-04`, categoryId: home }));
  const recs = detectRecurrings();
  const dance = recs.find((r) => r.merchant === v);
  assert.ok(dance, "the tuition plan survives its strays");
  assert.equal(dance.count, 10, "nine tuition charges and the repeated $353; not the $16.85 fee");
  // One charge at the new price is not a settled price yet, so the per-charge
  // figure is the median; it becomes $353 once October's posts.
  assert.equal(dance.avgAmount, -195);
  const member = (amount: number, date: string) =>
    (getDb().prepare("SELECT recurringId FROM transactions WHERE merchant = ? AND amount = ? AND date = ?").get(v, amount, date) as { recurringId: number | null }).recurringId;
  assert.equal(member(-16.85, "2026-06-05"), null, "the fee on tuition day is held out");
  assert.equal(member(-353, "2026-09-04"), dance.id, "the repeated new price is in");
  assert.equal(member(-353, "2026-08-14"), null, "the off-day charge stays a stray");
  const utility = recs.find((r) => r.merchant === "Vectren Gas");
  assert.equal(utility?.count, gas.length, "a variable bill keeps every charge");
});

// One toggle on a charge. "Not in plan" → "In plan" puts a charge the detector
// left out into the plan (the dance academy's Aug 14 $353, off the billing
// day): it is pinned, survives rebuilds, and counts. "In plan" → "Not in plan"
// takes it out again and drops the pin — out means out, whichever state the
// detector would pick. Marking the vendor not recurring clears both marks.
test("a charge the user put into a plan stays in it across rebuilds until taken out", () => {
  const kids = addCat("Dance Tuition");
  const v = "Dance Academy";
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 8; m++) tx(v, { amount: -195, date: `${ym(m)}-04`, categoryId: kids });
  tx(v, { amount: -832.5, date: "2026-05-29", categoryId: kids }); // the ensemble
  tx(v, { amount: -65, date: "2026-07-31", categoryId: kids }); // a costume
  tx(v, { amount: -353, date: "2026-08-14", categoryId: kids, hash: "stray353" });
  const db = getDb();
  const stray = () => db.prepare("SELECT id, recurringId FROM transactions WHERE hash = 'stray353'").get() as { id: number; recurringId: number | null };
  let plan = detectRecurrings().find((r) => r.merchant === v)!;
  assert.equal(stray().recurringId, null, "off the billing day, the detector leaves it out");
  assert.equal(plan.count, 8);
  setTransactionRecurringIncluded(stray().id, v);
  plan = detectRecurrings().find((r) => r.merchant === v)!;
  assert.equal(stray().recurringId, plan.id, "put in by the user, it is a member");
  assert.equal(plan.count, 9, "and it counts");
  assert.equal(plan.lastDate, "2026-08-14", "the plan's last charge is now the pinned one");
  setTransactionRecurringExcluded(stray().id, true);
  plan = detectRecurrings().find((r) => r.merchant === v)!;
  assert.equal(stray().recurringId, null, "taken out again");
  assert.equal(getRecurringTxInclusions().has("stray353"), false, "out drops the pin");
  setTransactionRecurringIncluded(stray().id, v);
  assert.equal(getRecurringTxExclusions().has("stray353"), false, "in lifts the one-off flag");
  clearRecurringTxExclusionsForMerchant(v);
  assert.equal(getRecurringTxInclusions().has("stray353"), false, "not recurring clears the pin too");
});

// A subscription that moved from monthly to every two months. Liquid IV billed
// monthly through mid-2025, then every ~60 days; with no cadence between
// monthly and quarterly the whole vendor classified as nothing, the two 2026
// charges under a relabeled descriptor stayed "not detected", and the plan
// read as stale since May. Every-two-months is a cadence now: the current
// plan is the two-month one, the monthly era joins as history, the relabeled
// charges join through the vendor key, and the month view expects it only in
// every other month.
test("detector reads a plan that moved to every two months, history and relabel included", () => {
  const fit = addCat("Fitness (bimonthly)");
  const v = "Sp Liquid I.v";
  for (const d of ["2025-02-04", "2025-03-04", "2025-04-04", "2025-05-04", "2025-06-04", "2025-07-04", "2025-09-04"])
    tx(v, { amount: -34.98, date: d, categoryId: fit });
  for (const d of ["2025-11-02", "2026-01-11", "2026-03-10", "2026-05-10"]) tx(v, { amount: -52.47, date: d, categoryId: fit });
  tx("Liquid I.v", { amount: -52.48, date: "2026-07-11", categoryId: fit });
  tx("Liquid I.v", { amount: -52.48, date: "2026-09-11", categoryId: fit });
  const recs = detectRecurrings();
  const plans = recs.filter((r) => /liquid/i.test(r.merchant));
  assert.equal(plans.length, 1, "one plan for the vendor");
  const plan = plans[0];
  assert.equal(plan.cadence, "bimonthly");
  assert.equal(plan.lastDate, "2026-09-11", "the relabeled charge is its latest");
  assert.equal(plan.nextDate, "2026-11-11", "due two months on");
  assert.equal(plan.avgAmount, -52.48);
  const linked = getDb().prepare("SELECT COUNT(*) AS n FROM transactions WHERE recurringId = ?").get(plan.id) as { n: number };
  assert.equal(linked.n, 13, "the monthly era joins as history; both relabeled charges are members");
  assert.equal(recurringsForMonth("2026-10").find((r) => r.id === plan.id)?.expectedThisMonth, false, "not every month");
  assert.equal(recurringsForMonth("2026-11").find((r) => r.id === plan.id)?.expectedThisMonth, true, "every other month");
});

// The rhythm-change reading needs BOTH halves: a current era on one period and,
// before it, a history that was a plan on its own. Three two-month gaps at the
// end of erratic shopping are a coincidence, not a plan that changed rhythm —
// without the history test, every store visited a few times at roughly
// two-month spacing became an every-two-months bill.
test("three two-month gaps after erratic visits do not read as a plan that changed rhythm", () => {
  const v = "Dollar General";
  for (const d of ["2025-01-03", "2025-01-20", "2025-03-01", "2025-03-12", "2025-05-02", "2025-05-25", "2025-07-10"])
    tx(v, { amount: -19, date: d, categoryId: CAT });
  for (const d of ["2025-09-10", "2025-11-10", "2026-01-10", "2026-03-10"]) tx(v, { amount: -19, date: d, categoryId: CAT });
  assert.equal(detectRecurrings().filter((r) => r.merchant === v).length, 0, "no plan");
});

// ---- test-intent audit: exports that carried money or detector logic with no test ----

// WHY: a rule the user wrote is a decision; a rule the model wrote is a guess.
// In table order the model's early, short "benjamin franklin" -> Gifts outranked
// the user's later "benjamin franklin pl" -> Carmel Home, so every new plumbing
// charge was filed as a gift. The user's rule wins whatever order they arrived
// in, and of the user's rules the most specific one wins.
test("categorizeByRules: the user's rule beats the model's, and the more specific of the user's wins", () => {
  const gifts = addCat("Gifts"), home = addCat("Carmel Home"), loan = addCat("Loan");
  learnRule("benjamin franklin", gifts, "claude"); // first in the table
  learnRule("Benjamin Franklin Pl", home, "user"); // stored lowercased
  assert.equal(categorizeByRules("Benjamin Franklin Plindianapolis In"), home);
  assert.equal(categorizeByRules("Benjamin Franklin Mint"), gifts, "the model's rule still covers what the user's doesn't");
  learnRule("sofi", home, "user");
  learnRule("sofi home loan", loan, "user");
  assert.equal(categorizeByRules("Sofi Home Loan Co Entry"), loan);
  assert.equal(categorizeByRules("Sofi Bank"), home);
  // teaching the same pattern again corrects it in place rather than adding a rival
  learnRule("SOFI", loan, "user");
  assert.equal(categorizeByRules("Sofi Bank"), loan);
  assert.equal((getDb().prepare("SELECT COUNT(*) n FROM rules WHERE pattern = 'sofi'").get() as { n: number }).n, 1);
  assert.equal(categorizeByRules("Nobody Known"), null);
});

// WHY: a CSV is bank data, so every row is a charge. Two identical charges on
// one day (two coffees, two tolls) are two charges — the dedupe key alone made
// the second a "duplicate" and dropped it — while importing the same file
// twice must add nothing. Amounts arrive as "$1,234.50"; a row that can't be
// read is counted, never guessed.
test("importCsv keeps identical same-day charges, stays idempotent, and counts what it can't read", () => {
  const csv = [
    "Date,Description,Amount,Account",
    "2026-03-01,Coffee Bar,-4.50,Visa",
    "2026-03-01,Coffee Bar,-4.50,Visa",
    '2026-03-02,Employer,"$1,234.50",Checking',
    "not a date,Broken,-1,Visa",
    "2026-03-03,No Amount,abc,Visa",
  ].join("\n");
  assert.deepEqual(importCsv(csv), { inserted: 3, duplicates: 0, errors: 2 });
  assert.deepEqual(importCsv(csv), { inserted: 0, duplicates: 3, errors: 2 }, "the same file again adds nothing");
  const rows = getDb().prepare("SELECT merchant, amount FROM transactions ORDER BY date, id").all();
  assert.deepEqual(rows, [
    { merchant: "Coffee Bar", amount: -4.5 },
    { merchant: "Coffee Bar", amount: -4.5 },
    { merchant: "Employer", amount: 1234.5 },
  ]);
  assert.throws(() => importCsv("When,Who\n1,2"), /Date, Name/, "a file without the columns is refused, not half-read");
});

// WHY: "3/1/2026" names a calendar day. Parsed as local midnight and written
// back through toISOString() it became Feb 28 anywhere east of UTC — the charge
// landed in the wrong month.
test("importCsv reads a slash date as the day it names, in any time zone", () => {
  const tz = process.env.TZ;
  try {
    for (const zone of ["Europe/Berlin", "America/Indiana/Indianapolis", "Pacific/Auckland"]) {
      process.env.TZ = zone;
      getDb().exec("DELETE FROM transactions");
      importCsv("Date,Name,Amount\n3/1/2026,Rent,-1000");
      const row = getDb().prepare("SELECT date FROM transactions").get() as { date: string };
      assert.equal(row.date, "2026-03-01", zone);
    }
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

// WHY: the charge shelf's verbs depend on this read. `planKey` must name the
// vendor's plan even for a charge that ISN'T in it — that is what lets the pill
// offer "put it in the plan". `recent` is the evidence for "is this amount the
// usual one": it spans the vendor's linked descriptors, orders by the effective
// date, and leaves out split parents (their parts are the charges).
test("transactionById: the vendor's plan, and recent charges across descriptors without split parents", () => {
  for (const d of ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]) tx("Gym Co", { amount: -40, date: d, categoryId: CAT });
  tx("Gym Co", { amount: -12, date: "2026-04-20", categoryId: CAT, hash: "stray" }); // a day-pass, not the plan
  tx("Gym Company Llc", { amount: -40, date: "2026-05-15", categoryId: CAT, hash: "relabel" });
  linkMerchant("Gym Company Llc", "Gym Co");
  tx("Gym Co", { amount: -100, date: "2026-05-20", categoryId: CAT, excluded: 1, hash: "parent" });
  tx("Gym Co", { amount: -60, date: "2026-05-20", categoryId: CAT, hash: "parent:s0" });
  tx("Gym Co", { amount: -40, date: "2026-05-20", categoryId: CAT, hash: "parent:s1" });
  const plan = detectRecurrings().find((r) => r.merchant === "Gym Co");
  assert.ok(plan, "fixture: the vendor has a plan");
  const id = (hash: string) => (getDb().prepare("SELECT id FROM transactions WHERE hash = ?").get(hash) as { id: number }).id;

  const stray = transactionById(id("stray"))!;
  if (stray.recurringId == null) assert.equal(stray.planKey, "Gym Co", "a charge outside the plan still knows the vendor's plan");
  else assert.equal(stray.planKey, "Gym Co");
  assert.equal(stray.recent.length, 5);
  assert.ok(!stray.recent.some((r) => r.id === id("parent")), "the split parent is not a charge");
  assert.ok(stray.recent.some((r) => r.id === id("relabel")), "the linked descriptor's charge is this vendor's");
  assert.equal(stray.vendorCount, 8, "4 monthly + day-pass + relabel + 2 parts; not the parent");

  // the effective date, not the posted one, orders the evidence
  setTransactionEffectiveDate(id("stray"), "2026-06-01");
  assert.equal(transactionById(id("stray"))!.recent[0].id, id("stray"));
  assert.equal(transactionById(999999), null);
});

// WHY: Benjamin Franklin posts two $11.99 plans under one vendor. The Carmel
// charge's shelf listed the 8th's charges and a one-off beside it, so they
// read as Carmel's. With several plans, the list is this plan only; a charge
// in no plan still shows the vendor, because it has no plan to scope to.
test("transactionById recent list is this plan when the vendor has several", () => {
  for (const d of ["2026-01-02", "2026-02-02", "2026-03-02", "2026-04-02"]) tx("Apple", { amount: -9.99, date: d });
  for (const d of ["2026-01-26", "2026-02-26", "2026-03-26", "2026-04-26"]) tx("Apple", { amount: -12.99, date: d });
  tx("Apple", { amount: -1299, date: "2026-03-15", hash: "phone" });
  detectRecurrings();
  const idOf = (date: string, amount: number) =>
    (getDb().prepare("SELECT id FROM transactions WHERE merchant = 'Apple' AND date = ? AND amount = ?").get(date, amount) as { id: number }).id;

  const carmel = transactionById(idOf("2026-04-02", -9.99))!;
  assert.equal(carmel.scopedToPlan, true);
  assert.ok(carmel.recent.every((r) => r.amount === -9.99), "the other plan and the one-off are not this plan");
  assert.equal(carmel.vendorCount, 4, "the count is the plan's charges, not the vendor's");

  const phone = transactionById(idOf("2026-03-15", -1299))!;
  assert.equal(phone.scopedToPlan, false, "a charge in no plan has no plan to scope to");
  assert.ok(phone.recent.some((r) => r.amount === -12.99), "its list is still the vendor's");
});

// WHY: the charge's shelf shows what its vendor costs a year, as evidence. It
// must be the vendor's own figures — every linked descriptor, no excluded
// charge, a split counted once — or the two shelves would state different
// totals for one vendor, a tap apart.
test("transactionById.byYear is the vendor's by-year spend: linked names in, excluded out, a split counted once", () => {
  tx("Gym Co", { amount: -40, date: "2025-11-15", categoryId: CAT });
  tx("Gym Co", { amount: -40, date: "2026-01-15", categoryId: CAT, hash: "jan" });
  tx("Gym Company Llc", { amount: -45, date: "2026-02-15", categoryId: CAT });
  linkMerchant("Gym Company Llc", "Gym Co");
  tx("Gym Co", { amount: -500, date: "2026-03-01", categoryId: CAT, excluded: 1 }); // excluded from totals
  tx("Gym Co", { amount: -100, date: "2026-03-20", categoryId: CAT, excluded: 1, hash: "p" }); // a split parent
  tx("Gym Co", { amount: -60, date: "2026-03-20", categoryId: CAT, hash: "p:s0" });
  tx("Gym Co", { amount: -40, date: "2026-03-20", categoryId: CAT, hash: "p:s1" });
  tx("Gym Co", { amount: 15, date: "2026-04-01", categoryId: CAT }); // a refund is not spend
  const jan = (getDb().prepare("SELECT id FROM transactions WHERE hash = 'jan'").get() as { id: number }).id;
  const charge = transactionById(jan)!;
  assert.deepEqual(charge.byYear, [{ year: "2026", spent: 185 }, { year: "2025", spent: 40 }]);
  assert.deepEqual(charge.byYear, merchantSummary("Gym Co")!.byYear, "the charge's shelf and the vendor's agree");
});

// WHY: a month's "paid" is what the bill cost. A plan claims every charge from
// its vendor, so a $20 subscription and a separate $200 purchase from the same
// vendor read as a $220 bill, "$200 more than expected", on the Recurrings page
// and in the digest. A plan that charges once a month is paid by ONE charge: the
// one nearest what it expects. A weekly plan really is paid several times.
test("recurringsForMonth: a once-a-month plan is paid by the charge nearest its expected amount, a weekly plan by the sum", () => {
  const at = (back: number, day: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, day)).toISOString().slice(0, 10);
  };
  for (const back of [3, 2, 1, 0]) tx("Ai Lab", { amount: -20, date: at(back, 3), categoryId: CAT });
  for (const day of [1, 8, 15, 22]) for (const back of [1, 0]) tx("Lawn Crew", { amount: -60, date: at(back, day), categoryId: CAT });
  for (const back of [3, 2, 1, 0]) tx("Car Loan", { amount: -818.4, date: at(back, 1), categoryId: CAT });
  detectRecurrings();
  // A one-off purchase from the same vendor, the same month. The plan claims
  // every charge on its vendor's name, whether or not the detector linked it.
  tx("Ai Lab", { amount: -200, date: at(0, 2), categoryId: CAT });
  tx("Ai Lab", { amount: -18.99, date: at(0, 9), categoryId: CAT }); // a second, similar subscription: a different bill, not a duplicate
  // And a bill that really was charged twice this month (the 1st and the 28th).
  tx("Car Loan", { amount: -818.4, date: at(0, 28), categoryId: CAT });
  const rows = recurringsForMonth(at(0, 1).slice(0, 7));
  const lab = rows.find((r) => r.merchant === "Ai Lab")!;
  const lawn = rows.find((r) => r.merchant === "Lawn Crew")!;
  assert.equal(lab.cadence, "monthly");
  assert.equal(lab.paidAmount, 20, "the subscription, not the subscription plus the purchase");
  assert.equal(lab.paidTimes, 1, "neither the purchase nor a similar $18.99 subscription is a second copy of the $20 bill");
  const loan = rows.find((r) => r.merchant === "Car Loan")!;
  assert.deepEqual([loan.paidAmount, loan.paidTimes], [818.4, 2], "one bill's amount, and the fact that it was charged twice");
  assert.equal(lawn.cadence, "weekly");
  assert.equal(lawn.paidAmount, 240, "four weekly visits are four payments");
});

// WHY: a plan charged every week or two is paid several times a month, and
// once its first charge posts it reads as paid. The charges still to come
// dropped out of "left to pay": Precision Cutz's fifth September charge, due
// the 29th, was missing from the month's expected bills.
test("recurringsForMonth counts the charges a weekly plan still has due this month", () => {
  for (const d of ["06-02", "06-09", "06-16", "06-23", "06-30", "07-07", "07-14", "07-21", "07-28", "08-04", "08-11", "08-18", "08-25", "09-01", "09-08", "09-15", "09-22"])
    tx("Lawn Weekly", { amount: -63.1, date: `2026-${d}` });
  for (const d of ["08-23", "09-08", "09-24"]) tx("Pay Biweekly", { amount: -369.65, date: `2026-${d}` });
  for (const m of ["06", "07", "08", "09"]) tx("Water Monthly", { amount: -40, date: `2026-${m}-03` });
  detectRecurrings();
  const sep = recurringsForMonth("2026-09");
  const row = (m: string) => sep.find((r) => r.merchant === m)!;

  const lawn = row("Lawn Weekly");
  assert.equal(lawn.cadence, "weekly", "fixture");
  assert.deepEqual([lawn.paidAmount, lawn.paidTimes, lawn.chargesStillDue], [252.4, 4, 1], "four paid, the 29th still due");
  const pay = row("Pay Biweekly");
  assert.equal(pay.cadence, "biweekly", "fixture");
  assert.deepEqual([pay.paidAmount, pay.paidTimes, pay.chargesStillDue], [739.3, 2, 0], "the next one, 8 October, is next month");
  assert.equal(row("Water Monthly").chargesStillDue, 0, "a monthly bill's one charge is paid or it isn't");
  assert.equal(recurringsForMonth("2026-08").find((r) => r.merchant === "Lawn Weekly")!.chargesStillDue, 0, "a finished month has nothing still due");
});

// WHY: Plaid must begin the day after the imported back-history ends, or it
// re-delivers charges the import already holds under a different key (double
// counting). Plaid's own rows — and the parts of a split Plaid charge, which
// keep their parent's source — must never move that line forward, or a sync
// would stop seeing the window it still needs.
test("plaidSyncStartDate is the day after the last imported charge, whatever Plaid has added since", () => {
  getDb().prepare("INSERT INTO transactions (date, merchant, amount, account, source, hash) VALUES ('2026-05-31','Old','-5','Visa','copilot','c1')").run();
  assert.equal(plaidSyncStartDate(), "2026-06-01");
  getDb().prepare("INSERT INTO transactions (date, merchant, amount, account, source, hash) VALUES ('2026-09-18','New','-5','Visa','plaid','p1')").run();
  getDb().prepare("INSERT INTO transactions (date, merchant, amount, account, source, hash) VALUES ('2026-09-18','New','-2','Visa','plaid','p1:s0')").run();
  assert.equal(plaidSyncStartDate(), "2026-06-01");
  getDb().exec("DELETE FROM transactions WHERE source = 'copilot'");
  const twoYearsBack = new Date();
  twoYearsBack.setUTCFullYear(twoYearsBack.getUTCFullYear() - 2);
  assert.equal(plaidSyncStartDate(), twoYearsBack.toISOString().slice(0, 10), "no history at all: a two-year backfill");
});

// WHY: the effective date is how a mortgage that posts on the 30th counts in
// the month it pays for. It is the user's overlay on bank data, so the next
// Plaid sync — which rewrites date, amount and pending — must leave it alone,
// and the month totals must follow it.
test("an effective date moves a charge's month and survives the next Plaid sync", () => {
  const pull = {
    accounts: [{ account_id: "a1", name: "Checking" }],
    transactions: [{ transaction_id: "mort", account_id: "a1", date: "2026-04-30", name: "Home Mortgage", merchant_name: "Home Mortgage", amount: 2000, pending: false }],
  };
  importPlaidTransactions([pull]);
  const id = (getDb().prepare("SELECT id FROM transactions WHERE hash = 'mort'").get() as { id: number }).id;
  getDb().prepare("UPDATE transactions SET categoryId = ? WHERE id = ?").run(CAT, id);
  assert.equal(dashboard("2026-04").expenses, 2000);
  setTransactionEffectiveDate(id, "2026-05-01");
  importPlaidTransactions([pull]);
  assert.equal(dashboard("2026-04").expenses, 0, "April no longer carries it");
  assert.equal(dashboard("2026-05").expenses, 2000, "May does, after a re-sync");
  setTransactionEffectiveDate(id, null);
  assert.equal(dashboard("2026-04").expenses, 2000, "clearing it returns the charge to its posted month");
});

// WHY: a bill charged on the same day every month for a year is a plan, whatever
// else the vendor also charges. Chubb bills one policy on the 17th and another
// quarterly on the 4th. The quarterly charges left the vendor's median gap at
// 28 days ("monthly") but put 6 of 14 gaps off the monthly grid — so the
// one-billing-day rescue was skipped (it only asked about the median) and the
// ordinary path then refused the vendor (it also asks about the grid). Result:
// no plan at all, and combining the vendor's two bank names erased the one it
// had. The rescue now asks both questions, like the path it stands in for.
test("detector keeps a monthly plan when a quarterly charge from the same vendor breaks the grid", () => {
  const v = "Chubb";
  for (const [d, a] of [
    ["2025-10-17", -470.92], ["2025-11-18", -470.92], ["2025-12-17", -470.92], ["2026-01-17", -470.92], ["2026-02-18", -470.83],
    ["2026-03-17", -1227.74], ["2026-04-17", -544.94], ["2026-05-19", -544.94], ["2026-06-17", -544.94], ["2026-07-17", -544.94],
    ["2026-08-18", -544.94], ["2026-09-18", -544.94],
  ] as [string, number][]) tx(v, { amount: a, date: d, categoryId: CAT });
  const quarterly = ["2025-11-04", "2026-02-04", "2026-05-05"];
  for (const d of quarterly) tx(v, { amount: -168.75, date: d, categoryId: CAT });
  const plans = detectRecurrings().filter((r) => r.merchant.startsWith(v));
  assert.equal(plans.length, 1, "the policy on the 17th is a plan");
  assert.equal(plans[0].cadence, "monthly");
  assert.equal(plans[0].avgAmount, -544.94, "at its current price");
  assert.equal(plans[0].lastDate, "2026-09-18");
  const linked = getDb().prepare("SELECT date FROM transactions WHERE recurringId = ? ORDER BY date").all(plans[0].id) as { date: string }[];
  assert.equal(linked.length, 12, "every charge on the 17th");
  assert.ok(!linked.some((r) => quarterly.includes(r.date)), "the quarterly policy's charges are not this plan's");
});

// ---- merge queue: the handoff pattern (a bank rename seen from behaviour) ----
const monthly = (merchant: string, from: [number, number], n: number, amount: number, day = 15, account = "Visa", categoryId: number | null = CAT) => {
  for (let i = 0; i < n; i++) {
    const m = from[1] - 1 + i;
    tx(merchant, { amount, date: `${from[0] + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`, account, categoryId });
  }
};

// WHY: when a bank renames a vendor, the old plan reads as lapsed and the new
// one as three charges old — Uplift became Upgrade, and a year of payments read
// as nine. No name test finds that pair; behaviour does: one plan stops and,
// a period later, another vendor starts at the same amount on the same account
// in the same category, and the old name never charges again. It is offered as
// a "possible match" because the names share nothing, and one tap makes the
// history whole.
test("merge queue suggests a handoff: a plan that stopped and the vendor that picked it up", () => {
  monthly("Uplift, Inc.", [2025, 10], 4, -100, 1, "Checking");
  monthly("Upgrade", [2026, 2], 4, -100, 1, "Checking");
  detectRecurrings();
  const [s, ...rest] = handoffSuggestions(new Set());
  assert.equal(rest.length, 0);
  assert.deepEqual(s.variants, [{ merchant: "Uplift, Inc.", count: 4 }, { merchant: "Upgrade", count: 4 }]);
  assert.equal(s.canonical, "Upgrade", "the newer name is the one future charges arrive under");
  assert.equal(s.lowConfidence, true, "the names share no word: a possible match, for the user to confirm");
  assert.match(s.note!, /left off: \$100\.00 monthly, 31 days after its last charge, same account and category/);
  assert.ok(allMergeSuggestions().some((x) => x.key === s.key), "it is in the queue the page reads");

  approveMerge(s.canonical, s.variants.map((v) => v.merchant), s.categoryId);
  const plans = detectRecurrings().filter((r) => /upgrade|uplift/i.test(r.merchant));
  assert.equal(plans.length, 1, "one plan");
  assert.equal(plans[0].count, 8, "with the whole history");
  assert.equal(handoffSuggestions(new Set()).length, 0, "and nothing left to suggest");
});

// WHY: a review queue earns its place by not crying wolf. Each of these looks
// like a handoff on one axis and is not one; the first would do harm — a Not
// recurring mark on one name mutes the whole combined vendor, so approving
// would erase the plan it meant to extend (Paige's Music, on real data).
test("merge queue does not suggest a handoff that isn't one", () => {
  const reset = () => getDb().exec("DELETE FROM transactions; DELETE FROM recurrings; DELETE FROM recurring_overrides");
  const suggestions = () => { detectRecurrings(); return handoffSuggestions(new Set()).length; };

  monthly("Old Gym", [2025, 1], 6, -40); monthly("New Gym", [2025, 7], 3, -40);
  assert.equal(suggestions(), 1, "the control: this shape IS a handoff");
  setRecurringOverride("New Gym", "mute");
  assert.equal(suggestions(), 0, "the successor is marked Not recurring");

  reset(); monthly("Old Gym", [2025, 1], 6, -40); monthly("New Gym", [2025, 7], 3, -40);
  tx("Old Gym", { amount: -40, date: "2025-08-20", account: "Visa", categoryId: CAT });
  assert.equal(suggestions(), 0, "the old name charged again after the new one began: two vendors");

  reset(); monthly("Old Gym", [2025, 1], 6, -40);
  for (const [d, a] of [["2025-07-14", -40.5], ["2025-07-29", -52.1], ["2025-08-09", -31], ["2025-08-30", -47.75]] as [string, number][]) tx("Gas Stop", { amount: a, date: d, account: "Visa", categoryId: CAT });
  assert.equal(suggestions(), 0, "a similar first charge that doesn't repeat is a coincidence");

  reset(); monthly("Old Gym", [2025, 1], 6, -40, 15, "Visa"); monthly("New Gym", [2025, 7], 3, -40, 15, "Amex");
  assert.equal(suggestions(), 0, "a different card");

  reset(); monthly("Old Gym", [2025, 1], 6, -40); monthly("New Gym", [2025, 7], 3, -40, 15, "Visa", CAT_X);
  assert.equal(suggestions(), 0, "a different category");

  reset(); monthly("Old Gym", [2025, 1], 6, -40); monthly("New Gym", [2025, 11], 3, -40);
  assert.equal(suggestions(), 0, "four months later is a new subscription, not a rename");
});

// WHY: two $15 newsletters that both changed descriptor in the same month pair
// up four ways on behaviour alone. The names say which two are real; the
// crossed pairs must not be offered, or one tap merges Lenny into Peter.
test("merge queue lets names break a tie between simultaneous handoffs", () => {
  monthly("Lennys Newslesan Francisco", [2025, 1], 6, -15, 28);
  monthly("Lennys Newsletter", [2025, 7], 4, -15, 28);
  monthly("Peters Newslesan Mateo", [2025, 1], 6, -15, 24);
  monthly("Peters Newsletter", [2025, 7], 4, -15, 24);
  detectRecurrings();
  const pairs = handoffSuggestions(new Set()).map((s) => s.variants.map((v) => v.merchant.split(" ")[0]).join(">")).sort();
  assert.deepEqual(pairs, ["Lennys>Lennys", "Peters>Peters"]);
  assert.ok(handoffSuggestions(new Set()).every((s) => !s.lowConfidence), "a shared name is a confident match");
});

// WHY: the user's name and rules for a vendor live under its canonical
// descriptor. When the old name carries them, it stays canonical, so combining
// doesn't swap "ADT Security" back to a raw bank string. And a dismissed pair
// stays dismissed.
test("a handoff keeps the side that carries the user's settings, and stays dismissed", () => {
  monthly("Adtsecurity Myadt.co", [2025, 1], 6, -58.06, 25);
  monthly("Adt", [2025, 7], 3, -58.06, 25);
  setRecurringSetting("Adtsecurity Myadt.co", { alias: "ADT Security" } as never);
  detectRecurrings();
  const [s] = handoffSuggestions(new Set());
  assert.equal(s.canonical, "Adtsecurity Myadt.co");
  for (const k of s.dismissKeys) dismissMerge(k);
  assert.equal(handoffSuggestions(new Set()).length, 0);
});

// WHY: Ben Franklin's charges are Carmel Home and Lake Home. A category edit
// on the vendor would move both, and teach the next import to keep doing it.
// The edit is refused. Aimed at one plan, only that plan moves. A vendor
// whose charges already agree still moves as a whole.
test("a vendor whose charges disagree cannot be recategorized as a whole", () => {
  const lake = addCat("Lake Home (plumb)");
  const carmel = addCat("Carmel Home (plumb)");
  const plumbing = addCat("Plumbing (plumb)");
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx("Ben Plumb", { amount: -11.99, date: `2026-${m}-08`, categoryId: lake });
    tx("Ben Plumb", { amount: -11.99, date: `2026-${m}-25`, categoryId: carmel });
  }
  const plans = detectRecurrings().filter((r) => r.merchant.startsWith("Ben Plumb"));
  assert.equal(plans.length, 2, "fixture: two plans");
  assert.equal(merchantSummary("Ben Plumb").categoryMixed, true);
  assert.equal(applyRecategorize("Ben Plumb", plumbing, null), "refused");
  const catOf = (day: string) =>
    (getDb().prepare("SELECT categoryId FROM transactions WHERE merchant = 'Ben Plumb' AND date LIKE ?").get(`%-${day}`) as { categoryId: number }).categoryId;
  assert.equal(catOf("08"), lake, "the 8th stayed");
  assert.equal(catOf("25"), carmel, "the 25th stayed");

  const planId = (day: string) =>
    (getDb().prepare("SELECT recurringId AS id FROM transactions WHERE merchant = 'Ben Plumb' AND date LIKE ?").get(`%-${day}`) as { id: number }).id;
  assert.equal(applyRecategorize("Ben Plumb", plumbing, planId("25")), "plan");
  assert.equal(catOf("25"), plumbing, "the 25th moved");
  assert.equal(catOf("08"), lake, "the 8th stayed");
  for (const p of plans) {
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM transactions WHERE recurringId = ? AND excluded = 0").get(p.id) as { n: number }).n;
    assert.equal(merchantSummary("Ben Plumb", p.merchant).count, n, "opening the plan is that plan, even when its key is the vendor's name");
  }

  for (const m of ["01", "02", "03", "04"]) tx("City Water", { amount: -40, date: `2026-${m}-03`, categoryId: lake });
  detectRecurrings();
  assert.equal(merchantSummary("City Water").categoryMixed, false);
  assert.equal(applyRecategorize("City Water", plumbing, null), "vendor");
  assert.ok(
    (getDb().prepare("SELECT categoryId FROM transactions WHERE merchant = 'City Water'").all() as { categoryId: number }[]).every((t) => t.categoryId === plumbing),
    "one category: the vendor still moves together"
  );
});

// WHY: the refusal exists for houses — several plans in different categories.
// Drawn wider, it locked out edits the user is entitled to: Apple's plans all
// in one category, a vendor with one mis-filed one-off, and Combine's "one
// category for both". Each of those returned 409 and moved nothing.
test("a vendor-wide category edit is refused only for plans in different categories", () => {
  const subs = addCat("Subs (wide)");
  const fun = addCat("Fun (wide)");
  const gyms = addCat("Gyms (wide)");
  const catsOf = (m: string) =>
    new Set((getDb().prepare("SELECT categoryId FROM transactions WHERE merchant = ?").all(m) as { categoryId: number }[]).map((t) => t.categoryId));

  // Several plans that agree: the vendor moves, every plan with it.
  for (const m of ["01", "02", "03", "04"]) {
    tx("Apple Wide", { amount: -9.99, date: `2026-${m}-02`, categoryId: subs });
    tx("Apple Wide", { amount: -12.99, date: `2026-${m}-26`, categoryId: subs });
  }
  assert.equal(detectRecurrings().filter((r) => r.merchant.startsWith("Apple Wide")).length, 2, "fixture: two plans");
  assert.equal(merchantSummary("Apple Wide").categoryMixed, false, "the shelf offers the category");
  assert.equal(applyRecategorize("Apple Wide", fun, null), "vendor", "and the server takes it");
  assert.deepEqual([...catsOf("Apple Wide")], [fun]);

  // Aimed at one of several plans, only that plan moves, even when they agree.
  const tvPlan = (getDb().prepare("SELECT recurringId AS id FROM transactions WHERE merchant = 'Apple Wide' AND amount = -12.99").get() as { id: number }).id;
  assert.equal(applyRecategorize("Apple Wide", subs, tvPlan), "plan");
  assert.deepEqual([...catsOf("Apple Wide")].sort(), [subs, fun].sort(), "the other plan kept its category");

  // One plan and a stray one-off in another category: the vendor still moves.
  for (const m of ["01", "02", "03", "04"]) tx("Gym Wide", { amount: -40, date: `2026-${m}-03`, categoryId: subs });
  tx("Gym Wide", { amount: -15, date: "2026-02-17", categoryId: fun });
  detectRecurrings();
  assert.equal(merchantSummary("Gym Wide").categoryMixed, false, "a one-off doesn't hide the vendor's category");
  assert.equal(applyRecategorize("Gym Wide", gyms, null), "vendor");
  assert.deepEqual([...catsOf("Gym Wide")], [gyms], "the one-off moved with it");

  // Combine: two vendors in different categories, no plans, then one category.
  tx("Foo Wide Co", { amount: -5, date: "2026-03-01", categoryId: subs });
  tx("Foo Wide Company", { amount: -6, date: "2026-03-05", categoryId: fun });
  linkMerchant("Foo Wide Company", "Foo Wide Co");
  assert.equal(applyRecategorize("Foo Wide Co", gyms, null), "vendor", "combined vendors without plans are one vendor");

  // Houses, combined: refused unless the user asked for one category for all.
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx("Twin Wide", { amount: -11.99, date: `2026-${m}-08`, categoryId: subs });
    tx("Twin Wide", { amount: -11.99, date: `2026-${m}-25`, categoryId: fun });
  }
  detectRecurrings();
  assert.equal(applyRecategorize("Twin Wide", gyms, null), "refused");
  assert.deepEqual([...catsOf("Twin Wide")].sort(), [subs, fun].sort(), "a refusal moves nothing");
  assert.equal(applyRecategorize("Twin Wide", gyms, null, true), "vendor", "Combine's choice is the user's");
  assert.deepEqual([...catsOf("Twin Wide")], [gyms]);
});

// WHY: one bank descriptor can carry two plans the user tells apart by name —
// "In 529 Dir Ach Contrib" is $200 for one child and $300 for the other, named
// on the Recurrings page. A charge is linked to its plan, so it carries that
// name everywhere a charge is shown; named by vendor alone, both read as the
// bank string on every page but Recurrings, and the two tabs disagreed about
// what the same money was. Only the user's names travel: a plan's detector
// label ("… · $200") beside a $200.00 amount says nothing new. And what a row
// is called is what search finds.
test("a charge takes its plan's name when the user named the plan", () => {
  const v = "In 529 Dir Ach Contrib";
  for (const m of ["04", "05", "06", "07", "08", "09"]) {
    tx(v, { amount: -200, date: `2026-${m}-18`, categoryId: CAT, hash: `h200-${m}` });
    tx(v, { amount: -300, date: `2026-${m}-18`, categoryId: CAT, hash: `h300-${m}` });
  }
  const plans = detectRecurrings().filter((r) => r.merchant.startsWith(v)).map((r) => r.merchant).sort();
  assert.deepEqual(plans, [`${v} · $200`, `${v} · $300`], "fixture: two plans under one descriptor");
  setRecurringSetting(`${v} · $200`, { alias: "529 Contribution - Henry" } as never);

  const names = (rows: { amount: number; displayName: string }[]) => [...new Set(rows.map((r) => `${r.amount}: ${r.displayName}`))].sort();
  const expected = ["-200: 529 Contribution - Henry", `-300: ${v}`];
  assert.deepEqual(names(listTransactions({ month: "2026-09" })), expected, "the Transactions row; the unnamed plan keeps the vendor's name");
  assert.deepEqual(names(categorySummary(CAT, "2026-09")!.transactions), expected, "the category shelf's list");
  const id = (hash: string) => (getDb().prepare("SELECT id FROM transactions WHERE hash = ?").get(hash) as { id: number }).id;
  assert.equal(transactionById(id("h200-09"))!.displayName, "529 Contribution - Henry", "the charge shelf");
  assert.equal(transactionById(id("h200-09"))!.merchant, v, "with the bank's descriptor still on the row");

  // search finds the plan by its name — and only that plan's charges
  const found = listTransactions({ q: "henry" });
  assert.equal(found.length, 6);
  assert.ok(found.every((r) => r.amount === -200));
  assert.equal(transactionsSummary({ q: "henry" }).count, 6, "the count above the list agrees with the list");
  assert.equal(listTransactions({ q: "529 dir" }).length, 12, "the bank's name still finds both");
  assert.deepEqual(
    merchantSummary(v).planList.map((p) => p.day).sort(),
    ["18th · $200", "18th · $300"],
    "two plans on one day: the pill adds the amount"
  );

  // a charge the user took out of the plan is no longer that plan's
  setTransactionRecurringExcluded(id("h200-09"), true);
  detectRecurrings();
  assert.equal(transactionById(id("h200-09"))!.displayName, v);

  // The statement lists every charge of the vendor. Naming it from the newest
  // row put "529 Contribution - Henry" over the $300 plan too.
  const statement = transactionsSummary({ vendor: v });
  assert.equal(statement.vendorName, merchantSummary(v).displayName, "the statement wears the vendor's name");
  assert.notEqual(statement.vendorName, "529 Contribution - Henry");
  assert.equal(transactionsSummary({}).vendorName, undefined, "a mixed list has no vendor to name");
});

// WHY: the statement's heading names a category for the whole vendor, and a
// row whose category matches the heading hides its own. Ben Franklin's
// charges are half Carmel Home, half Lake Home: the heading said Lake Home
// over all of them, and the Lake rows showed no category at all. The answer
// comes from every charge, not the first page the statement loaded.
test("the statement heading names a category only when every charge has it", () => {
  const lake = addCat("Lake Home (stmt)");
  const carmel = addCat("Carmel Home (stmt)");
  for (const m of ["01", "02", "03"]) {
    tx("Ben Stmt", { amount: -11.99, date: `2026-${m}-08`, categoryId: lake });
    tx("Ben Stmt", { amount: -11.99, date: `2026-${m}-25`, categoryId: carmel });
  }
  assert.equal(transactionsSummary({ vendor: "Ben Stmt" }).categoryShared, false);

  for (const m of ["01", "02", "03"]) tx("Water Stmt", { amount: -40, date: `2026-${m}-03`, categoryId: lake });
  assert.equal(transactionsSummary({ vendor: "Water Stmt" }).categoryShared, true);
  assert.equal(transactionsSummary({}).categoryShared, undefined, "a list of many vendors has no heading");
});

// WHY: a bank can fold two bills into one new name. "Sofi Lending Loan Paymt"
// (the mortgage) and a personal loan both became "Sofi". As a vendor, "Sofi"
// has mixed amounts and its first charge was the loan, so it matched nothing:
// the mortgage read as lapsed beside its own continuation, "Sofi · 1st". Read
// plan by plan, the handoff is plain. The old name carries the user's name for
// it, so it stays canonical — a cadence override on the new name is a setting,
// not a name. And the level has its own guard: a catch-all descriptor has a plan at
// nearly every price, so the names must agree.
test("merge queue suggests a handoff into one plan of a vendor that carries several", () => {
  const mortgage = "Sofi Lending Loan Paymt";
  monthly(mortgage, [2025, 10], 9, -4397.28, 1, "Checking");
  setRecurringSetting(mortgage, { alias: "Sofi Mortgage (Carmel)" } as never);
  monthly("Sofi", [2026, 7], 3, -4453.91, 1, "Checking"); // a 1.3% escrow change
  monthly("Sofi", [2026, 6], 3, -1350.95, 21, "Checking", CAT_X); // the loan, under the same new name
  setRecurringSetting("Sofi", { cadence: "monthly" } as never); // a setting, but not a name
  const plans = detectRecurrings().map((r) => r.merchant).filter((m) => m.startsWith("Sofi")).sort();
  assert.deepEqual(plans, ["Sofi Lending Loan Paymt", "Sofi · 1st", "Sofi · 21st"], "fixture: the old plan and the new name's two");

  const [s, ...rest] = handoffSuggestions(new Set());
  assert.equal(rest.length, 0, "the loan plan is nobody's successor");
  assert.deepEqual(s.variants.map((v) => v.merchant), [mortgage, "Sofi"]);
  assert.match(s.note!, /^Its plan “Sofi · 1st” picks up where “Sofi Lending Loan Paymt” left off/);
  assert.equal(s.canonical, mortgage, "the side with the user's name for it");
  assert.equal(s.lowConfidence, false);

  approveMerge(s.canonical, s.variants.map((v) => v.merchant), s.categoryId);
  const after = detectRecurrings().filter((r) => r.merchant.startsWith("Sofi"));
  const byCount = after.map((r) => r.count).sort((a, b) => b - a);
  assert.deepEqual(byCount, [12, 3], "the mortgage is whole again, and the loan is still its own plan");

  // the same shape into a descriptor whose name shares nothing is not offered
  getDb().exec("DELETE FROM transactions; DELETE FROM recurrings; DELETE FROM merchant_links; DELETE FROM recurring_settings");
  monthly("Youtube Tv", [2025, 10], 6, -72.98, 10);
  monthly("Apple.com-bill", [2026, 4], 4, -74.89, 10);
  monthly("Apple.com-bill", [2025, 10], 10, -9.99, 22);
  detectRecurrings();
  assert.equal(handoffSuggestions(new Set()).length, 0);
});

// WHY: a split rule matches its amount to the cent, so an insurance renewal
// makes it stop applying without a word — the charge posts whole, the parts'
// plans read as overdue, and nothing says why. A charge from the rule's vendor
// within 10% of its amount is reported, with the same parts scaled to the new
// total so one tap repeats the split. The scaled parts must sum to the charge
// exactly, or the split route refuses them.
test("split drift: a price change that made a split rule miss is reported with parts to match", () => {
  const home = addCat("Home (split)"), cars = addCat("Cars (split)");
  createSplitRule("chubb", 1115.55, [
    { categoryId: home, amount: 847.75, label: "Carmel Home" },
    { categoryId: cars, amount: 267.8, label: "Cars" },
  ]);
  tx("Chubb", { amount: -1115.55, date: "2026-09-01", categoryId: CAT, hash: "old-price" });
  tx("Chubb", { amount: -1180.2, date: "2026-10-01", categoryId: CAT, hash: "new-price" });
  tx("Chubb", { amount: -544.94, date: "2026-10-17", categoryId: CAT, hash: "other-policy" });
  tx("Chubb", { amount: 1180.2, date: "2026-10-02", categoryId: CAT, hash: "refund" });
  assert.equal(applySplitRules(), 1, "the rule still splits the old price");
  const id = (hash: string) => (getDb().prepare("SELECT id FROM transactions WHERE hash = ?").get(hash) as { id: number }).id;

  const drift = transactionById(id("new-price"))!.splitDrift!;
  assert.equal(drift.ruleAmount, 1115.55);
  assert.deepEqual(drift.parts.map((p) => [p.label, p.amount, p.categoryId]), [["Carmel Home", 896.88, home], ["Cars", 283.32, cars]]);
  assert.equal(Number(drift.parts.reduce((a, p) => a + p.amount, 0).toFixed(2)), 1180.2, "to the cent");
  assert.equal(transactionById(id("other-policy"))!.splitDrift, null, "another policy from the same vendor is not a near miss");
  assert.equal(transactionById(id("refund"))!.splitDrift, null, "a credit is never split");
  assert.equal(transactionById(id("old-price"))!.splitDrift, null, "the split parent itself");
  assert.deepEqual(listTransactions({ month: "2026-10" }).filter((r) => r.splitMissed).map((r) => r.amount), [-1180.2], "the list tags exactly that row");

  // accepting it: a new rule at the new amount splits it, and the drift is gone
  createSplitRule("chubb", 1180.2, drift.parts);
  assert.equal(applySplitRules(), 1);
  const parts = getDb().prepare("SELECT merchant, amount FROM transactions WHERE hash LIKE 'new-price:s%' ORDER BY hash").all();
  assert.deepEqual(parts, [{ merchant: "Chubb — Carmel Home", amount: -896.88 }, { merchant: "Chubb — Cars", amount: -283.32 }], "the parts continue the same part-vendors");
  assert.equal(transactionById(id("new-price"))!.splitDrift, null);
  const refund = getDb().prepare("SELECT excluded, (SELECT COUNT(*) FROM transactions s WHERE s.hash LIKE 'refund:s%') parts FROM transactions WHERE hash = 'refund'").get();
  assert.deepEqual(refund, { excluded: 0, parts: 0 }, "a refund of exactly the rule's amount is not split into spending");
  assert.equal(undoSplit(id("old-price")), 1, "the old rule is still there to undo what it split");
});

// WHY: a split rule is an object the user made, so it must be readable and
// removable where the vendor is edited — it was invisible unless you found a
// charge it had split, and a price change leaves a vendor with two. The
// part-vendors a split creates ("Chubb — Cars") contain the rule's pattern in
// their names and must not list it as theirs. Removing means what "Undo split"
// means: the rule goes with everything it did, and the money counts whole again.
test("a vendor's shelf lists its split rules, and removing one restores what it split", () => {
  const home = addCat("Home (rules)"), cars = addCat("Cars (rules)");
  const parts = [{ categoryId: home, amount: 847.75, label: "Carmel Home" }, { categoryId: cars, amount: 267.8, label: "Cars" }];
  for (const d of ["2026-07-01", "2026-08-01", "2026-09-01"]) tx("Chubb", { amount: -1115.55, date: d, categoryId: CAT });
  tx("Chubb", { amount: -544.94, date: "2026-09-17", categoryId: CAT });
  createSplitRule("chubb", 1115.55, parts);
  createSplitRule("chubb", 1180.2, parts.map((p) => ({ ...p, amount: p.label === "Cars" ? 283.32 : 896.88 }))); // next year's price, not charged yet
  assert.equal(applySplitRules(), 3);
  const counted = () => (getDb().prepare("SELECT ROUND(SUM(amount), 2) s, COUNT(*) n FROM transactions WHERE excluded = 0").get() as { s: number; n: number });
  const before = counted();

  const rules = merchantSummary("Chubb").splitRules;
  assert.deepEqual(rules.map((r) => [r.amount, r.applied, r.parts.map((p) => p.label).join("+")]), [[1115.55, 3, "Carmel Home+Cars"], [1180.2, 0, "Carmel Home+Cars"]]);
  assert.deepEqual(merchantSummary("Chubb — Cars").splitRules, [], "a part-vendor is not the rule's vendor");
  assert.deepEqual(splitRulesFor(["Netflix"]), []);

  assert.equal(removeSplitRule(rules[0].id), 3, "three charges restored");
  assert.deepEqual(merchantSummary("Chubb").splitRules.map((r) => r.amount), [1180.2], "the other rule is untouched");
  const after = counted();
  assert.equal(after.s, before.s, "the same money counts, whole instead of in parts");
  assert.equal(after.n, before.n - 3, "six parts gone, three charges back");
  assert.equal((getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE hash LIKE '%:s%'").get() as { n: number }).n, 0);
  assert.equal(removeSplitRule(rules[1].id), 0, "a rule that never applied restores nothing, and goes");
  assert.equal(removeSplitRule(999999), null);
});

// ---- category suggestions from a model: TypeSafe first, Haiku as the fallback ----
import { proposeCategoriesWithTypeSafe, proposeCategories, CONFIDENCE } from "../src/lib/categorize";
import { categorizeSuggestionsAI, categorizeSuggestions, applyCategorization } from "../src/lib/categorizeSuggest";

// Answer the two APIs from a script, record what was sent, restore everything after.
// What a request to either API carried, as far as these tests read it.
type Wire = { model?: string; state: { merchant: string }; questions: { category: { type: string; criteria: Record<string, string> } }; messages: { content: string }[] };
async function withModelApis<T>(
  env: { typesafe?: boolean; anthropic?: boolean },
  typesafe: (merchant: string, body: Wire, call: number) => { status?: number; choice?: string; probabilities?: Record<string, number>; confidence?: number },
  run: (sent: { url: string; auth: string | null; body: Wire }[]) => Promise<T>,
  haiku?: (prompt: string) => { merchant: string; categoryId: number }[]
): Promise<T> {
  const saved = { fetch: globalThis.fetch, ts: process.env.TYPESAFE_API_KEY, an: process.env.ANTHROPIC_API_KEY };
  const sent: { url: string; auth: string | null; body: Wire }[] = [];
  let calls = 0;
  if (env.typesafe) process.env.TYPESAFE_API_KEY = "ts-test-key"; else delete process.env.TYPESAFE_API_KEY;
  if (env.anthropic) process.env.ANTHROPIC_API_KEY = "an-test-key"; else delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const raw = init?.body ?? (input instanceof Request ? input.body : null);
    const body = JSON.parse(typeof raw === "string" ? raw : await new Response(raw).text()) as Wire;
    sent.push({ url, auth: headers.get("authorization"), body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.includes("api.typesafe.ai")) {
      const r = typesafe(body.state.merchant, body, calls++);
      if (r.status && r.status !== 200) return json({ error: "x" }, r.status);
      return json({ model: "jev-latest", answers: { category: { type: "choice", choice: r.choice, probabilities: r.probabilities, confidence: r.confidence } }, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (url.includes("anthropic.com")) {
      const text = JSON.stringify(haiku ? haiku(body.messages[0].content) : []);
      return json({ id: "msg_test", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    throw new Error("unexpected request to " + url);
  }) as typeof fetch;
  try {
    return await run(sent);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.ts === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.ts;
    if (saved.an === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.an;
  }
}

// WHY: this is the one place the app's data leaves the machine, so what goes out
// is a contract: the merchant's name, the category names and kinds, and merchants
// already filed under each category. Never an amount, a date, an account or a
// note. And what comes back is only trusted when it names one of the user's
// categories; a rate-limited ask is retried, as the API requires.
test("TypeSafe ask: only names go out; the answer maps to the user's categories, best three first", async () => {
  const dining = addCat("Dining out (ask)"), dog = addCat("Cody (ask)");
  const cats = getDb().prepare("SELECT * FROM categories").all() as never[];
  const examples = new Map([[dog, ["Healthy Paws", "Pet Supplies Plus"]]]);
  await withModelApis(
    { typesafe: true },
    (merchant, _b, call) =>
      merchant === "Bark Avenue" && call === 0 ? { status: 429 }
      : merchant === "Bark Avenue" ? { choice: "Cody (ask)", confidence: 0.91, probabilities: { "Cody (ask)": 0.92, "Dining out (ask)": 0.05, Groceries: 0.03 } }
      : { choice: "A Category I Made Up", confidence: 0.99, probabilities: {} as Record<string, number> },
    async (sent) => {
      const out = await proposeCategoriesWithTypeSafe(["Bark Avenue", "Mystery Llc"], cats, examples);
      assert.deepEqual(out, [{ merchant: "Bark Avenue", categoryId: dog, confidence: 0.91, alternatives: [dog, dining, CAT] }]);
      assert.equal(sent.filter((s) => s.body.state.merchant === "Bark Avenue").length, 2, "the 429 was retried");
      for (const s of sent) {
        assert.equal(s.url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(s.auth, "Bearer ts-test-key");
        assert.deepEqual(Object.keys(s.body).sort(), ["model", "questions", "state"]);
        assert.deepEqual(Object.keys(s.body.state), ["merchant"], "the state is the merchant's name and nothing else");
        assert.equal(s.body.questions.category.type, "choice");
        assert.equal(s.body.questions.category.criteria["Cody (ask)"], "expense category. Merchants already filed here: Healthy Paws; Pet Supplies Plus");
        assert.equal(s.body.questions.category.criteria["Dining out (ask)"], "expense category");
      }
    }
  );
});

// WHY: Haiku answers every merchant with equal assurance, which is how a wrong
// guess used to look as good as a right one. TypeSafe's confidence sorts them:
// sure ones are suggestions, middling ones are "possible matches", and below the
// bar the model is guessing — 38% right in the 200-merchant test. A guess is
// still SHOWN: hiding it left the owner looking at "the model wasn't sure about
// 1 vendor" with no vendor and no answer in sight. It is labelled a guess,
// sorted last, and (like a possible match) never swept up by Apply all.
// Thresholds are CONFIDENCE, from that test.
test("model suggestions are tiered by confidence, and nothing but names leaves the machine", async () => {
  const dining = addCat("Dining out (tiers)");
  tx("Olive Garden", { amount: -84.31, date: "2026-08-02", categoryId: dining, account: "Visa 4417" });
  tx("Olive Garden", { amount: -61.07, date: "2026-08-20", categoryId: dining, account: "Visa 4417" });
  for (const [m, a] of [["Sure Bistro", -4321.09], ["Maybe Cafe", -55.5], ["Maybe Cafe", -12.25], ["Cryptic Llc 0042", -9.99]] as [string, number][])
    tx(m, { amount: a, date: "2026-09-10", categoryId: null, account: "Visa 4417" });
  const conf: Record<string, number> = { "Sure Bistro": 0.95, "Maybe Cafe": 0.62, "Cryptic Llc 0042": 0.31 };
  await withModelApis(
    { typesafe: true },
    (merchant) => ({ choice: "Dining out (tiers)", confidence: conf[merchant], probabilities: { "Dining out (tiers)": conf[merchant], Groceries: 1 - conf[merchant] } }),
    async (sent) => {
      assert.deepEqual([categorizeSuggestions().needsModelCount, categorizeSuggestions().suggestions.length], [3, 0], "before the ask: three vendors nobody has asked about");
      const asked = await categorizeSuggestionsAI();
      assert.deepEqual(asked, { asked: 3, answered: 3, provider: "typesafe" });
      const r = categorizeSuggestions(); // the page's read now carries the answers
      assert.deepEqual(
        r.suggestions.map((s) => [s.merchant, s.categoryId, s.possible ? "possible" : s.guess ? "guess" : "sure", s.count, s.source]),
        [["Sure Bistro", dining, "sure", 1, "ai"], ["Maybe Cafe", dining, "possible", 2, "ai"], ["Cryptic Llc 0042", dining, "guess", 1, "ai"]],
        "all three are shown, in order of how far to trust them"
      );
      assert.deepEqual(r.suggestions[0].alternatives, [dining, CAT]);
      assert.equal(r.needsModelCount, 0, "nobody is left to ask");
      assert.ok(CONFIDENCE.show <= 0.62 && 0.62 < CONFIDENCE.sure && 0.31 < CONFIDENCE.show);
      const wire = JSON.stringify(sent.map((s) => s.body));
      assert.ok(wire.includes("Olive Garden"), "a filed merchant is the category's example");
      assert.ok(!/Sure Bistro[^"]*;|; ?Sure Bistro/.test(JSON.stringify(sent[0].body.questions)), "a merchant being asked about is never its own example");
      for (const secret of ["4321.09", "84.31", "61.07", "Visa 4417", "2026-09-10", "2026-08-02"]) assert.ok(!wire.includes(secret), `${secret} stayed home`);
    }
  );
});

// WHY: the queue asks the model on its own when the page loads — a suggestion
// you have to press a button to see is one you mostly don't see. So the answer
// has to be remembered, or every reload would send the same names out again and
// get the same "not sure" back. It holds for the category list it was given:
// add a category and the vendor deserves a fresh look. A vendor the provider
// could not answer is NOT remembered, so a rate limit doesn't become "unsure".
test("a model answer is remembered per vendor, re-asked only when the categories change", async () => {
  const dining = addCat("Dining out (memory)");
  tx("Corner Bistro", { amount: -20, date: "2026-09-10", categoryId: null });
  tx("Cryptic Llc 0042", { amount: -9.99, date: "2026-09-10", categoryId: null });
  tx("Flaky Vendor", { amount: -5, date: "2026-09-10", categoryId: null });
  const reply = (merchant: string) =>
    merchant === "Flaky Vendor" ? { choice: "No Such Category", confidence: 0.9, probabilities: {} as Record<string, number> }
    : { choice: "Dining out (memory)", confidence: merchant === "Corner Bistro" ? 0.93 : 0.2, probabilities: { "Dining out (memory)": 0.9 } };
  await withModelApis({ typesafe: true }, reply, async (sent) => {
    assert.deepEqual(await categorizeSuggestionsAI(), { asked: 3, answered: 2, provider: "typesafe" });
    assert.equal(sent.length, 3);
    // a second page load: only the unanswered vendor goes out again
    assert.deepEqual(await categorizeSuggestionsAI(), { asked: 1, answered: 0, provider: "typesafe" });
    assert.deepEqual(sent.slice(3).map((s) => s.body.state.merchant), ["Flaky Vendor"]);
    const r = categorizeSuggestions();
    assert.deepEqual([r.suggestions.map((s) => [s.merchant, !!s.guess]), r.needsModelCount], [[["Corner Bistro", false], ["Cryptic Llc 0042", true]], 1]);
    // the user applies it: the vendor leaves the queue for good
    applyCategorization("Corner Bistro", dining);
    assert.deepEqual(categorizeSuggestions().suggestions.map((s) => s.merchant), ["Cryptic Llc 0042"]);
    // a new category changes what could be said: everyone still waiting is asked afresh
    addCat("Pet care (memory)");
    assert.equal((await categorizeSuggestionsAI()).asked, 2, "the guessed-at vendor and the unanswered one");
  });
});

// WHY: a provider being down must not take suggestions away when the other key
// is there — and with no fallback the failure must be loud, not an empty list
// that reads as "the model had no suggestions" (Rule 12).
test("when TypeSafe cannot be reached, Haiku answers; with no fallback the failure is loud", async () => {
  const cats = getDb().prepare("SELECT * FROM categories").all() as never[];
  await withModelApis({ typesafe: true, anthropic: true }, () => ({ status: 500 }), async () => {
    const r = await proposeCategories(["Corner Store"], cats);
    assert.equal(r.provider, "haiku");
    assert.deepEqual(r.proposals, [{ merchant: "Corner Store", categoryId: CAT }], "and says nothing about confidence");
  }, () => [{ merchant: "Corner Store", categoryId: CAT }]);
  await withModelApis({ typesafe: true }, () => ({ status: 500 }), async () => {
    await assert.rejects(() => proposeCategories(["Corner Store"], cats), /TypeSafe 500/);
  });
  await withModelApis({}, () => ({}), async (sent) => {
    assert.deepEqual(await proposeCategories(["Corner Store"], cats), { provider: null, proposals: [] });
    assert.equal(sent.length, 0, "no key, no request");
  });
});

// WHY: a finished month is a fact. Whether a month is still in progress was read
// from the date of its last transaction, so a closed month whose last charge
// fell before the final day had "days remaining": it was run-rated, shown as
// "net cash flow, projected" with its real figures captioned "so far". Only the
// month we are in can be projected.
test("a finished month is never projected, however early its last charge fell", () => {
  const inc = addCat("Salary (closed)", "income");
  setBudget(CAT, 900);
  for (const mth of ["2025-01", "2025-02"]) {
    tx("Employer", { amount: 5000, date: `${mth}-01`, categoryId: inc });
    for (const d of ["03", "08", "12", "16", "20"]) tx("Corner Shop", { amount: -100, date: `${mth}-${d}`, categoryId: CAT });
  }
  const d = dashboard("2025-02"); // last charge on the 20th of a 28-day month
  assert.equal(d.pace.projectedMonthEnd, null);
  assert.equal(d.projectedIncome, null);
  assert.equal(d.projectedNet, null);
  assert.equal(d.budget?.projected, d.budget?.spent, "the budget's outcome is what was spent");
  assert.equal(d.net, 4500);
  assert.ok(d.pace.series.every((p) => p.projected == null), "and the chart draws no dashed forecast");
});

// WHY: a vendor with no category that is also a duplicate candidate ("Dga"
// beside the monthly "Dgappcare Chicago" bill) has one decision, not two: is it
// that vendor? Combine sets its category. The category queue used to guess at
// it too ("Other, a guess"), and Apply-then-Combine left the charge under the
// guess for good: the merge fills only still-uncategorized charges, and the
// guess had been learned as the vendor's rule. So while a merge is pending the
// vendor is deferred (no proposal, no model call) and the merge card names
// what Combine sets; dismiss the merge and the proposal comes back.
test("an uncategorized duplicate candidate is deferred to the merge, which names the category it sets", async () => {
  const home = addCat("Carmel Home (defer)");
  const last = daysAgo(28);
  const rid = Number(
    getDb()
      .prepare("INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count) VALUES (?,?,?,?,?,?,?)")
      .run("Dgappcare Chicago", home, -29, "monthly", last, daysAgo(-2), 3).lastInsertRowid
  );
  for (const d of [daysAgo(88), daysAgo(58), last]) tx("Dgappcare Chicago", { amount: -29, date: d, categoryId: home, recurringId: rid });
  tx("Dga", { amount: -29.41, date: daysAgo(0), categoryId: null });

  const merge = allMergeSuggestions().find((g) => g.variants.some((v) => v.merchant === "Dga"));
  assert.ok(merge && merge.canonical === "Dgappcare Chicago", "the merge queue holds Dga as a candidate for the bill");
  assert.ok(merge!.lowConfidence, "a borderline name: the card is a possible match");
  assert.match(merge!.note ?? "", /combining sets its category to Carmel Home \(defer\)/, "the possible-match card says what Combine sets");

  const before = categorizeSuggestions();
  assert.deepEqual(before.deferred, [{ merchant: "Dga", count: 1, to: "Dgappcare Chicago" }], "the category queue defers Dga to the merge");
  assert.ok(!before.suggestions.some((s) => s.merchant === "Dga"), "no proposal of its own");
  assert.equal(before.needsModelCount, 0, "and the model is not asked about it");
  await withModelApis({ typesafe: true }, () => ({ choice: "Other", confidence: 0.5, probabilities: { Other: 0.5 } }), async (sent) => {
    assert.deepEqual(await categorizeSuggestionsAI(), { asked: 0, answered: 0, provider: null });
    assert.equal(sent.length, 0, "nothing leaves the machine for a deferred vendor");
  });

  for (const k of merge!.dismissKeys) dismissMerge(k);
  const after = categorizeSuggestions();
  assert.deepEqual(after.deferred, [], "the merge dismissed, Dga is no longer deferred");
  assert.equal(after.needsModelCount, 1, "and is back in the queue, waiting on the model");
});

// WHY: a plan's key is rebuilt from the detector's guess ("Ben · 25th"), so
// when the bill moves day or price the key changes and the owner's name,
// amount and pins are orphaned (the real data holds two such orphans). A
// confirmed plan is frozen under the key it had when the owner touched it.
// Confirming must record the plan as it stands, never overwrite a frozen
// plan, and leave alone a single-plan vendor, whose bare key is its name.
test("confirming a plan freezes it under its key; a second confirm changes nothing", () => {
  const planRow = (key: string) =>
    getDb().prepare("SELECT key, vendor, amount, day, cadence, categoryId, anchorDate FROM plans WHERE key = ?").get(key);
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx("Ben Frozen", { amount: -11.99, date: `2026-${m}-08` });
    tx("Ben Frozen", { amount: -11.99, date: `2026-${m}-25` });
  }
  const keys = detectRecurrings().map((r) => r.merchant).filter((k) => k.startsWith("Ben Frozen")).sort();
  assert.deepEqual(keys, ["Ben Frozen · 25th", "Ben Frozen · 8th"], "fixture: two plans split by day");

  assert.equal(confirmPlan("Ben Frozen · 25th"), true);
  const frozen = { key: "Ben Frozen · 25th", vendor: "Ben Frozen", amount: -11.99, day: 25, cadence: "monthly", categoryId: null, anchorDate: "2026-06-25" };
  assert.deepEqual(planRow("Ben Frozen · 25th"), frozen, "the plan as it stood: its signed amount, its billing day, its newest charge");

  // The bill moves: July posts on the 27th at a new price, and plans rebuild.
  tx("Ben Frozen", { amount: -12.99, date: "2026-07-27" });
  detectRecurrings();
  assert.equal(confirmPlan("Ben Frozen · 25th"), true);
  assert.deepEqual(planRow("Ben Frozen · 25th"), frozen, "confirming again keeps the first: only the owner's edits change it");

  unconfirmPlan("Ben Frozen · 25th");
  assert.equal(planRow("Ben Frozen · 25th"), undefined, "un-confirmed: derived again");

  // One plan under the vendor: its key is the vendor's own name, already stable.
  for (const m of ["01", "02", "03", "04"]) tx("Solo Water", { amount: -40, date: `2026-${m}-03` });
  detectRecurrings();
  assert.equal(confirmPlan("Solo Water"), false);
  assert.equal(planRow("Solo Water"), undefined);
  assert.equal(confirmPlan("No Such Plan"), false, "nothing to confirm");

  // A bare key beside the vendor's other plan could be rebuilt as either: it is confirmed.
  const ins = getDb().prepare("INSERT INTO recurrings (merchant, avgAmount, cadence, lastDate, nextDate, count) VALUES (?, ?, 'monthly', ?, ?, 3)");
  ins.run("Twin Bare", -11.99, "2026-06-08", "2026-07-08");
  ins.run("Twin Bare · $20", -20, "2026-06-25", "2026-07-25");
  assert.equal(confirmPlan("Twin Bare"), true);
  assert.equal((planRow("Twin Bare") as { day: number }).day, 8);

  ensurePlans(getDb());
  assert.notEqual(planRow("Twin Bare"), undefined, "ensuring the table again keeps what it holds");
});

// Confirmed plans take their charges before the detector sees the vendor.
const planOf = (merchant: string, date: string) =>
  (getDb()
    .prepare("SELECT r.merchant AS plan FROM transactions t LEFT JOIN recurrings r ON r.id = t.recurringId WHERE t.merchant = ? AND t.date = ?")
    .get(merchant, date) as { plan: string | null } | undefined)?.plan ?? null;
const idOn = (merchant: string, date: string) =>
  (getDb().prepare("SELECT id FROM transactions WHERE merchant = ? AND date = ?").get(merchant, date) as { id: number }).id;

// WHY: the owner names Ben Franklin's 25th plan "Carmel". When that bill
// moves to the 27th, the detector rebuilds the plan under a new key and the
// name is orphaned (the real data holds two such orphans). A confirmed plan
// keeps its key and takes the moved charges: same plan, same name.
test("a confirmed plan keeps its key and its charges when the bill moves day", () => {
  const v = "Ben Moves";
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx(v, { amount: -11.99, date: `2026-${m}-08` });
    tx(v, { amount: -11.99, date: `2026-${m}-25` });
  }
  detectRecurrings();
  setRecurringSetting(`${v} · 25th`, { alias: "Carmel" });
  assert.equal(confirmPlan(`${v} · 25th`), true);
  for (const m of ["07", "08", "09"]) {
    tx(v, { amount: -11.99, date: `2026-${m}-08` });
    tx(v, { amount: -11.99, date: `2026-${m}-27` });
  }
  const plans = detectRecurrings().filter((r) => r.merchant.startsWith(v));
  assert.equal(plans.length, 2, `still two plans: ${plans.map((r) => r.merchant).join(", ")}`);
  assert.equal(planOf(v, "2026-09-27"), `${v} · 25th`, "the moved charge is Carmel's");
  assert.equal(plans.find((r) => r.merchant === `${v} · 25th`)!.count, 9);
  assert.equal(planOf(v, "2026-09-08"), `${v} · 8th`, "the other house is untouched");
  const day = (getDb().prepare("SELECT day FROM plans WHERE key = ?").get(`${v} · 25th`) as { day: number }).day;
  assert.equal(day, 27, "the plan follows its bill to the 27th");
});

// WHY: two confirmed plans at one amount are told apart by the day they bill.
// A charge that posts a day early, or late into the other house's week, must
// still land in its own house, and a month's second charge goes to the plan
// not yet paid that month rather than doubling the one that was.
test("confirmed plans at one amount take charges by billing day, one per month", () => {
  const v = "Ben Routes";
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx(v, { amount: -11.99, date: `2026-${m}-08` });
    tx(v, { amount: -11.99, date: `2026-${m}-25` });
  }
  detectRecurrings();
  confirmPlan(`${v} · 8th`);
  confirmPlan(`${v} · 25th`);
  tx(v, { amount: -11.99, date: "2026-07-24" }); // a day early
  tx(v, { amount: -11.99, date: "2026-07-17" }); // late, nearer the 25th, but July's 25th is paid
  detectRecurrings();
  assert.equal(planOf(v, "2026-07-24"), `${v} · 25th`);
  assert.equal(planOf(v, "2026-07-17"), `${v} · 8th`, "the 8th has no July charge yet");
});

// WHY: Apple bills subscriptions and sells devices under one name. Forced as
// recurring, the vendor used to become one plan of every charge. Its
// confirmed subscriptions keep their charges; a purchase, and a refund at a
// subscription's price, belong to no plan.
test("a forced vendor's confirmed plans leave its purchases and refunds out", () => {
  const v = "Apple Firm";
  for (const m of ["01", "02", "03", "04", "05"]) {
    tx(v, { amount: -9.99, date: `2026-${m}-02` });
    tx(v, { amount: -14.99, date: `2026-${m}-26` });
  }
  tx(v, { amount: -999, date: "2026-03-15" });
  tx(v, { amount: -4.99, date: "2026-04-11" });
  tx(v, { amount: 9.99, date: "2026-05-03" }); // a refund at the iCloud price
  setRecurringOverride(v, "force");
  const keys = detectRecurrings().filter((r) => r.merchant.startsWith(v)).map((r) => r.merchant).sort();
  for (const k of keys) confirmPlan(k);
  const plans = detectRecurrings().filter((r) => r.merchant.startsWith(v));
  assert.deepEqual(plans.map((r) => [r.merchant, r.count]).sort(), keys.map((k) => [k, 5]).sort(), "two subscriptions, five charges each");
  for (const d of ["2026-03-15", "2026-04-11", "2026-05-03"]) assert.equal(planOf(v, d), null, `${d} is in no plan`);
});

// WHY: a charge the owner puts in a plan is that plan's, whatever its amount
// (a price rise's first charge), and a detected plan never takes a confirmed
// plan's key: two plans under one key would share a name and settings.
test("a pin joins its confirmed plan; a detected plan never takes a confirmed key", () => {
  const v = "Ben Pinned";
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx(v, { amount: -11.99, date: `2026-${m}-08` });
    tx(v, { amount: -11.99, date: `2026-${m}-25` });
  }
  detectRecurrings();
  confirmPlan(`${v} · 25th`);
  tx(v, { amount: -12.99, date: "2026-07-25" });
  setTransactionRecurringIncluded(idOn(v, "2026-07-25"), `${v} · 25th`);
  detectRecurrings();
  assert.equal(planOf(v, "2026-07-25"), `${v} · 25th`, "the pinned charge at the new price");
  for (const m of ["08", "09", "10", "11"]) tx(v, { amount: -12.99, date: `2026-${m}-25` });
  const keys = detectRecurrings().filter((r) => r.merchant.startsWith(v)).map((r) => r.merchant);
  assert.equal(new Set(keys).size, keys.length, `no key twice: ${keys.join(", ")}`);
  assert.equal(planOf(v, "2026-06-25"), `${v} · 25th`, "the confirmed plan keeps its history");
});

// WHY: a plan's history is not one amount. The Sofi mortgage paid $4,315.18,
// then $4,388.48, then $4,397.28 as escrow changed; matched by today's amount
// alone, confirming it dropped 32 of its 35 charges. A confirmed plan keeps
// the charges it held, whatever they cost; amount matching is for new ones.
test("a confirmed plan keeps its history across price changes", () => {
  const v = "Loan Escrow";
  const months = ["2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
  months.forEach((m, i) => tx(v, { amount: i < 6 ? -4315.18 : -4397.28, date: `${m}-01` }));
  const key = detectRecurrings().find((r) => r.merchant === v)!.merchant;
  // Ben Franklin-style: one plan of two, so the bare key can be confirmed.
  for (const m of ["2026-03", "2026-04", "2026-05", "2026-06"]) tx(v, { amount: -52, date: `${m}-21` });
  const plans = detectRecurrings().filter((r) => r.merchant.startsWith(v));
  const loan = plans.find((r) => r.count === 12)!;
  assert.ok(loan, `fixture: the loan plan holds all twelve (${plans.map((r) => `${r.merchant} x${r.count}`).join(", ")}; first ${key})`);
  setRecurringSetting(loan.merchant, { expectedAmount: 4397.28 });
  assert.equal(confirmPlan(loan.merchant), true);
  tx(v, { amount: -4397.28, date: "2026-07-01" });
  const after = detectRecurrings().find((r) => r.merchant === loan.merchant)!;
  assert.equal(after.count, 13, "every past payment stays, and July's joins");
});

// WHY: beside a confirmed plan, a plan the detector reads as the vendor's
// only one keeps its day ("Ben · 8th", not "Ben"). Another bank descriptor's
// plan under the same vendor is not that: renaming it ("Youtube Tv Go G.co
// Helppay" to "· 30th") would orphan whatever the owner set on it.
test("another descriptor's plan keeps its name beside a confirmed plan", () => {
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx("Tube Tv", { amount: -10, date: `2026-${m}-03` });
    tx("Tube Tv", { amount: -20, date: `2026-${m}-20` });
    tx("Tube Tv Go Helppay", { amount: -72.98, date: `2026-${m}-28` });
  }
  const before = detectRecurrings().map((r) => r.merchant).filter((k) => k.startsWith("Tube Tv")).sort();
  assert.ok(before.includes("Tube Tv Go Helppay"), `fixture: the other descriptor is its own plan (${before.join(", ")})`);
  confirmPlan(before.find((k) => k.startsWith("Tube Tv ·"))!);
  const after = detectRecurrings().map((r) => r.merchant).filter((k) => k.startsWith("Tube Tv")).sort();
  assert.deepEqual(after, before);
});

// WHY: when a bill's price rises, its first charge at the new price is outside
// the plan's amount, so the owner puts it in by hand. That pin must move the
// plan to the new price, or every later charge needs a pin too.
test("putting a charge in a plan confirms it and moves it to the charge's price", () => {
  const v = "Ben Raise";
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx(v, { amount: -11.99, date: `2026-${m}-08` });
    tx(v, { amount: -11.99, date: `2026-${m}-25` });
  }
  detectRecurrings();
  const key = `${v} · 25th`;
  confirmPlan(key); // named months ago, at $11.99
  tx(v, { amount: -12.99, date: "2026-07-25" });
  detectRecurrings();
  setTransactionRecurringIncluded(idOn(v, "2026-07-25"), key);
  detectRecurrings();
  planTookCharge(key, idOn(v, "2026-07-25"));
  assert.equal((getDb().prepare("SELECT amount FROM plans WHERE key = ?").get(key) as { amount: number }).amount, -12.99);
  tx(v, { amount: -12.99, date: "2026-08-25" });
  detectRecurrings();
  assert.equal(planOf(v, "2026-08-25"), key, "August's charge at the new price joins without a pin");
  assert.equal(planOf(v, "2026-06-25"), key, "and the plan keeps its history");
});

// WHY: "Not recurring" and "Reset all" hand a plan back to the detector. A
// muted vendor whose confirmed plans stayed confirmed would keep claiming
// charges the user said are not a bill.
test("not recurring un-confirms a plan, or every plan of a vendor", () => {
  const ins = getDb().prepare("INSERT INTO plans (key, vendor, amount, day, cadence, anchorDate) VALUES (?, ?, -10, 1, 'monthly', '2026-06-01')");
  for (const k of ["Mute Co · 1st", "Mute Co · 15th", "Other Co · 3rd"]) ins.run(k, k.split(" · ")[0]);
  const keys = () => (getDb().prepare("SELECT key FROM plans ORDER BY key").all() as { key: string }[]).map((r) => r.key);
  unconfirmPlansFor("Mute Co · 15th");
  assert.deepEqual(keys(), ["Mute Co · 1st", "Other Co · 3rd"], "one plan muted: that plan");
  unconfirmPlansFor("Mute Co");
  assert.deepEqual(keys(), ["Other Co · 3rd"], "the vendor muted: all of its plans");
});

// WHY: setting a category on one plan is the owner's word on it, so the plan
// is confirmed; a confirmed plan whose bill moved day shows the day it bills
// now, not the one in its key; and the Recurrings page never folds a
// confirmed plan into a look-alike.
test("a per-plan category confirms it; its day and its row stay its own", () => {
  const home = addCat("Home (firm)");
  const v = "Ben Firm";
  for (const m of ["01", "02", "03", "04", "05", "06"]) {
    tx(v, { amount: -11.99, date: `2026-${m}-08` });
    tx(v, { amount: -11.99, date: `2026-${m}-25` });
  }
  detectRecurrings();
  const id = (getDb().prepare("SELECT id FROM recurrings WHERE merchant = ?").get(`${v} · 25th`) as { id: number }).id;
  assert.equal(applyRecategorize(v, home, id), "plan");
  assert.notEqual(getDb().prepare("SELECT 1 FROM plans WHERE key = ?").get(`${v} · 25th`), undefined, "confirmed");
  tx(v, { amount: -11.99, date: "2026-07-27" });
  detectRecurrings();
  const day = merchantSummary(v).planList.find((p) => p.key === `${v} · 25th`)!.day;
  assert.equal(day, "27th", "the day it bills now");

  // Two bare plans a fold would take for one vendor's clones.
  for (const m of ["03", "04", "05", "06"]) {
    tx("Clone Co", { amount: -30, date: `2026-${m}-10`, categoryId: home });
    tx("Clone Co Pl", { amount: -30, date: `2026-${m}-12`, categoryId: home });
  }
  detectRecurrings();
  const faces = () => recurringsForMonth("2026-06").filter((r) => r.merchant.startsWith("Clone Co")).length;
  assert.equal(faces(), 1, "fixture: unconfirmed, they fold into one face");
  getDb().prepare("INSERT INTO plans (key, vendor, amount, day, cadence, anchorDate) VALUES ('Clone Co', 'Clone Co', -30, 10, 'monthly', '2026-06-10')").run();
  assert.equal(faces(), 2, "a confirmed plan is a bill of its own");
});
