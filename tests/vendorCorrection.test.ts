import { cleanDbBeforeEach, tx, addCat, detectAndConfirm } from "./helpers"; // first: points the DB at a throwaway file
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { detectRecurrings } from "../src/lib/core";
import { applyRecategorize, distinctVendors, listTransactions, merchantSummary, setTransactionCategory } from "../src/lib/queries";
import { setChargeVendor, createVendorRule, deleteVendorRule, applyVendorRules, ruleMatches } from "../src/lib/vendorMoves";

cleanDbBeforeEach();

// The household's two Google subscriptions as the bank sends them: Google One
// ($19.99, the 3rd) under "Google One" until October, Workspace ($8.40, the
// 1st) under "Workspace" in June and "Google" since. Then Google One's
// October charge arrives as "Google" too. Sample amounts; the repo is public.
function twoGoogles() {
  const subs = addCat("Subscriptions");
  const work = addCat("Work Expenses");
  for (const m of ["06", "07", "08", "09"]) tx("Google One", { amount: -19.99, date: `2026-${m}-03`, account: "Card", categoryId: subs });
  tx("Workspace", { amount: -8.4, date: "2026-06-01", account: "Card", categoryId: work });
  for (const m of ["07", "08", "09", "10"]) tx("Google", { amount: -8.4, date: `2026-${m}-01`, account: "Card", categoryId: subs });
  tx("Google", { amount: -19.99, date: "2026-10-03", account: "Card", categoryId: subs });
  detectAndConfirm();
  const oct3 = (getDb().prepare("SELECT hash, id FROM transactions WHERE merchant = 'Google' AND amount = -19.99").get() as { hash: string; id: number });
  return { subs, work, oct3 };
}
const view = (vendor: string) => {
  const s = merchantSummary(vendor) as { count: number; spent: number; categoryId: number | null };
  return { count: s.count, spent: s.spent, categoryId: s.categoryId };
};
const planOf = (id: number) =>
  (getDb().prepare("SELECT r.merchant, r.count FROM transactions t LEFT JOIN recurrings r ON r.id = t.recurringId WHERE t.id = ?").get(id) as { merchant: string | null; count: number | null });
const totalSpent = () => distinctVendors().reduce((a, v) => a + view(v.merchant).spent, 0);

test("a moved charge leaves its bank name's vendor and joins the one it was moved to: name, totals and plan", () => {
  // WHY: one bank name can hold two subscriptions. Grouped by the name, the
  // $19.99 counted as Workspace's, under Workspace's name, and Google One
  // read as unpaid in October.
  const { oct3 } = twoGoogles();
  setChargeVendor(oct3.hash, "Google One", "user");
  detectRecurrings();
  assert.deepEqual(view("Google"), { count: 4, spent: 33.6, categoryId: view("Google").categoryId }, "Google keeps its four $8.40s");
  assert.equal(view("Google One").count, 5, "Google One has its five $19.99s");
  assert.equal(listTransactions({ q: "Google" }).find((t) => t.id === oct3.id)?.displayName, "Google One", "and the row reads Google One");
  const p = planOf(oct3.id);
  assert.equal(p.merchant, "Google One", "it is in Google One's plan by the ordinary rules, not a cross-vendor pin");
  assert.equal(listTransactions({ vendor: "Google" }).some((t) => t.id === oct3.id), false, "the Google vendor's list leaves it out");
  assert.equal(listTransactions({ vendor: "Google One" }).some((t) => t.id === oct3.id), true, "and Google One's list has it");
  assert.equal(listTransactions({ q: "Google One" }).some((t) => t.id === oct3.id), true, "searching its new vendor finds it");
});

test("a move neither makes nor loses money: spend across every vendor is the same, to the cent", () => {
  // WHY: a move re-labels a charge. If it double-counted or dropped one, every
  // total built on vendors would be wrong without a sign.
  const { oct3 } = twoGoogles();
  const before = totalSpent();
  setChargeVendor(oct3.hash, "Google One", "user");
  detectRecurrings();
  assert.equal(totalSpent().toFixed(2), before.toFixed(2));
});

test("Reset puts everything back as it was: vendors, totals and plans", () => {
  // WHY: the edit must be reversible, or a wrong move is a permanent one.
  const { oct3 } = twoGoogles();
  const snap = () => JSON.stringify([view("Google"), view("Google One"), planOf(oct3.id), getDb().prepare("SELECT merchant, count, avgAmount FROM recurrings ORDER BY merchant").all()]);
  detectRecurrings();
  const before = snap();
  setChargeVendor(oct3.hash, "Google One", "user");
  detectRecurrings();
  assert.notEqual(snap(), before);
  setChargeVendor(oct3.hash, null, "user");
  detectRecurrings();
  assert.equal(snap(), before);
});

