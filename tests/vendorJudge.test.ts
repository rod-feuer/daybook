import { cleanDbBeforeEach, tx } from "./helpers"; // first: points the DB at a throwaway file
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeVendorPairs, type Ask, type Candidate } from "../src/lib/vendorJudge";
import { allMergeSuggestions, approveMerge, dismissMerge } from "../src/lib/merges";
import { setChargeVendor } from "../src/lib/vendorMoves";

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
