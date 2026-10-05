import { cleanDbBeforeEach, tx } from "./helpers"; // first: points the DB at a throwaway file
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

import { setPaidBy, projectLoanPayments } from "../src/lib/accounts";

const history = (id: number) => accountDetail(id)!.history.map((h) => [h.asOf, h.amount, h.source]);

test("each payment to a hand-kept loan lowers it, after interest at the rate for the days since", () => {
  // WHY: a car loan the bank link can't see would sit at its statement
  // balance for months, overstating what's owed. Its payments do show, in
  // checking; a simple-interest loan's balance after one is the last balance
  // plus daily interest, less the payment.
  const loan = createManualAccount("Sample car loan", "loan", { asOf: "2026-01-01", amount: 10000, estimate: false });
  setTerms(loan, { rate: 6, payment: 500 });
  tx("Car Finance Co", { amount: -500, date: "2026-01-31" });
  tx("Car Finance Co", { amount: -500, date: "2026-03-02" });
  tx("Someone Else", { amount: -500, date: "2026-02-15" });
  setPaidBy(loan, "Car Finance Co");
  assert.deepEqual(history(loan), [
    ["2026-03-02", 9096.41, "estimate"],
    ["2026-01-31", 9549.32, "estimate"],
    ["2026-01-01", 10000, "owner"],
  ]);
  assert.equal(netWorth("2026-03-02").owed, 9096.41, "net worth owes the estimate");
});

test("a statement balance resets the estimates; a missed or pending payment lowers nothing", () => {
  // WHY: the estimate drifts by cents (the lender's day count, a late fee);
  // the owner's next statement figure must win, and the payments after it
  // count from it. A month with no payment must not be assumed paid.
  const loan = createManualAccount("Sample car loan", "loan", { asOf: "2026-01-01", amount: 10000, estimate: false });
  setTerms(loan, { rate: 6 });
  tx("Car Finance Co", { amount: -500, date: "2026-01-31" });
  setPaidBy(loan, "Car Finance Co");
  setValue(loan, { asOf: "2026-02-15", amount: 9600, estimate: true }); // a loan's figure is a statement's, never an estimate
  tx("Car Finance Co", { amount: -500, date: "2026-04-01" });
  tx("Car Finance Co", { amount: -500, date: "2026-05-01" });
  getDb().prepare("UPDATE transactions SET pending = 1 WHERE date = '2026-05-01'").run();
  projectLoanPayments(loan);
  const h = history(loan);
  assert.deepEqual(h[h.length - 1], ["2026-01-01", 10000, "owner"]);
  assert.deepEqual(h.find((r) => r[0] === "2026-02-15"), ["2026-02-15", 9600, "owner"], "stored as the owner's");
  assert.ok(!h.some((r) => r[0] === "2026-01-31"), "the estimate before the statement is superseded");
  // Feb 15 → Apr 1 is 45 days: no March payment, so interest runs on.
  assert.deepEqual(h[0], ["2026-04-01", Number((9600 * (1 + 0.06 * 45 / 365) - 500).toFixed(2)), "estimate"]);
  assert.ok(!h.some((r) => r[0] === "2026-05-01"), "a pending payment isn't counted yet");
});

