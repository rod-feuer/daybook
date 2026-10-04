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
