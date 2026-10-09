import { cleanDbBeforeEach, tx } from "./helpers"; // first: points the DB at a throwaway file
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeVendorPairs, type Ask, type Candidate } from "../src/lib/vendorJudge";
import { allMergeSuggestions, approveMerge, dismissMerge, autoCombineSure } from "../src/lib/merges";
import { setChargeVendor } from "../src/lib/vendorMoves";
import { getDb } from "../src/lib/db";
import { getMerchantLinks, canonicalMerchant, merchantDisplayName, getRecurringSettings } from "../src/lib/queries";

cleanDbBeforeEach();

const TODAY = new Date("2026-10-07T12:00:00Z");
const monthly = (merchant: string, firstMonth: number, n: number, amount: number, day = 6, year = 2026) => {
  for (let i = 0; i < n; i++)
    tx(merchant, { amount, date: `${year}-${String(firstMonth + i).padStart(2, "0")}-${String(day).padStart(2, "0")}`, account: "Amex Gold" });
};
// The Roku case: a subscription renamed with a price rise, same card, same day.
const roku = () => {
  monthly("The Roku Channel", 5, 5, -16.99);
  tx("Roku", { amount: -19.99, date: "2026-10-06", account: "Amex Gold" });
};
// A stand-in model that answers every pair the same way and records what it was asked.
const fake = (answer: { same: boolean; confidence: number; why?: string }) => {
  const asked: string[] = [];
  const ask: Ask = async (batch: Candidate[]) => {
    asked.push(...batch.map((c) => c.pair));
    return batch.map(() => ({ why: "same subscription, price rose", ...answer }));
  };
  return { ask, asked };
};
const modelCards = () => allMergeSuggestions().filter((g) => g.source === "model");

// WHY: the rules miss a rename that came with a price change — "The Roku
// Channel" at $16.99 became "Roku" at $19.99 on the same card and day, and the
// plan read as lapsed beside a new one-charge vendor. The model is asked only
// about close names (Netflix is not a question), and what it is sure of is
// offered, not applied: a card the owner can Combine or Dismiss, marked as the
// model's, folding into the vendor with the history.
test("the model is asked about close names, and a sure match becomes a card the owner decides", async () => {
  roku();
  monthly("Netflix", 5, 5, -26.99, 23);
  const { ask, asked } = fake({ same: true, confidence: 0.9 });
  assert.deepEqual(await judgeVendorPairs({ ask, today: TODAY }), { asked: 1, answered: 1 });
  assert.deepEqual(asked, ["Roku|The Roku Channel"]);

  const [card, ...rest] = modelCards();
  assert.equal(rest.length, 0);
  assert.equal(card.canonical, "The Roku Channel", "folds into the vendor with five charges, not the new one");
  assert.deepEqual(card.variants.map((v) => v.count).sort(), [1, 5]);
  assert.equal(card.note, "same subscription, price rose", "the card says the model's reason");

  approveMerge(card.canonical, card.variants.map((v) => v.merchant));
  assert.equal(modelCards().length, 0, "combined: nothing left to offer");
  assert.deepEqual(await judgeVendorPairs({ ask, today: TODAY }), { asked: 0, answered: 0 }, "and nothing left to ask");
});

// WHY: each answer costs a call, so a pair is asked once — but a rename's first
// charge says little, and a "not the same" given then must not stand forever.
// It is asked again once either side charges again.
test("an answer is kept, and asked again after either side charges", async () => {
  roku();
  const { ask, asked } = fake({ same: false, confidence: 0.6 });
  await judgeVendorPairs({ ask, today: TODAY });
  await judgeVendorPairs({ ask, today: TODAY });
  assert.equal(asked.length, 1, "asked once, not on every visit");
  assert.equal(modelCards().length, 0, "a 'not the same' offers nothing");

  tx("Roku", { amount: -19.99, date: "2026-11-06", account: "Amex Gold" });
  await judgeVendorPairs({ ask, today: new Date("2026-11-07T12:00:00Z") });
  assert.equal(asked.length, 2, "Roku charged again, so the question is new");
});

// WHY: in the test the model's unsure "same" answers mixed real matches with
// look-alikes, so they are not offered; but more charges can make it sure.
test("an unsure match is not offered until more charges make the model sure", async () => {
  roku();
  await judgeVendorPairs({ ask: fake({ same: true, confidence: 0.6 }).ask, today: TODAY });
  assert.equal(modelCards().length, 0, "below the bar: not offered");

  tx("Roku", { amount: -19.99, date: "2026-11-06", account: "Amex Gold" });
  await judgeVendorPairs({ ask: fake({ same: true, confidence: 0.95 }).ask, today: new Date("2026-11-07T12:00:00Z") });
  assert.equal(modelCards().length, 1, "asked again with Roku's second charge, and now sure");
});

