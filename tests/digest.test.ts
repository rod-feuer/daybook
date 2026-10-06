import { detectAndConfirm, cleanDbBeforeEach, addCat, tx, daysAgo } from "./helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { linkMerchant, setBudget, setRecurringSetting, recurringsForMonth } from "../src/lib/queries";
import { LARGE_CHARGE } from "../src/lib/forecast";
import {
  dailyDigest,
  weeklyDigest,
  renderHtml,
  subjectOf,
  runDigest,
  unusualCharges,
  alreadySent,
  FIRST_VENDOR_FLOOR,
  OVERDUE_GRACE_DAYS,
  SURPRISE_WINDOW_DAYS,
  type DigestDeps,
} from "../src/lib/digest";

cleanDbBeforeEach();

const since = () => daysAgo(SURPRISE_WINDOW_DAYS);
const reasons = () => Object.fromEntries(unusualCharges(since()).map((u) => [u.merchant, u.reason]));
const sentKeys = () => {
  alreadySent([]); // makes sure the table exists
  return (getDb().prepare("SELECT key FROM digest_sent ORDER BY key").all() as { key: string }[]).map((r) => r.key);
};
// A run with nothing real behind it: the sync and the send are stand-ins, so a
// test never reaches a bank or a phone.
function deps(over: Partial<DigestDeps> = {}) {
  const sent: string[] = [];
  const d: DigestDeps = { sync: async () => {}, send: async (m) => void sent.push(m.text), dryRun: false, retryMs: 0, ...over };
  return { d, sent };
}
const LARGE = -(LARGE_CHARGE + 500);
// The same day `n` calendar months earlier (the 28th at the latest, so the day exists).
const monthsBefore = (isoDate: string, n: number) => {
  const d = new Date(isoDate + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, Math.min(d.getUTCDate(), 28))).toISOString().slice(0, 10);
};

// WHY: this is the one new judgement the digest makes, and each clause guards
// against a way it would cry wolf. A text that is wrong twice gets muted.
test("unusualCharges: large, a sizeable first charge, or well above the vendor's usual — and nothing else", () => {
  const cat = addCat("Shopping");
  const transfers = addCat("Transfers", "expense", 1);
  tx("Roof Co", { amount: LARGE, date: daysAgo(2), categoryId: cat });
  tx("New Dentist", { amount: -FIRST_VENDOR_FLOOR, date: daysAgo(2), categoryId: cat });
  tx("New Cafe", { amount: -(FIRST_VENDOR_FLOOR - 1), date: daysAgo(2), categoryId: cat }); // every new restaurant is a "first"
  for (const d of [90, 60, 30]) tx("Grocer", { amount: -80, date: daysAgo(d), categoryId: cat });
  tx("Grocer", { amount: -190, date: daysAgo(1), categoryId: cat }); // over 2x the usual and $100 above it
  for (const d of [90, 60, 30]) tx("Market", { amount: -55, date: daysAgo(d), categoryId: cat });
  tx("Market", { amount: -140, date: daysAgo(1), categoryId: cat }); // a big grocery run ($85 over): not news
  for (const d of [60, 30]) tx("Florist", { amount: -40, date: daysAgo(d), categoryId: cat });
  tx("Florist", { amount: -200, date: daysAgo(1), categoryId: cat }); // only two earlier charges: no "usual" yet
  tx("Old Roof Co", { amount: LARGE, date: daysAgo(SURPRISE_WINDOW_DAYS + 1), categoryId: cat }); // outside the window
  tx("Card Payment", { amount: LARGE, date: daysAgo(1), categoryId: transfers }); // does not count toward totals
  tx("Reimbursed Trip", { amount: LARGE, date: daysAgo(1), categoryId: cat, excluded: 1 });
  tx("Hotel Hold", { amount: LARGE, date: daysAgo(1), categoryId: cat, hash: "hold" });
  getDb().prepare("UPDATE transactions SET pending = 1 WHERE hash = 'hold'").run(); // a pending amount still moves

  assert.deepEqual(reasons(), { "Roof Co": "large", "New Dentist": "first", Grocer: "above-usual" });
  assert.equal(unusualCharges(since()).find((u) => u.merchant === "Grocer")!.usual, 80);
});

