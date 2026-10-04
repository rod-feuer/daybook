import { cleanDbBeforeEach } from "./helpers"; // first: points the DB at a throwaway file
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { recordBalances, netWorth } from "../src/lib/accounts";
import type { PlaidItem } from "../src/lib/plaid";

cleanDbBeforeEach();

// Sample accounts only: the repo is public.
type A = { id: string; type: string; subtype: string; mask: string; current: number | null };
const item = (institution: string, accounts: A[]): PlaidItem => ({
  institution,
  transactions: [],
  accounts: accounts.map((a) => ({
    account_id: a.id, name: `${a.subtype} ${a.mask}`, type: a.type, subtype: a.subtype, mask: a.mask, balances: { current: a.current },
  })),
});
const bank = (ids = { chk: "chk", card: "card", home: "home", brk: "brk" }, b = { chk: 1000, card: 200, home: 50000, brk: 30000 }) => [
  item("ins_a", [
    { id: ids.chk, type: "depository", subtype: "checking", mask: "1111", current: b.chk },
    { id: ids.card, type: "credit", subtype: "credit card", mask: "2222", current: b.card },
    { id: ids.home, type: "loan", subtype: "mortgage", mask: "3333", current: b.home },
  ]),
  item("ins_b", [{ id: ids.brk, type: "investment", subtype: "brokerage", mask: "4444", current: b.brk }]),
];

test("net worth is what's held less what's owed: a card or loan balance is owed, not held", () => {
  // WHY: Plaid states every balance as a positive number. Summed blindly, a
  // mortgage would raise net worth by its size; the account's type decides
  // its side.
  assert.equal(recordBalances(bank(), "2026-10-04"), 4);
  const nw = netWorth("2026-10-04");
  assert.deepEqual([nw.owned, nw.owed, nw.net], [31000, 50200, -19200]);
  const kinds = Object.fromEntries(nw.accounts.map((a) => [a.name, `${a.side}/${a.kind}`]));
  assert.deepEqual(kinds, {
    "checking 1111": "asset/cash", "brokerage 4444": "asset/investment",
    "credit card 2222": "liability/card", "mortgage 3333": "liability/mortgage",
  });
});

test("one balance per account per day: a second sync replaces the day, the next day adds to the history", () => {
  // WHY: the trend is drawn from this history. Two syncs in a day must not
  // read as two days, and a later day must not overwrite an earlier one.
  recordBalances(bank(undefined, { chk: 1000, card: 200, home: 50000, brk: 30000 }), "2026-10-04");
  recordBalances(bank(undefined, { chk: 900, card: 200, home: 50000, brk: 30000 }), "2026-10-04");
  recordBalances(bank(undefined, { chk: 2500, card: 0, home: 49000, brk: 31000 }), "2026-10-05");
  const rows = getDb().prepare("SELECT COUNT(*) AS n FROM balances").get() as { n: number };
  assert.equal(rows.n, 8, "four accounts, two days");
  assert.equal(netWorth("2026-10-04").net, 900 + 30000 - 200 - 50000, "the day's last sync");
  assert.equal(netWorth("2026-10-05").net, 2500 + 31000 - 0 - 49000);
});

test("a relinked bank's new account ids take over the accounts already held, so nothing counts twice", () => {
  // WHY: relinking a bank (it has happened, twice) issues new account ids.
  // Keyed on the id alone, every account would be added again and net worth
  // would count it twice; matched on institution, mask and subtype, the
  // account keeps its history under the new id.
  recordBalances(bank(), "2026-10-04");
  recordBalances(bank({ chk: "chk2", card: "card2", home: "home2", brk: "brk" }), "2026-10-05");
  const n = getDb().prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
  assert.equal(n.n, 4, "no account added twice");
  assert.equal(netWorth("2026-10-05").net, -19200, "counted once");
  const history = getDb().prepare("SELECT COUNT(*) AS n FROM balances b JOIN accounts a ON a.id = b.accountId WHERE a.plaidAccountId = 'chk2'").get() as { n: number };
  assert.equal(history.n, 2, "the checking account's history followed its new id");
});

test("an account the bank stops reporting keeps its last balance, dated, rather than vanishing or passing for today's", () => {
  // WHY: a link that fails (or a bank that sends no balance) would otherwise
  // drop the account from net worth, a swing that never happened. It stays,
  // and its asOf says how old the figure is.
  recordBalances(bank(), "2026-10-04");
  recordBalances([item("ins_a", [{ id: "chk", type: "depository", subtype: "checking", mask: "1111", current: null }])], "2026-10-05");
  const nw = netWorth("2026-10-05");
  assert.equal(nw.net, -19200, "every account still counts");
  assert.ok(nw.accounts.every((a) => a.asOf === "2026-10-04"), "each says it is as of the day it last reported");
});