// WHY: the owner's no outranks the model's yes.
test("a dismissed model card stays dismissed", async () => {
  roku();
  await judgeVendorPairs({ ask: fake({ same: true, confidence: 0.9 }).ask, today: TODAY });
  const [card] = modelCards();
  for (const k of card.dismissKeys) dismissMerge(k);
  assert.equal(modelCards().length, 0);
});

// WHY: Culvers posts under many spellings, and the model was sure of four
// pairs among Culvers, Culvers Carmel, Culvers Of Franklin and Culvers Of
// Esestero. One card per pair meant Combine, then a new card under the same
// name, three times over. Names joined by any pair are one card and one
// Combine; Dismiss rules out every pair on it.
test("the model's pairs among one vendor's spellings are one card", async () => {
  monthly("Culvers", 1, 9, -12, 3);
  monthly("Culvers Carmel", 3, 3, -14, 9);
  monthly("Culvers Of Franklin", 4, 2, -11, 12);
  tx("Culvers Of Esestero", { amount: -15, date: "2026-09-20", account: "Amex Gold" });
  monthly("Netflix", 5, 5, -26.99, 23);
  const pairs = new Set(["Culvers|Culvers Carmel", "Culvers|Culvers Of Franklin", "Culvers Carmel|Culvers Of Esestero", "Culvers Carmel|Culvers Of Franklin"]);
  const ask: Ask = async (batch) => batch.map((c) => ({ same: pairs.has(c.pair), confidence: 0.9, why: "same chain" }));
  await judgeVendorPairs({ ask, today: TODAY });

  const cards = modelCards();
  assert.equal(cards.length, 1, "one card, not one per pair");
  assert.equal(cards[0].canonical, "Culvers", "folding into the spelling with the most charges");
  assert.deepEqual(cards[0].variants.map((v) => v.merchant).sort(), ["Culvers", "Culvers Carmel", "Culvers Of Esestero", "Culvers Of Franklin"]);
  approveMerge(cards[0].canonical, cards[0].variants.map((v) => v.merchant));
  assert.equal(modelCards().length, 0, "one Combine, and nothing comes back");
});

// WHY: the busiest spelling kept the card's name, and the busiest is often
// the bank's messiest: "Franklin Liqunineveh In" over "Franklin Liquor",
// "Card And Associ" over the name it cut short. The cleanest name is
// proposed; one the owner named or set up still wins, since its settings are
// kept under it.
test("a model's card folds into the cleanest name, unless the owner set one up", async () => {
  monthly("Franklin Liqunineveh In", 1, 9, -30, 4);
  monthly("Franklin Liquor", 8, 2, -30, 4);
  monthly("Card And Associ", 1, 9, -50, 8);
  monthly("Card And Associates", 8, 2, -50, 8);
  await judgeVendorPairs({ ask: fake({ same: true, confidence: 0.9 }).ask, today: TODAY });
  const into = () => Object.fromEntries(modelCards().map((c) => [c.variants.map((v) => v.merchant).sort().join(" + "), c]));
  let cards = into();
  assert.equal(cards["Franklin Liqunineveh In + Franklin Liquor"].canonical, "Franklin Liquor", "no town glued on, though it has fewer charges");
  assert.equal(cards["Card And Associ + Card And Associates"].canonical, "Card And Associates", "not the name the bank cut short");
  assert.equal(cards["Franklin Liqunineveh In + Franklin Liquor"].fixed, false, "the owner can pick another on the card");

  getDb().prepare("INSERT INTO recurring_settings (merchant, alias) VALUES ('Franklin Liqunineveh In', 'Franklin Liquor Store')").run();
  cards = into();
  assert.equal(cards["Franklin Liqunineveh In + Franklin Liquor"].canonical, "Franklin Liqunineveh In", "the name the owner gave stays");
  assert.equal(cards["Franklin Liqunineveh In + Franklin Liquor"].fixed, true, "and can't be swapped away on the card");
  assert.equal(cards["Franklin Liqunineveh In + Franklin Liquor"].shownAs, "Franklin Liquor Store", "the card shows the owner's name, not the bank's");
  assert.equal(cards["Card And Associ + Card And Associates"].shownAs, undefined, "a vendor with no name of the owner's is shown as the bank names it");
});