// WHY: a bank relabel ("Ymca" arriving as "Young Mens Chris") or a drifted
// descriptor is the same vendor. Read as a new one, every relabel is a false
// "first charge from this vendor".
test("unusualCharges: a combined name or a drifted descriptor is not a new vendor", () => {
  const cat = addCat("Kids");
  tx("Ymca", { amount: -250, date: daysAgo(60), categoryId: cat });
  tx("Young Mens Chris", { amount: -250, date: daysAgo(1), categoryId: cat });
  linkMerchant("Young Mens Chris", "Ymca");
  tx("Benjamin Franklin Plumbing", { amount: -300, date: daysAgo(60), categoryId: cat });
  tx("Benjamin Franklin Plindianapolis In", { amount: -300, date: daysAgo(1), categoryId: cat });
  assert.deepEqual(reasons(), {});
});

// WHY: a bill that came in high is news once, as a bill. The same charge is
// also large and outside nothing — reported twice, the message reads as two
// problems.
test("a bill that differed is reported once, as a bill, and never again as an unusual charge", async () => {
  const cat = addCat("Insurance");
  // One charge per calendar month: a month's paid amount is a sum, so two
  // charges 30 days apart that land in one month (the 1st and the 31st) would
  // read as one doubled bill.
  for (const back of [3, 2, 1]) tx("Acme Insurance", { amount: LARGE, date: monthsBefore(daysAgo(2), back), categoryId: cat });
  tx("Acme Insurance", { amount: LARGE - 400, date: daysAgo(2), categoryId: cat });
  detectAndConfirm();
  setRecurringSetting("Acme Insurance", { expectedAmount: Math.abs(LARGE) });

  const built = dailyDigest()!;
  assert.deepEqual(built.keys.map((k) => k.split(":")[0]), ["differed"]);
  assert.deepEqual(built.sections, [{ title: "Bills that came in high", lines: ["Acme Insurance $1,900, up $400"] }]);
});

// WHY: `paidAmount` is a month's SUM. A weekly plan paid four times is four
// times one expected charge, every month — a standing false alarm.
test("a plan that charges more than once a month is never reported as differed", () => {
  const cat = addCat("Help");
  for (const d of [36, 29, 22, 15, 8, 1]) tx("Lawn Crew", { amount: -60, date: daysAgo(d), categoryId: cat });
  const plan = detectAndConfirm().find((r) => r.merchant === "Lawn Crew");
  assert.equal(plan?.cadence, "weekly", "fixture: a weekly plan");
  assert.equal(dailyDigest(), null);
});

// WHY: bank data posts one to three days late. Without a grace, "due yesterday"
// would text most mornings about a bill that is merely in transit.
test("an overdue bill is reported only after the bank has had time to post it", { skip: overdueSkip() }, () => {
  const cat = addCat("Utilities");
  const seedBill = (name: string, dueDaysAgo: number) => {
    for (const back of [3, 2, 1]) tx(name, { amount: -90, date: monthsBefore(daysAgo(dueDaysAgo), back), categoryId: cat });
  };
  seedBill("Water Co", OVERDUE_GRACE_DAYS + 1);
  seedBill("Gas Co", OVERDUE_GRACE_DAYS - 1);
  detectAndConfirm();
  const sections = dailyDigest()?.sections ?? [];
  assert.deepEqual(sections.map((s) => s.title), ["Bills that haven't posted"]);
  assert.equal(sections[0].lines.length, 1);
  assert.match(sections[0].lines[0], /^Water Co \$90, due [A-Z][a-z]{2} \d+$/);
});
// The fixture needs "due four days ago" to be a day of THIS month that also
// exists in the three months before it; on the 1st to 4th, or for a day past
// the 28th, it doesn't. The clock sweep runs this on every other day.
function overdueSkip(): string | false {
  const due = daysAgo(OVERDUE_GRACE_DAYS + 1);
  if (due.slice(0, 7) !== daysAgo(0).slice(0, 7)) return "the due day falls in last month";
  return Number(due.slice(8, 10)) > 28 ? "the due day does not exist in every month" : false;
}