test("only a hand-kept loan is lowered by payments", () => {
  // WHY: a linked loan's balance is the bank's own; estimating over it would
  // put a guess where a fact is.
  recordBalances(bank(), "2026-10-04");
  const linked = (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = 'home'").get() as { id: number }).id;
  const car = createManualAccount("Sample car", "vehicle", { asOf: "2026-10-04", amount: 20000, estimate: true });
  assert.equal(setPaidBy(linked, "Mortgage Co"), false);
  assert.equal(setPaidBy(car, "Car Finance Co"), false);
});

test("a loan's payments under a second, combined name count too", () => {
  // WHY: the Hyundai loan's first payments posted as "Hmf Hmfusa.com" and
  // later ones as "Hyundai Motor Finance". Once the names are combined into
  // one vendor, every payment must lower the loan, not only one name's.
  const loan = createManualAccount("Sample car loan", "loan", { asOf: "2026-01-01", amount: 10000, estimate: false });
  setTerms(loan, { rate: 0 });
  tx("Lender Online", { amount: -500, date: "2026-01-31" });
  tx("Lender Finance", { amount: -500, date: "2026-03-02" });
  getDb().prepare("INSERT INTO merchant_links (alias, primaryMerchant) VALUES ('Lender Online', 'Lender Finance')").run();
  setPaidBy(loan, "Lender Finance");
  assert.equal(accountDetail(loan)!.history[0].amount, 9000, "both payments, at 0%");
});

import { setAccountOrder } from "../src/lib/accounts";

test("an order the owner sets holds, through the next sync", () => {
  // WHY: a dragged order that the daily sync quietly reset would have to be
  // redone every morning; and accounts never ordered keep their old place.
  recordBalances(bank(), "2026-10-04");
  const id = (p: string) => (getDb().prepare("SELECT id FROM accounts WHERE plaidAccountId = ?").get(p) as { id: number }).id;
  const names = () => netWorth("2026-10-05").accounts.filter((a) => a.side === "liability").map((a) => a.kind);
  assert.deepEqual(names(), ["card", "mortgage"], "by kind before any order");
  setAccountOrder([id("home"), id("card")]);
  recordBalances(bank(), "2026-10-05");
  assert.deepEqual(names(), ["mortgage", "card"], "the owner's order, after a sync");
});

import { needsALook } from "../src/lib/accounts";

test("an old estimate, a link silent for a week and a mortgage tied to no home each ask for a look; a fresh account asks nothing", () => {
  // WHY: these are the figures in net worth most likely to be wrong, and
  // each one is silent on its row (an "as of" date, an estimate's age, a
  // missing equity). Listing them is what gets them fixed; listing anything
  // else would teach the owner to ignore the list.
  recordBalances(bank(), "2026-10-01");
  recordBalances([bank()[0]], "2026-10-09"); // the brokerage's bank stops reporting
  const home = createManualAccount("Sample home", "property", { asOf: "2025-09-01", amount: 80000, estimate: true });
  createManualAccount("Sample car", "vehicle", { asOf: "2026-09-01", amount: 9000, estimate: true });
  const look = () => {
    const nw = netWorth("2026-10-09");
    const name = new Map(nw.accounts.map((a) => [a.id, a.name]));
    return needsALook(nw.accounts, "2026-10-09").map((i) => `${name.get(i.id)}: ${i.reason} ${i.days}`).sort();
  };
  assert.deepEqual(look(), ["Sample home: old-estimate 403", "brokerage 4444: silent 8", "mortgage 3333: untied-mortgage 0"]);
  // Tying the mortgage to its home fixes that item, and only that one.
  const mortgage = netWorth("2026-10-09").accounts.find((a) => a.kind === "mortgage")!.id;
  assert.ok(setSecuredBy(mortgage, home));
  assert.deepEqual(look(), ["Sample home: old-estimate 403", "brokerage 4444: silent 8"]);
});

test("nothing asks for a look when every figure is fresh, a link is under a week quiet, or the account is left out of net worth", () => {
  // WHY: an empty list hides the card, so it never becomes furniture. A day
  // or two without a sync is normal, and an account the owner set aside
  // can't mislead net worth, so neither is worth a nag.
  recordBalances(bank(), "2026-10-03");
  recordBalances([bank()[0]], "2026-10-09"); // the brokerage six days quiet
  getDb().prepare("UPDATE accounts SET inNetWorth = 0 WHERE plaidAccountId = 'home'").run(); // the untied mortgage, set aside
  assert.deepEqual(needsALook(netWorth("2026-10-09").accounts, "2026-10-09"), []);
});

test("a value typed today doesn't make every link look silent", () => {
  // WHY: links are measured against the newest bank balance. Measured against
  // any balance, a home revalued today after a week without syncing flagged
  // every linked account at once, though none fell behind the others.
  recordBalances(bank(), "2026-10-01");
  const home = createManualAccount("Sample home", "property", { asOf: "2026-10-09", amount: 80000, estimate: true });
  const mortgage = netWorth("2026-10-09").accounts.find((a) => a.kind === "mortgage")!.id;
  setSecuredBy(mortgage, home);
  assert.deepEqual(needsALook(netWorth("2026-10-09").accounts, "2026-10-09"), []);
});

import { pairLoans, equityOf } from "../src/lib/accountPairs";

test("pairing loans with their assets leaves net worth exactly as it was", () => {
  // WHY: the list shows a home's equity and drops its mortgage from Loans.
  // That is a display change only: if pairing dropped a loan, or counted one
  // against two assets, the list would no longer add up to net worth.
  recordBalances(bank(), "2026-10-04");
  const house = createManualAccount("Sample house", "property", { asOf: "2026-10-04", amount: 80000, estimate: true });
  const car = createManualAccount("Sample car", "vehicle", { asOf: "2026-10-04", amount: 9000, estimate: true });
  const carLoan = createManualAccount("Sample car loan", "loan", { asOf: "2026-10-04", amount: 4000, estimate: false });
  const mortgage = netWorth("2026-10-04").accounts.find((a) => a.kind === "mortgage")!.id;
  setSecuredBy(mortgage, house);
  setSecuredBy(carLoan, car);
  const nw = netWorth("2026-10-04");
  const counted = nw.accounts.filter((a) => a.counted);
  const { loansOf, paired } = pairLoans(counted);
  assert.deepEqual([...paired].sort(), [mortgage, carLoan].sort());
  const assets = counted.filter((a) => a.side === "asset");
  const loose = counted.filter((a) => a.side === "liability" && !paired.has(a.id));
  const shown = assets.reduce((t, a) => t + equityOf(a, loansOf.get(a.id)), 0) - loose.reduce((t, a) => t + a.amount, 0);
  assert.equal(Number(shown.toFixed(2)), nw.net, "the rows still add up to net worth");
  assert.equal(equityOf(assets.find((a) => a.id === house)!, loansOf.get(house)), 80000 - 50000);
});

test("a loan against an asset that isn't counted stays listed on its own", () => {
  // WHY: a mortgage folded into a home that's left out of net worth would
  // vanish from the page while still counting in Owed.
  recordBalances(bank(), "2026-10-04");
  const house = createManualAccount("Sample house", "property", { asOf: "2026-10-04", amount: 80000, estimate: true });
  const mortgage = netWorth("2026-10-04").accounts.find((a) => a.kind === "mortgage")!.id;
  setSecuredBy(mortgage, house);
  updateAccount(house, { counted: false });
  const { paired } = pairLoans(netWorth("2026-10-04").accounts.filter((a) => a.counted));
  assert.equal(paired.has(mortgage), false);
});