// WHY: none of Apple's bank spellings is clean ("Applecombill", "Apple.com-bill
// Internet Charge"), so the cleanest of them was still a poor name. The owner
// types one on the card: the combined vendor is shown by it, and the bank's
// names are untouched.
test("a combine can name the vendor something new", async () => {
  monthly("Apple.com-bill Internet Charge", 1, 9, -2.99, 2);
  monthly("Applecombill", 8, 2, -2.99, 2);
  await judgeVendorPairs({ ask: fake({ same: true, confidence: 0.9 }).ask, today: TODAY });
  const [card] = modelCards();
  approveMerge(card.canonical, card.variants.map((v) => v.merchant), undefined, "  Apple iCloud ");
  const links = getMerchantLinks();
  const vendor = canonicalMerchant("Applecombill", links);
  assert.equal(canonicalMerchant("Apple.com-bill Internet Charge", links), vendor, "one vendor");
  assert.equal(merchantDisplayName(vendor, getRecurringSettings(), links), "Apple iCloud", "shown by the typed name, trimmed");
  assert.equal(modelCards().length, 0);
});

// WHY: the model was sure "Bp" and "Bp#1914300ninnineveh In" are one
// station chain, but the owner had since combined "Bp" into their BP vendor.
// The answer was about a name no longer its own vendor, so it was dropped, and
// BP's card offered only two Nineveh spellings. An answer follows the names
// into the vendors they were combined into.
test("the model's answer about a combined name holds for the vendor it joined", async () => {
  monthly("Bp", 6, 4, -45, 2);
  monthly("Bp#8479750fair Oaks", 1, 5, -40, 5);
  monthly("Bp#1914300ninnineveh In", 1, 9, -50, 9);
  monthly("Bp#1790955trafalgar", 6, 2, -55, 12);
  const pairs = new Set(["Bp|Bp#1914300ninnineveh In", "Bp|Bp#1790955trafalgar"]);
  const ask: Ask = async (batch) => batch.map((c) => ({ same: pairs.has(c.pair), confidence: 0.9, why: "same chain" }));
  await judgeVendorPairs({ ask, today: TODAY });
  approveMerge("Bp#8479750fair Oaks", ["Bp#8479750fair Oaks", "Bp"], undefined, "BP");

  const cards = modelCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].canonical, "Bp#8479750fair Oaks", "the owner's BP vendor, which now holds Bp");
  assert.equal(cards[0].shownAs, "BP");
  assert.deepEqual(cards[0].variants.map((v) => v.merchant).sort(), ["Bp#1790955trafalgar", "Bp#1914300ninnineveh In", "Bp#8479750fair Oaks"]);
  // Leave out finds a name's pairs though they were asked under "Bp".
  assert.deepEqual(cards[0].pairKeys?.["Bp#1790955trafalgar"], ["ai:Bp|Bp#1790955trafalgar"]);
  dismissMerge("ai:Bp|Bp#1790955trafalgar");
  assert.deepEqual(modelCards()[0].variants.map((v) => v.merchant).sort(), ["Bp#1914300ninnineveh In", "Bp#8479750fair Oaks"]);
});

test("dismissing a vendor's card rules out every pair on it", async () => {
  monthly("Culvers", 1, 9, -12, 3);
  monthly("Culvers Carmel", 3, 3, -14, 9);
  tx("Culvers Of Esestero", { amount: -15, date: "2026-09-20", account: "Amex Gold" });
  await judgeVendorPairs({ ask: fake({ same: true, confidence: 0.9 }).ask, today: TODAY });
  const [card, ...rest] = modelCards();
  assert.equal(rest.length, 0);
  for (const k of card.dismissKeys) dismissMerge(k);
  assert.equal(modelCards().length, 0, "no pair from the dismissed card comes back on its own");
});

// WHY: when a rule already offers the pair, a second card from the model would
// ask the same question twice; the rule's card says why in its own terms.
test("a pair a rule already offers gets no model card", async () => {
  tx("Target 018481indianapolis In", { amount: -40, date: "2026-09-01" });
  tx("Target", { amount: -55, date: "2026-09-20" });
  await judgeVendorPairs({ ask: fake({ same: true, confidence: 0.95 }).ask, today: TODAY });
  const cards = allMergeSuggestions();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].source, undefined, "the location rule's card, not the model's");
});

