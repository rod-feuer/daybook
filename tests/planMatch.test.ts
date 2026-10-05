import { cleanDbBeforeEach, tx, detectAndConfirm } from "./helpers"; // first: points the DB at a throwaway file
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { detectRecurrings } from "../src/lib/core";
import { setTransactionRecurringExcluded, transactionById } from "../src/lib/queries";
import { applyPlanMatches, scorePlanMatches, dismissPlanMatch } from "../src/lib/planMatch";

cleanDbBeforeEach();
const TODAY = "2026-10-05";

// The household's two Google vendors, as the owner's data has them: Google One
// ($19.99 on the 3rd) and Workspace, named "Google" ($8.40 on the 1st), both
// on one card. Sample amounts only; the repo is public.
function twoGoogles() {
  for (const m of ["06", "07", "08", "09"]) {
    tx("Google One", { amount: -19.99, date: `2026-${m}-03`, account: "Card" });
    tx("Google", { amount: -8.4, date: `2026-${m}-01`, account: "Card" });
  }
  tx("Google", { amount: -8.4, date: "2026-10-01", account: "Card" });
  detectAndConfirm();
}
const newCharge = (o: { merchant?: string; amount?: number; date?: string; account?: string } = {}) => {
  tx(o.merchant ?? "Google", { amount: o.amount ?? -19.99, date: o.date ?? "2026-10-03", account: o.account ?? "Card" });
  return (getDb().prepare("SELECT id FROM transactions ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
};
const planOf = (id: number) =>
  (getDb().prepare("SELECT r.merchant FROM transactions t LEFT JOIN recurrings r ON r.id = t.recurringId WHERE t.id = ?").get(id) as { merchant: string | null }).merchant;

test("a bill's charge under a sibling vendor's name joins that bill on its own, and reads as auto", () => {
  // WHY: the bank renamed Google One's charge and Plaid cleaned it to
  // "Google", the Workspace vendor. Grouped by name it lands in Workspace's
  // $8.40 plan, and Google One reads unpaid. Name, amount to the cent, day, and card all agree,
  // so it joins Google One without asking; it was Daybook's call, so no
  // "edited" tag, and "Not in plan" still undoes it.
  twoGoogles();
  const id = newCharge();
  detectRecurrings();
  assert.equal(planOf(id), "Google", "grouped by name alone, Workspace's plan takes it, at more than twice its price");
  assert.equal(applyPlanMatches(TODAY), 1);
  detectRecurrings();
  assert.equal(planOf(id), "Google One");
  const ws = getDb().prepare("SELECT avgAmount FROM recurrings WHERE merchant = 'Google'").get() as { avgAmount: number };
  assert.equal(ws.avgAmount, -8.4, "and Workspace's bill is its own price again");
  const t = transactionById(id)!;
  assert.equal(t.recurringIncluded, 0, "not the owner's pin: no edited tag");
});

test("a charge the owner marked Not in plan is suggested, never joined for them", () => {
  // WHY: the mark doesn't say which plan it meant. Joining it anyway would
  // overrule the owner; asking respects it.
  twoGoogles();
  const id = newCharge();
  setTransactionRecurringExcluded(id, true);
  detectRecurrings();
  const ms = scorePlanMatches(TODAY);
  assert.deepEqual(ms.map((m) => [m.id, m.plan, m.band]), [[id, "Google One", "suggest"]]);
  assert.equal(applyPlanMatches(TODAY), 0);
});

test("weaker evidence asks instead of acting: another card, or a bill already paid that month", () => {
  // WHY: a second $19.99 the same month, or one on a card the bill never
  // used, may be something else at the same price; a wrong silent join is
  // worse than a question.
  twoGoogles();
  const other = newCharge({ account: "Other card" });
  detectRecurrings();
  assert.deepEqual(scorePlanMatches(TODAY).map((m) => [m.id, m.band]), [[other, "suggest"]]);
  getDb().prepare("DELETE FROM transactions WHERE id = ?").run(other);
  const second = newCharge({ date: "2026-09-04" }); // Google One already charged on Sep 3
  detectRecurrings();
  assert.deepEqual(scorePlanMatches(TODAY).map((m) => [m.id, m.band]), [[second, "suggest"]]);
});

test("amount and day alone are no match: an unrelated name is left alone, and a dismissed one stops asking", () => {
  // WHY: on the owner's history, amount and day alone matched a McDonald's to
  // three newsletters. The name must link first.
  twoGoogles();
  for (const m of ["06", "07", "08", "09", "10"]) tx("Burger Place", { amount: -12, date: `2026-${m}-20`, account: "Card" });
  newCharge({ merchant: "Burger Place" });
  detectRecurrings();
  assert.deepEqual(scorePlanMatches(TODAY), []);
  const id = newCharge();
  setTransactionRecurringExcluded(id, true);
  detectRecurrings();
  const hash = (getDb().prepare("SELECT hash FROM transactions WHERE id = ?").get(id) as { hash: string }).hash;
  dismissPlanMatch(hash);
  assert.deepEqual(scorePlanMatches(TODAY), [], "dismissed");
});

test("a new vendor's one or two charges are left to the merge queue's Combine", () => {
  // WHY: one charge must not get two answers. A brand-new name is a vendor
  // question (Combine); only an established vendor's stray is a plan question.
  twoGoogles();
  newCharge({ merchant: "Google Om" }); // a fresh name, one charge
  detectRecurrings();
  assert.deepEqual(scorePlanMatches(TODAY), []);
});

test("charges joined to a plan kept alive by hand land in that one plan, not a twin", () => {
  // WHY: Fandangoclub had one charge under its own name and was kept as a
  // plan by the owner (forced); its later charges arrived as "Fandango".
  // Matched in, they started the same key inside the Fandango vendor, and the
  // rebuild wrote two "Fandangoclub" rows, so the bill read as two bills.
  tx("Streamclub", { amount: -9.99, date: "2026-06-11", account: "Card" });
  getDb().prepare("INSERT INTO recurring_overrides (merchant, status) VALUES ('Streamclub', 'force')").run();
  for (const d of ["2026-05-15", "2026-06-20", "2026-08-02"]) tx("Stream", { amount: -27.5, date: d, account: "Card" });
  detectAndConfirm();
  const ids = ["2026-07-11", "2026-08-11", "2026-09-11"].map((d) => newCharge({ merchant: "Stream", amount: -9.99, date: d }));
  detectRecurrings();
  applyPlanMatches(TODAY);
  detectRecurrings();
  const rows = getDb().prepare("SELECT id, count FROM recurrings WHERE merchant = 'Streamclub'").all() as { id: number; count: number }[];
  assert.equal(rows.length, 1, "one plan");
  assert.equal(rows[0].count, 4, "holding its own charge and the three matched ones");
  for (const id of ids) assert.equal(planOf(id), "Streamclub");
});