test("an account left out of net worth, or hidden, doesn't count", () => {
  // WHY: the owner's choice to leave an account out (a closed card, an
  // account held for someone else) has to reach the figure, not just the list.
  recordBalances(bank(), "2026-10-04");
  getDb().prepare("UPDATE accounts SET inNetWorth = 0 WHERE plaidAccountId = 'card'").run();
  getDb().prepare("UPDATE accounts SET hidden = 1 WHERE plaidAccountId = 'brk'").run();
  assert.equal(netWorth("2026-10-04").net, 1000 - 50000);
});

import { createManualAccount, setValue, removeValue, updateAccount, deleteManualAccount, accountDetail } from "../src/lib/accounts";

test("a home the owner values counts in what's owned, marked as an estimate", () => {
  // WHY: a mortgage without its home reads as pure debt. The home's value is
  // the owner's judgement, so it counts but says it's an estimate.
  recordBalances(bank(), "2026-10-04");
  const home = createManualAccount("Sample home", "property", { asOf: "2026-10-04", amount: 80000, estimate: true });
  const nw = netWorth("2026-10-04");
  assert.deepEqual([nw.owned, nw.net], [111000, 111000 - 50200]);
  const row = nw.accounts.find((a) => a.id === home)!;
  assert.deepEqual([row.side, row.kind, row.origin, row.source], ["asset", "property", "manual", "estimate"]);
});

test("a linked account's balance is the bank's: the owner can't set it or delete the account", () => {
  // WHY: the bank's balance is the fact; an owner figure on top would be
  // overwritten by the next sync or, worse, mixed into its history.
  recordBalances(bank(), "2026-10-04");
  const linked = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'chk'").get() as { id: number }).id;
  assert.equal(setValue(linked, { asOf: "2026-10-04", amount: 1, estimate: false }), false);
  assert.equal(deleteManualAccount(linked), false);
  assert.equal(netWorth("2026-10-04").owned, 31000, "untouched");
});

test("a linked account renamed by the owner keeps the name through the next sync", () => {
  // WHY: banks send names like "CREDIT CARD"; the owner's name must survive
  // the daily sync, or every rename is undone overnight.
  recordBalances(bank(), "2026-10-04");
  const card = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'card'").get() as { id: number }).id;
  updateAccount(card, { name: "Everyday card" });
  recordBalances(bank(), "2026-10-05");
  assert.equal(accountDetail(card)!.name, "Everyday card");
});

test("an account left out of net worth stays listed, so it can be counted again", () => {
  // WHY: an account that vanished when left out could never be brought back.
  recordBalances(bank(), "2026-10-04");
  const card = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'card'").get() as { id: number }).id;
  updateAccount(card, { counted: false });
  let nw = netWorth("2026-10-04");
  assert.equal(nw.owed, 50000, "not summed");
  assert.equal(nw.accounts.find((a) => a.id === card)?.counted, false, "but listed");
  updateAccount(card, { counted: true });
  nw = netWorth("2026-10-04");
  assert.equal(nw.owed, 50200);
});

test("a hand-kept account's values: the same day replaces, a value can be removed but the last one stays, and the account can be deleted", () => {
  // WHY: a typo'd value must be fixable without leaving the account valueless
  // (it would drop off the page, out of reach); deleting takes its history too.
  const car = createManualAccount("Sample car", "vehicle", { asOf: "2026-01-01", amount: 30000, estimate: true });
  setValue(car, { asOf: "2026-10-04", amount: 25000, estimate: true });
  setValue(car, { asOf: "2026-10-04", amount: 24000, estimate: true });
  assert.deepEqual(accountDetail(car)!.history.map((h) => [h.asOf, h.amount]), [["2026-10-04", 24000], ["2026-01-01", 30000]]);
  assert.equal(removeValue(car, "2026-10-04"), true);
  assert.equal(removeValue(car, "2026-01-01"), false, "the last value stays");
  assert.equal(deleteManualAccount(car), true);
  assert.equal(accountDetail(car), null);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM balances WHERE accountId = ?").get(car) as { n: number }).n, 0, "its values went with it");
});

import { recordBankTerms, setTerms, setSecuredBy } from "../src/lib/accounts";