// WHY: two shops that both stopped charging years ago aren't worth a paid
// question; and without a key, nothing is sent anywhere.
test("stale pairs are not asked, and without an API key nothing is", async () => {
  monthly("Old Shop", 1, 3, -10, 6, 2022);
  monthly("Old Shop Inc", 5, 3, -10, 6, 2022);
  const { ask, asked } = fake({ same: true, confidence: 0.9 });
  await judgeVendorPairs({ ask, today: TODAY });
  assert.equal(asked.length, 0, "both last charged four years ago");

  roku();
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.deepEqual(await judgeVendorPairs({ today: TODAY }), { asked: 0, answered: 0 });
  } finally {
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
  }
});

// WHY: a vendor the owner made is a division they chose. In the first run on
// real data the model offered to fold "Apple — Wispr Flow", a split rule's
// part, back into Apple's billing; and Change vendor makes vendors the same way.
// Neither is a question to ask.
test("a vendor the owner made, by a split or by moving charges, is neither asked about nor offered", async () => {
  for (let m = 5; m <= 9; m++) {
    tx("Applecombill", { amount: -10.69, date: `2026-0${m}-12` });
    tx("Applecombill — Wispr Flow", { amount: -16.05, date: `2026-0${m}-12`, hash: `p${m}:s1` });
    tx("Applecombill", { amount: -4.99, date: `2026-0${m}-20`, hash: `m${m}` });
    setChargeVendor(`m${m}`, "Applecombill Icloud", "user");
  }
  const { ask, asked } = fake({ same: true, confidence: 0.95 });
  await judgeVendorPairs({ ask, today: TODAY });
  assert.deepEqual(asked, [], "the owner's own vendors are not candidates");
  assert.equal(modelCards().length, 0);
});

// WHY: the owner's no to a rule's card is a no to the model's too. They had
// dismissed the "Elite" location group; the model offered two Elite names again.
test("a dismissed location group rules out the model's pairs inside it", async () => {
  tx("Elite Managemcarmel In", { amount: -60, date: "2026-09-01" });
  tx("Elite Managemindianapolis In", { amount: -60, date: "2026-09-15" });
  dismissMerge("Elite");
  await judgeVendorPairs({ ask: fake({ same: true, confidence: 0.95 }).ask, today: TODAY });
  assert.equal(modelCards().length, 0);
});

// WHY: of the pairs the model judged one vendor at 0.9 or higher, the owner
// combined 104 of 110 by hand; clicking Combine on each was the chore
// ("I have clicked Combine on Culvers multiple times"). So the sync combines
// those on its own and says so; below 0.9 (105 of 180) it stays a card, and
// a pair the owner dismissed stays dismissed.
test("the sync combines what the model is surest of, and leaves the rest as cards", async () => {
  roku();
  monthly("Hulu", 5, 5, -17.99, 9);
  tx("Hulu Llc", { amount: -17.99, date: "2026-10-09", account: "Amex Gold" });
  monthly("Peacock", 5, 5, -7.99, 12);
  tx("Peacock Tv", { amount: -7.99, date: "2026-10-12", account: "Amex Gold" });
  const answers: Record<string, number> = { "Roku|The Roku Channel": 0.95, "Hulu|Hulu Llc": 0.85, "Peacock|Peacock Tv": 0.95 };
  const ask: Ask = async (batch) => batch.map((c) => ({ same: true, confidence: answers[c.pair] ?? 0.5, why: "same service" }));
  await judgeVendorPairs({ ask, today: TODAY });
  const peacock = modelCards().find((g) => g.variants.some((v) => v.merchant === "Peacock"));
  assert.ok(peacock, "Peacock was asked and judged sure");
  for (const k of peacock!.dismissKeys) dismissMerge(k);

  const done = autoCombineSure();
  assert.deepEqual(done.map((c) => [c.into, c.names]), [["The Roku Channel", ["Roku"]]], "only the sure, undismissed pair is combined");
  const links = getMerchantLinks();
  assert.equal(canonicalMerchant("Roku", links), "The Roku Channel");
  assert.equal(canonicalMerchant("Hulu Llc", links), "Hulu Llc", "0.85 is not combined");
  assert.ok(modelCards().some((g) => g.variants.some((v) => v.merchant === "Hulu Llc")), "…it stays a card for the owner");
  assert.equal(canonicalMerchant("Peacock Tv", links), "Peacock Tv", "a dismissed pair is not combined");
  assert.deepEqual(autoCombineSure(), [], "and a second sync finds nothing more");
});