// WHY: the daily text is worth reading only because it is rare. Chores are
// almost never zero, so if they could trigger a send there would be no quiet
// days, and the text would be muted within a week.
test("a quiet day sends nothing, even with chores waiting", async () => {
  tx("Corner Store", { amount: -12, date: daysAgo(1), categoryId: null }); // an uncategorized charge: a chore
  const { d, sent } = deps();
  assert.equal(await runDigest(dailyDigest, d), "quiet");
  assert.deepEqual(sent, []);
});

// WHY: a thing said twice is noise, and the owner asked for each thing once.
// Plaid re-posting the same charge with a corrected date is still the same thing.
test("nothing is said twice, including when the bank re-posts a charge with a new date", async () => {
  const cat = addCat("Home");
  tx("Roof Co", { amount: LARGE, date: daysAgo(3), categoryId: cat, hash: "roof" });
  const first = deps();
  assert.equal(await runDigest(dailyDigest, first.d), "sent");
  assert.match(first.sent[0], /^Daybook: /);
  assert.match(first.sent[0], /\nCharges worth a look\n• \$1,500 to Roof Co on [A-Z][a-z]{2} \d+, large$/);

  const second = deps();
  assert.equal(await runDigest(dailyDigest, second.d), "quiet");
  getDb().prepare("UPDATE transactions SET date = ? WHERE hash = 'roof'").run(daysAgo(1));
  assert.equal(await runDigest(dailyDigest, second.d), "quiet");
  assert.deepEqual(second.sent, []);
});

// WHY: "said" must mean "delivered". If the send fails and the item is recorded
// anyway, the owner never hears about it. A dry run is a look, not a send.
test("an item is recorded only after a successful send: a failed send retries, a dry run records nothing", async () => {
  const cat = addCat("Home");
  tx("Roof Co", { amount: LARGE, date: daysAgo(3), categoryId: cat, hash: "roof" });

  const printed: string[] = [];
  assert.equal(await runDigest(dailyDigest, deps({ dryRun: true, print: (t) => printed.push(t) }).d), "dry");
  assert.match(printed[0], /Roof Co/);
  assert.deepEqual(sentKeys(), []);

  await assert.rejects(runDigest(dailyDigest, deps({ send: async () => Promise.reject(new Error("Messages is signed out")) }).d), /signed out/);
  assert.deepEqual(sentKeys(), []);

  const ok = deps();
  assert.equal(await runDigest(dailyDigest, ok.d), "sent");
  assert.match(ok.sent[0], /Roof Co/);
  assert.deepEqual(sentKeys(), ["unusual:roof"]);
});