test("the bank fills a loan's terms, but never over a term the owner set; clearing hands it back", () => {
  // WHY: Plaid reports a mortgage's rate and payment. An owner who corrects
  // one (a rate the bank reports stale) must not see it reverted overnight;
  // and an owner who clears their figure wants the bank's back.
  recordBalances(bank(), "2026-10-04");
  const home = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'home'").get() as { id: number }).id;
  recordBankTerms([{ plaidAccountId: "home", rate: 3.125, payment: 4861.04 }]);
  let t = accountDetail(home)!.terms!;
  assert.deepEqual([t.rate, t.payment, t.edited], [3.125, 4861.04, []], "the bank's, auto");
  setTerms(home, { rate: 3.0, maturity: "2051-06-01" });
  recordBankTerms([{ plaidAccountId: "home", rate: 3.125, payment: 4900 }]);
  t = accountDetail(home)!.terms!;
  assert.deepEqual([t.rate, t.payment, t.maturity, t.edited], [3.0, 4900, "2051-06-01", ["rate", "maturity"]], "the owner's rate stands; the bank's payment updates");
  setTerms(home, { rate: null });
  recordBankTerms([{ plaidAccountId: "home", rate: 3.125 }]);
  assert.equal(accountDetail(home)!.terms!.rate, 3.125, "cleared, the bank's comes back");
});

test("only a loan has terms, and it can only be against something owned", () => {
  // WHY: terms on a checking account, or a loan "against" another loan,
  // would put nonsense into the pay-down figures and the equity line.
  recordBalances(bank(), "2026-10-04");
  const chk = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'chk'").get() as { id: number }).id;
  const card = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'card'").get() as { id: number }).id;
  const home = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'home'").get() as { id: number }).id;
  assert.equal(setTerms(chk, { rate: 1 }), false);
  assert.equal(accountDetail(chk)!.terms, null);
  assert.equal(setSecuredBy(home, card), false, "not against a liability");
  assert.equal(setSecuredBy(chk, home), false, "an asset doesn't point");
});

test("an asset's equity is its worth less what's owed on the loans against it", () => {
  // WHY: the pay-down question is asked per asset ("how much of the boat do
  // we own?"); equity must subtract exactly the loans pointed at it, today.
  recordBalances(bank(), "2026-10-04");
  const mortgage = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'home'").get() as { id: number }).id;
  const house = createManualAccount("Sample house", "property", { asOf: "2026-10-04", amount: 80000, estimate: true });
  assert.equal(accountDetail(house)!.equity, null, "no loan against it: no equity line");
  setSecuredBy(mortgage, house);
  const d = accountDetail(house)!;
  assert.equal(d.equity, 80000 - 50000);
  assert.deepEqual(d.loans.map((l) => [l.amount]), [[50000]]);
  assert.equal(accountDetail(mortgage)!.securedBy?.id, house);
  assert.equal(deleteManualAccount(house), true, "a house a loan points at can still be deleted");
  assert.equal(accountDetail(mortgage)!.securedBy, null, "and the loan is against nothing now");
});

import { netWorthTrend } from "../src/lib/accounts";

const day = (base: string, n: number) => { const d = new Date(base + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test("the trend and the month's change wait for enough history", () => {
  // WHY: three days of balances drawn as a line, or a "change" against a
  // day that wasn't recorded, would show movement Daybook can't vouch for.
  recordBalances(bank(), "2026-10-04");
  let t = netWorthTrend("2026-10-10");
  assert.deepEqual([t.start, t.series, t.prev], ["2026-10-04", null, null], "a week: neither");
  t = netWorthTrend(day("2026-10-04", 14));
  assert.equal(t.series?.length, 15, "two weeks: the line, a point a day");
  assert.equal(t.prev, null, "but no month-ago yet");
  t = netWorthTrend(day("2026-10-04", 30));
  assert.equal(t.prev?.date, "2026-10-04");
});

test("adding an account later is neither drawn as a rise nor reported as a change", () => {
  // WHY: entering a home on day 20 would otherwise add its whole worth to
  // the line that day and to "the change since last month", though nothing
  // was gained: only the record grew. It counts from the start at its first
  // value; what it does after that is real change.
  recordBalances(bank(), "2026-10-04");
  const base = -19200;
  createManualAccount("Sample house", "property", { asOf: "2026-10-24", amount: 80000, estimate: true });
  const today = "2026-11-03";
  const t = netWorthTrend(today);
  assert.equal(t.series![0].net, base + 80000, "the house is in the first point, not a step on Oct 24");
  assert.equal(t.prev!.net, base + 80000, "a month ago, like for like");
  assert.equal(netWorth(today).net - t.prev!.net, 0, "so no change is reported");
  const house = (getDb().prepare("SELECT id FROM accounts WHERE name = 'Sample house'").get() as { id: number }).id;
  setValue(house, { asOf: today, amount: 85000, estimate: true });
  assert.equal(netWorth(today).net - netWorthTrend(today).prev!.net, 5000, "a revaluation after it was added is change");
});