test("setting a category on a vendor leaves a charge moved out of it alone", () => {
  // WHY: the owner's case. Giving Workspace's $8.40s Work Expenses dragged
  // Google One's $19.99 along, because both are "Google" to the bank.
  const { work, subs, oct3 } = twoGoogles();
  setChargeVendor(oct3.hash, "Google One", "user");
  detectRecurrings();
  applyRecategorize("Google", work, null, true);
  const cats = getDb().prepare("SELECT amount, categoryId FROM transactions WHERE merchant = 'Google'").all() as { amount: number; categoryId: number }[];
  assert.ok(cats.filter((c) => c.amount === -8.4).every((c) => c.categoryId === work), "the $8.40s move");
  assert.equal(cats.find((c) => c.amount === -19.99)?.categoryId, subs, "the moved $19.99 doesn't");
});

test("a moved charge takes its vendor's category, unless the owner set the charge's own", () => {
  // WHY: a charge belongs with its vendor's others; but a category the owner
  // chose on the charge is their word, and a move must not undo it.
  const { work, subs, oct3 } = twoGoogles();
  const ws = getDb().prepare("SELECT hash, id FROM transactions WHERE merchant = 'Google' AND date = '2026-10-01'").get() as { hash: string; id: number };
  setChargeVendor(ws.hash, "Workspace", "user");
  assert.equal((getDb().prepare("SELECT categoryId FROM transactions WHERE id = ?").get(ws.id) as { categoryId: number }).categoryId, work);
  setTransactionCategory(oct3.id, work);
  setChargeVendor(oct3.hash, "Google One", "user");
  assert.equal((getDb().prepare("SELECT categoryId FROM transactions WHERE id = ?").get(oct3.id) as { categoryId: number }).categoryId, work, "set by hand: kept");
  void subs;
});

test("the owner's move beats a rule, a rule beats plan matching, and undoing one falls back a step", () => {
  // WHY: the most specific word wins: the owner on this charge, then the
  // owner's rule for charges like it, then the system's guess.
  const { oct3 } = twoGoogles();
  const held = () => getDb().prepare("SELECT vendor, origin FROM charge_vendors WHERE hash = ?").get(oct3.hash) as { vendor: string; origin: string } | undefined;
  setChargeVendor(oct3.hash, "Google One", "auto");
  assert.deepEqual(held(), { vendor: "Google One", origin: "auto" });
  createVendorRule("Google", 19.99, "Google One Go G.co Helppay");
  assert.equal(held()?.origin, "rule", "a rule replaces a guess");
  assert.equal(setChargeVendor(oct3.hash, "Google One", "auto"), false, "a guess doesn't replace a rule");
  setChargeVendor(oct3.hash, "Workspace", "user");
  assert.deepEqual(held(), { vendor: "Workspace", origin: "user" });
  applyVendorRules();
  assert.equal(held()?.origin, "user", "a rule doesn't replace the owner's move");
  setChargeVendor(oct3.hash, null, "user");
  assert.equal(held()?.origin, "rule", "Reset falls back to the rule");
});

test("a rule moves the bank name's charges at its amount, past and arriving, and removing it puts them back", () => {
  // WHY: the bank will keep sending Google One as "Google"; one correction
  // a month is a chore. A rule is the standing answer, and is undoable.
  const { oct3 } = twoGoogles();
  assert.deepEqual(ruleMatches("Google", -19.99).map((m) => m.hash), [oct3.hash], "the preview lists the charges it would move");
  const id = createVendorRule("Google", 19.99, "Google One");
  tx("Google", { amount: -19.99, date: "2026-11-03", account: "Card" });
  tx("Google", { amount: -8.4, date: "2026-11-01", account: "Card" });
  assert.equal(applyVendorRules(), 1, "November's $19.99 moves as it lands; the $8.40 stays");
  detectRecurrings();
  assert.equal(view("Google One").count, 6);
  assert.equal(view("Google").count, 5);
  deleteVendorRule(id);
  detectRecurrings();
  assert.equal(view("Google One").count, 4);
  assert.equal(view("Google").count, 7);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM charge_vendors").get() as { n: number }).n, 0);
});