// WHY: a digest built on stale figures must say so (the honesty rule), with the
// day the figures run to. But "the bank was unreachable" is not news on its own:
// a laptop waking before Wi-Fi is up would text every morning.
test("a failed sync is stated with the last data day, and does not by itself break a quiet day", async () => {
  const failing = { sync: async () => Promise.reject(new Error("offline")) };
  const quiet = deps(failing);
  assert.equal(await runDigest(dailyDigest, quiet.d), "quiet");
  assert.deepEqual(quiet.sent, []);

  const cat = addCat("Home");
  tx("Roof Co", { amount: LARGE, date: daysAgo(3), categoryId: cat });
  getDb().prepare("INSERT INTO transactions (date, merchant, amount, account, source, hash) VALUES (?, 'Cafe', -5, 'Visa', 'plaid', 'p1')").run(daysAgo(5));
  const loud = deps(failing);
  assert.equal(await runDigest(dailyDigest, loud.d), "sent");
  assert.match(loud.sent[0], /Couldn't reach the bank, so this is as of [A-Z][a-z]{2} \d+\./);

  let calls = 0;
  const flaky = deps({ sync: async () => (++calls === 1 ? Promise.reject(new Error("no wifi yet")) : undefined) });
  getDb().exec("DELETE FROM digest_sent");
  await runDigest(dailyDigest, flaky.d);
  assert.equal(calls, 2, "one retry: a job that fires on wake often runs before the network is up");
  assert.doesNotMatch(flaky.sent[0], /reach the bank/);
});

// WHY: the app never shows a month-end projection it doesn't have (before day
// 5), and qualifies the one it does. The message carries the same sentence, so
// it must keep the same promise.
test("the headline withholds a projection early in the month and qualifies it after", async () => {
  const cat = addCat("Groceries");
  setBudget(cat, 5000);
  const month = daysAgo(0).slice(0, 7);
  tx("Grocer", { amount: -120, date: `${month}-01`, categoryId: cat });
  tx("Roof Co", { amount: LARGE, date: daysAgo(1), categoryId: null, hash: "trigger" }); // something to report, outside the budget
  const budgetLine = () => dailyDigest()!.headline;
  if (daysAgo(1) <= `${month}-04`) assert.match(budgetLine(), /^\$\S+ of your \$5,000 budget used\. Too early to project [A-Z][a-z]+\.$/);

  for (const day of ["03", "06", "10"]) tx("Grocer", { amount: -150, date: `${month}-${day}`, categoryId: cat });
  assert.match(budgetLine(), /^On pace to finish [A-Z][a-z]+ (\$[\d,]+(–\$[\d,]+)? (under|over)|up to \$[\d,]+ (under|over)|between \$[\d,]+ under and \$[\d,]+ over|on) budget\.$/);
});


// WHY: a text full of lines you ignore teaches you to ignore the text. A bill's
// difference has to be real money AND a real share of the bill.
test("a bill's difference is reported only when it is at least $25 and at least 10% of the bill", () => {
  const cat = addCat("Bills");
  const bill = (name: string, usual: number, now: number) => {
    for (const back of [3, 2, 1]) tx(name, { amount: -usual, date: monthsBefore(daysAgo(2), back), categoryId: cat });
    tx(name, { amount: -now, date: daysAgo(2), categoryId: cat });
  };
  bill("Groomer", 114, 122.4); // $8 on $114: neither
  bill("Mortgage Co", 900, 930); // $30 on $900: money, but 3% of the bill
  bill("Water Co", 74, 142); // $68 on $74: both
  bill("Phone Co", 120, 85); // $35 less on $120: both, and it fell
  detectAndConfirm();
  for (const [name, usual] of [["Groomer", 114], ["Mortgage Co", 900], ["Water Co", 74], ["Phone Co", 120]] as const) setRecurringSetting(name, { expectedAmount: usual });
  assert.deepEqual(dailyDigest()!.sections, [{ title: "Bills that changed", lines: ["Water Co $142, up $68", "Phone Co $85, down $35"] }]);
});

// WHY: the order is the message. What happened TO you leads (a bill that never
// posted, then a bill someone changed); among charges, a vendor you have never
// paid (it might not be you) comes before one that is merely large (you were
// there when you made it).
test("the text leads with what you did not choose, and puts a large charge last", { skip: overdueSkip() }, () => {
  const cat = addCat("Home");
  tx("Roof Co", { amount: LARGE, date: daysAgo(3), categoryId: cat });
  tx("New Dentist", { amount: -FIRST_VENDOR_FLOOR, date: daysAgo(2), categoryId: cat });
  for (const back of [3, 2, 1]) tx("Water Co", { amount: -74, date: monthsBefore(daysAgo(2), back), categoryId: cat });
  tx("Water Co", { amount: -142, date: daysAgo(2), categoryId: cat });
  for (const back of [3, 2, 1]) tx("Gas Co", { amount: -90, date: monthsBefore(daysAgo(OVERDUE_GRACE_DAYS + 1), back), categoryId: cat });
  detectAndConfirm();
  setRecurringSetting("Water Co", { expectedAmount: 74 });
  const built = dailyDigest()!;
  assert.deepEqual(built.sections.map((s) => s.title), ["Bills that haven't posted", "Bills that came in high", "Charges worth a look"]);
  assert.deepEqual(built.sections[2].lines.map((l) => l.split(", ").pop()), ["first time", "large"]);
});

// WHY: the headline is the dashboard's verdict. "Still" and "Now" tell the
// reader whether this text changes the picture — and the month turning from
// under budget to over is the one piece of news that needs no other surprise.
test("the headline says Still or Now against the last text, and the month going over budget is news by itself, once", async () => {
  const cat = addCat("Groceries");
  setBudget(cat, 5000);
  const month = daysAgo(0).slice(0, 7);
  for (const day of ["01", "04", "07", "10"]) tx("Grocer", { amount: -300, date: `${month}-${day}`, categoryId: cat });
  const other = addCat("Home");
  tx("Roof Co", { amount: LARGE, date: daysAgo(3), categoryId: other, hash: "r1" });

  const first = deps();
  assert.equal(await runDigest(dailyDigest, first.d), "sent");
  assert.match(first.sent[0], /^Daybook: On pace to finish [A-Z][a-z]+ \$[\d,]+(–\$[\d,]+)? under budget\./, "the month's first word on it: neither Still nor Now");

  tx("Fence Co", { amount: LARGE, date: daysAgo(2), categoryId: other, hash: "r2" });
  const second = deps();
  assert.equal(await runDigest(dailyDigest, second.d), "sent");
  assert.match(second.sent[0], /^Daybook: Still on pace to finish [A-Z][a-z]+ \$[\d,]+(–\$[\d,]+)? under budget\./);

  // Groceries run far past the budget: no new surprise, but the month has turned.
  // (Each run is under twice the usual $300, so none of them is itself a surprise.)
  for (const day of ["02", "03", "05", "06", "08", "09", "11", "12"]) tx("Grocer", { amount: -550, date: `${month}-${day}`, categoryId: cat });
  const third = deps();
  assert.equal(await runDigest(dailyDigest, third.d), "sent");
  assert.match(third.sent[0], /^Daybook: Now on pace to finish [A-Z][a-z]+ \$[\d,]+(–\$[\d,]+)? over budget\.$/, "the turn is the whole message");
  assert.equal(await runDigest(dailyDigest, deps().d), "quiet", "said once");
});

// WHY: a bill's paid amount is one charge, so a bill charged twice would look
// normal. A duplicate charge (or next month's payment going out on the 31st)
// is exactly what a digest is for.
test("a once-a-month bill charged twice in a month is reported, once", async () => {
  const cat = addCat("Auto");
  for (const back of [3, 2, 1]) tx("Car Loan", { amount: -818.4, date: monthsBefore(daysAgo(3), back), categoryId: cat });
  tx("Car Loan", { amount: -818.4, date: daysAgo(3), categoryId: cat });
  detectAndConfirm();
  assert.equal(dailyDigest(), null, "paid once: nothing to say");
  const sameMonth = daysAgo(3).slice(0, 7) === daysAgo(1).slice(0, 7);
  tx("Car Loan", { amount: -818.4, date: daysAgo(1), categoryId: cat });
  const built = dailyDigest();
  if (!sameMonth) return; // the two charges straddle a month end today: each month was charged once
  assert.deepEqual(built!.sections.map((s) => s.title), ["Bills charged twice"]);
  assert.match(built!.sections[0].lines[0], /^Car Loan \$818, charged twice in [A-Z][a-z]+$/);
  const run = deps();
  assert.equal(await runDigest(dailyDigest, run.d), "sent");
  assert.equal(await runDigest(dailyDigest, deps().d), "quiet");
});

// ---------- the weekly ----------
const thisMonth = () => daysAgo(0).slice(0, 7);
const titled = (b: { sections: { title: string; lines: string[] }[] }, re: RegExp) => b.sections.find((x) => re.test(x.title));

// WHY: the weekly is the rhythm read, so it is sent even when nothing happened —
// and what it said is kept, because next week's "how it moved" is measured from it.
test("the weekly is always sent, and keeps the projection it quoted for next week's comparison", async () => {
  const cat = addCat("Groceries");
  setBudget(cat, 5000);
  for (const day of ["01", "04", "07", "10"]) tx("Grocer", { amount: -300, date: `${thisMonth()}-${day}`, categoryId: cat });
  const subjects: string[] = [];
  const run = deps({ send: async (m) => void subjects.push(m.subject) });
  assert.equal(await runDigest(weeklyDigest, run.d), "sent");
  assert.match(subjects[0], /^Daybook: On pace to finish [A-Z][a-z]+ \$[\d,]+(–\$[\d,]+)? under budget$/, "the verdict is the subject line");
  const row = getDb().prepare("SELECT key, value FROM digest_sent WHERE key LIKE 'weekly:%'").get() as { key: string; value: number };
  assert.equal(row.key, `weekly:${daysAgo(0)}`);
  assert.ok(row.value > 1200, "the projected month-end spend it quoted");
});

// WHY: "down $1,900 since Sep 14" is only true against a figure this app
// actually sent, in the same month. With nothing to compare, it says nothing;
// and it names the date, never "last week" — a Mac that was off skips one.
test("the weekly says how the projection moved only against an earlier weekly in the same month, and names its date", () => {
  const cat = addCat("Groceries");
  setBudget(cat, 5000);
  for (const day of ["01", "04", "07", "10"]) tx("Grocer", { amount: -300, date: `${thisMonth()}-${day}`, categoryId: cat });
  assert.deepEqual(weeklyDigest().lede, [], "no earlier weekly: nothing to compare with");

  const put = (key: string, value: number) => getDb().prepare("INSERT INTO digest_sent (key, sentAt, value) VALUES (?, 'x', ?)").run(key, value);
  put("weekly:2001-01-07", 9999);
  assert.deepEqual(weeklyDigest().lede, [], "another month's projection is not a baseline");

  const now = weeklyDigest().value as number;
  put(`weekly:${thisMonth()}-01`, now + 1900);
  // On the 1st that row is today's own: a weekly never measures itself, and
  // there can be no earlier one this month.
  if (daysAgo(0).endsWith("-01")) assert.deepEqual(weeklyDigest().lede, []);
  else assert.match(weeklyDigest().lede![0], /^Projected spending is down \$1,900 since [A-Z][a-z]{2} 1\.$/);
});

// WHY: "went over this week" must mean this week did it. An annual budget is
// judged on the year; and a category already over before the week began is old
// news (the daily said so), not this week's.
test("the weekly names a category only in the week it went over, judging an annual budget on the year", () => {
  const year = thisMonth().slice(0, 4);
  const monthly = addCat("Restaurants");
  const annual = addCat("Vacations");
  const old = addCat("Hobbies");
  setBudget(monthly, 500);
  setBudget(annual, 1200, "annual");
  setBudget(old, 100);
  tx("Bistro", { amount: -450, date: `${thisMonth()}-01`, categoryId: monthly });
  tx("Bistro", { amount: -80, date: daysAgo(1), categoryId: monthly }); // this week took it past $500
  tx("Airline", { amount: -1150, date: `${year}-01-01`, categoryId: annual });
  tx("Hotel", { amount: -100, date: daysAgo(1), categoryId: annual }); // this week took the YEAR past $1,200
  tx("Hobby Shop", { amount: -150, date: daysAgo(20), categoryId: old }); // over, but not this week
  const lines = titled(weeklyDigest(), /over budget this week/)?.lines ?? [];
  const inMonth = daysAgo(1).slice(0, 7) === thisMonth();
  const hobbyThisMonth = daysAgo(20).slice(0, 7) === thisMonth();
  assert.ok(lines.includes("Vacations $1,250 of $1,200 this year") || daysAgo(1).slice(0, 4) !== year);
  if (inMonth) assert.ok(lines.includes("Restaurants $530 of $500"));
  if (hobbyThisMonth) assert.ok(!lines.some((l) => l.startsWith("Hobbies")), "over before the week began is not this week's news");
});

// WHY: "against a typical $1,610" is a claim about your habits. With under four
// weeks of history it would be a guess, so it is withheld; and a bill is not
// "spending outside your bills".
test("the week is compared with a typical one only when there is enough history, and leaves the bills out", () => {
  const cat = addCat("Shopping");
  tx("Store A", { amount: -400, date: daysAgo(2), categoryId: cat });
  tx("Store B", { amount: -90, date: daysAgo(3), categoryId: cat });
  tx("Store C", { amount: -60, date: daysAgo(4), categoryId: cat });
  tx("Store D", { amount: -10, date: daysAgo(5), categoryId: cat });
  const thin = titled(weeklyDigest(), /outside your bills/)!.lines;
  assert.equal(thin[0], "$560 spent", "no history: no comparison");
  assert.deepEqual(thin.slice(1).map((l) => l.split(" to ")[0]), ["$400", "$90", "$60"], "the three largest, largest first");

  // (a different shop each week: the same one every seven days would be a plan)
  for (const week of [1, 2, 3, 4, 5]) tx(`Shop ${"VWXYZ"[week - 1]}`, { amount: -(100 * week), date: daysAgo(7 * week + 3), categoryId: cat });
  assert.equal(titled(weeklyDigest(), /outside your bills/)!.lines[0], "$560 spent, against a typical $300");

  for (const back of [3, 2, 1]) tx("Landlord", { amount: -900, date: monthsBefore(daysAgo(2), back), categoryId: cat });
  tx("Landlord", { amount: -900, date: daysAgo(2), categoryId: cat });
  detectAndConfirm();
  assert.match(titled(weeklyDigest(), /outside your bills/)!.lines[0], /^\$560 spent/, "rent is a bill, not the week's spending");
});

// WHY: the weekly's job for the week ahead: what will leave the account, with a
// total, from the same source the dashboard uses.
test("the weekly lists the bills due in the next seven days with their total", () => {
  const cat = addCat("Bills");
  const dueIn = (name: string, days: number, amount: number) => {
    for (const back of [3, 2, 1]) tx(name, { amount: -amount, date: monthsBefore(daysAgo(-days), back), categoryId: cat });
  };
  dueIn("Power Co", 3, 120);
  dueIn("Phone Co", 5, 80);
  dueIn("Far Off Co", 20, 999);
  detectAndConfirm();
  setRecurringSetting("Phone Co", { alias: "Phone Co · $80" }); // the detector's own label for a second plan
  const due = titled(weeklyDigest(), /^Due in the next 7 days/);
  if (Number(daysAgo(-3).slice(8, 10)) > 28 || Number(daysAgo(-5).slice(8, 10)) > 28) return; // the fixture clamps to the 28th: the due day would differ
  assert.equal(due?.title, "Due in the next 7 days: $200 expected");
  assert.deepEqual(due?.lines.map((l) => l.replace(/^[A-Z][a-z]{2} \d+ /, "")), ["Power Co $120", "Phone Co $80"], "and a name that already ends in its amount doesn't say it twice");
});

// WHY: a card autopay is money already spent on the card, so its category
// (Transfers) is not counted anywhere money is added up — but the bills lists
// split plans by sign alone, so the checking side read as a $12,748 monthly
// bill and the card's "Thank You" as recurring income. A plan in a category
// that is not counted is neither a bill nor income: not due, not overdue, and
// the plan rows say so for the page.
test("a plan in a category that is not counted is neither due nor overdue, and the rows carry the flag", () => {
  const bills = addCat("Bills (nc)");
  const transfers = addCat("Transfers (nc)", "expense", 1);
  const dueIn = (name: string, days: number, amount: number, cat: number) => {
    for (const back of [3, 2, 1]) tx(name, { amount: -amount, date: monthsBefore(daysAgo(-days), back), categoryId: cat });
  };
  dueIn("Power Co", 3, 120, bills);
  dueIn("Amex Autopay", 3, 4000, transfers);
  for (const back of [4, 3, 2]) tx("Card Payment Received", { amount: 4000, date: monthsBefore(daysAgo(10), back), categoryId: transfers }); // overdue by the other rule
  detectAndConfirm();
  const rows = recurringsForMonth(daysAgo(0).slice(0, 7));
  assert.deepEqual(
    rows.filter((r) => /Amex Autopay|Card Payment|Power Co/.test(r.merchant)).map((r) => [r.merchant, r.categoryExcluded]).sort(),
    [["Amex Autopay", 1], ["Card Payment Received", 1], ["Power Co", 0]],
    "the rows say which plans are not counted"
  );
  if (Number(daysAgo(-3).slice(8, 10)) > 28) return; // the fixture clamps to the 28th: the due day would differ
  const w = weeklyDigest();
  const due = titled(w, /^Due in the next 7 days/);
  assert.equal(due?.title, "Due in the next 7 days: $120 expected", "the autopay is not a bill due");
  assert.ok(!JSON.stringify(w).includes("Amex Autopay") && !JSON.stringify(w).includes("Card Payment"), "and neither transfer is anywhere in the weekly");
});

// WHY: vendor names come from a bank and go into HTML mail.
test("the email escapes vendor names, and its subject is the headline", () => {
  const built = { headline: "On pace to finish September $10 under budget.", lede: [], sections: [{ title: "Charges <b>", lines: ["$5 to A&W <script>x</script>"] }], todo: [] };
  const html = renderHtml(built);
  assert.ok(html.includes("A&amp;W &lt;script&gt;x&lt;/script&gt;") && html.includes("Charges &lt;b&gt;"));
  assert.ok(!/<script>/.test(html));
  assert.equal(subjectOf(built), "Daybook: On pace to finish September $10 under budget");
});

// WHY: eighteen due bills, most of them $20 subscriptions, bury the three that
// matter. The small ones fold into one line — but the total in the title still
// counts every bill, or the email would understate what is leaving the account.
test("a long list of due bills folds the small ones into one line, and the total still counts them all", () => {
  if (Number(daysAgo(-1).slice(8, 10)) > 22) return; // the fixture's due days must exist in every month and stay in order
  const cat = addCat("Bills");
  const bills: [string, number, number][] = [["Loan Co", 1351, 1], ["Sub A", 20, 2], ["Sub B", 15, 2], ["Coffee Co", 89, 3], ["Sub C", 27, 4], ["Watch Co", 600, 5], ["Sub D", 19, 5], ["Sub E", 5, 6]];
  for (const [name, amount, days] of bills) for (const back of [3, 2, 1]) tx(name, { amount: -amount, date: monthsBefore(daysAgo(-days), back), categoryId: cat });
  detectAndConfirm();
  const due = titled(weeklyDigest(), /^Due in the next 7 days/)!;
  assert.equal(due.title, "Due in the next 7 days: $2,126 expected", "every bill, folded or not");
  assert.deepEqual(due.lines.map((l) => l.replace(/^[A-Z][a-z]{2} \d+ /, "")), ["Loan Co $1,351", "Coffee Co $89", "Watch Co $600", "All other (5) $86"]);
  const amounts = due.lines.map((l) => Number(l.match(/\$([\d,]+)$/)![1].replace(/,/g, "")));
  assert.equal(amounts.reduce((a, b) => a + b, 0), 2126, "the lines add up to the title, to the dollar");
});

test("a short list of due bills is shown whole, small ones included", () => {
  if (Number(daysAgo(-1).slice(8, 10)) > 25) return;
  const cat = addCat("Bills");
  for (const [name, amount, days] of [["Loan Co", 1351, 1], ["Sub A", 20, 2], ["Sub B", 15, 3]] as const)
    for (const back of [3, 2, 1]) tx(name, { amount: -amount, date: monthsBefore(daysAgo(-days), back), categoryId: cat });
  detectAndConfirm();
  assert.equal(titled(weeklyDigest(), /^Due in the next 7 days/)!.lines.length, 3);
});

// WHY: an inbox row shows the subject and then the start of the body. The
// subject is the verdict, so a body that opens with the verdict spends the
// preview saying it twice. The hidden first line carries the next two facts;
// and in the body an amount sits in its own right-aligned cell, so a column of
// them can be read down.
test("the weekly email previews what the subject doesn't say, and sets amounts in their own column", () => {
  const cat = addCat("Shopping");
  tx("Store A", { amount: -400, date: daysAgo(2), categoryId: cat });
  const built = weeklyDigest();
  const html = renderHtml(built);
  assert.match(built.preheader!, /^\$400 spent this week outside your bills\.$/);
  assert.ok(!built.preheader!.includes(built.headline.slice(0, 20)), "not the verdict again");
  assert.ok(html.indexOf(built.preheader!) > -1 && html.indexOf(built.preheader!) < html.indexOf(built.headline), "and it comes first, hidden");
  assert.match(html, /display:none[^>]*>\$400 spent this week/);
  assert.match(html, /<td width="56"[^>]*>[A-Z][a-z]{2} \d+<\/td><td[^>]*>Store A<\/td><td align="right"[^>]*tabular-nums[^>]*>\$400<\/td>/, "date, name, amount: three cells");
});
