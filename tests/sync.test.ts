import { cleanDbBeforeEach, daysAgo } from "./helpers";
import { setBankPayload } from "./fakePlaid";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { syncFromBank } from "../src/lib/plaid";
import { detectRecurrings } from "../src/lib/core";

cleanDbBeforeEach();

const plans = () => (getDb().prepare("SELECT merchant FROM recurrings ORDER BY merchant").all() as { merchant: string }[]).map((r) => r.merchant);
const linked = () => (getDb().prepare("SELECT COUNT(*) AS n FROM transactions WHERE recurringId IS NOT NULL").get() as { n: number }).n;

// WHY: the digest job runs on a schedule with no web server behind it. The whole
// sync — pull, import, split rules, rebuild the plans — has to be one function it
// can call, and it has to leave the same state the app's own Sync button does.
test("syncFromBank does the whole sync without the server: imports, rebuilds plans, and is idle when nothing changed", async () => {
  setBankPayload([90, 60, 30, 1].map((d, i) => ({ id: `gym-${i}`, date: daysAgo(d), name: "Gym Co", amount: 40 })));
  const first = await syncFromBank();
  assert.deepEqual({ inserted: first.inserted, total: first.total }, { inserted: 4, total: 4 });
  assert.ok(plans().some((m) => /gym/i.test(m)), "four monthly charges became a plan");

  const again = await syncFromBank();
  assert.deepEqual({ inserted: again.inserted, updated: again.updated }, { inserted: 0, updated: 0 }, "the same pull changes nothing");
  assert.ok(plans().some((m) => /gym/i.test(m)), "and the plan is still there");
});

// WHY: rebuilding the plans clears them all and writes them again. With the
// digest job reading from a second process, a rebuild that stops halfway (or is
// merely mid-flight) must not be visible as "you have no bills": it is one
// transaction, so a failure leaves yesterday's plans, not none.
test("detectRecurrings is all-or-nothing: a rebuild that fails leaves the old plans and their charges linked", () => {
  const db = getDb();
  for (const [i, d] of [90, 60, 30, 1].entries()) db.prepare("INSERT INTO transactions (date, merchant, amount, account, source, hash) VALUES (?, 'Gym Co', -40, 'Visa', 'test', ?)").run(daysAgo(d), `g${i}`);
  detectRecurrings();
  const before = { plans: plans(), linked: linked() };
  assert.ok(before.plans.length === 1 && before.linked === 4, "fixture: one plan holding four charges");

  db.exec("CREATE TRIGGER boom BEFORE INSERT ON recurrings BEGIN SELECT RAISE(ABORT, 'boom'); END");
  try {
    assert.throws(() => detectRecurrings(), /boom/);
  } finally {
    db.exec("DROP TRIGGER boom");
  }
  assert.deepEqual({ plans: plans(), linked: linked() }, before);
});

// WHY: balances ride on the pull the sync already makes; the sync, not a
// separate job, has to record them, dated by the day it ran.
test("syncFromBank records each account's balance from the same pull", async () => {
  setBankPayload([{ id: "t1", date: daysAgo(1), name: "Gym Co", amount: 40 }], 250);
  const res = await syncFromBank();
  assert.equal(res.balances, 1);
  const row = getDb().prepare("SELECT a.side, a.kind, b.amount FROM balances b JOIN accounts a ON a.id = b.accountId").get();
  assert.deepEqual(row, { side: "liability", kind: "card", amount: 250 });
});

// WHY: a pending charge and its posted version are the same charge on the bank's
// day. Moving the posted one to another month (effectiveDate) is the owner's
// filing choice; it must not stop the pending copy being recognized, or the
// charge counts twice.
test("a pending charge still finds its posted twin after the posted one is moved to another month", async () => {
  const day = daysAgo(2);
  const both = [
    { id: "shop-posted", date: day, name: "Shop Co", amount: 25 },
    { id: "shop-pending", date: day, name: "Shop Co", amount: 25, pending: true },
  ];
  setBankPayload(both);
  await syncFromBank();
  const count = () => (getDb().prepare("SELECT COUNT(*) AS n FROM transactions WHERE merchant LIKE 'Shop%'").get() as { n: number }).n;
  assert.equal(count(), 1, "fixture: the pending copy was reconciled on first sight");
  getDb().prepare("UPDATE transactions SET effectiveDate = date(date, '+40 days') WHERE merchant LIKE 'Shop%'").run();
  setBankPayload(both);
  await syncFromBank();
  assert.equal(count(), 1, "the moved posted charge is still the pending one's twin");
});
