import Anthropic from "@anthropic-ai/sdk";
import { getDb, ensureVendorJudgments } from "./db";
import { getMerchantLinks, canonicalMerchant } from "./queries";
import { getChargeMoves, vendorName } from "./chargeVendors";
import { nameAffinity, LOW_MATCH } from "./similarity";

// "Are these two vendors one payee?" asked of a model, for the pairs the merge
// queue's rules can't settle. The rules catch a location suffix, a spelling
// twin, and a bill that moved to a new name at the same price; they miss a
// rename that came with a price change ("The Roku Channel" at $16.99 became
// "Roku" at $19.99, same card, same day) and plain name variants ("Cvs" and
// "Cvs Pharmacy", "Old Navy" and "Oldnavy.com").
//
// Measured on the owner's history (2026-10-07): of 117 Combines the owner had
// made, Sonnet agreed with 107; it caught all 9 the name rules missed; and of
// 210 close-named pairs never combined, most of the ones it called the same
// were real duplicates nobody had combined. Haiku agreed with 100, and told to
// weigh the charges it got worse, so this uses Sonnet. Telling it to weigh the
// charge pattern as much as the names is what caught Roku; names alone, it
// called Roku a different product.
//
// A vendor the owner made is never asked about: in the first run the model
// offered to fold "Apple — Wispr Flow" (a split rule's part) back into Apple's
// billing, the very split the owner had made.
//
// Only pairs whose names are close (nameAffinity at LOW_MATCH or above) are
// asked, and only while one side is active: two shops that both closed years
// ago are not worth a question. Answers are kept (vendor_judgments), so each
// pair is asked once, and again after either side charges unless the answer
// was a sure "same".
// Nothing is applied: a "same" the model is sure of becomes a card in the
// merge queue, for the owner to Combine or Dismiss.

export const JUDGE_MODEL = "claude-sonnet-5-5";
export const SURE = 0.8; // below this, the test's misses and look-alikes mixed
const BATCH = 10;
const CONCURRENCY = 4;
const PER_RUN = 200; // pairs asked per run; the queue asks again on its next load
const ACTIVE_DAYS = 365; // one side charged within this
const RECENT_DAYS = 730; // and the other within this

export type Profile = { charges: number; first: string; last: string; amounts: string; cards: string; latest: string };
export type Candidate = { a: string; b: string; pair: string; basis: string; pa: Profile; pb: Profile };
export type Judgment = { same: boolean; confidence: number; why: string };

const pairKey = (a: string, b: string) => [a, b].sort().join("|");

// A charge the owner placed: moved there by Change vendor, or a split rule's
// part (splits.ts names it "<bank name> — <label>", hash "<parent>:s<n>"). A
// vendor made only of these is the owner's own division of another.
export const ownerMade = (hash: string, moves: Map<string, string>) => moves.has(hash) || /:s\d+$/.test(hash);

// Every vendor (descriptors folded by the owner's Combines and moves) with how
// it charges: what the model reads besides the names.
function vendorProfiles(): Map<string, Profile> {
  const links = getMerchantLinks();
  const moves = getChargeMoves();
  const rows = getDb()
    .prepare("SELECT merchant, hash, account, COALESCE(effectiveDate, date) AS date, -amount AS amount FROM transactions WHERE excluded = 0 AND amount < 0 ORDER BY date")
    .all() as { merchant: string; hash: string; account: string; date: string; amount: number }[];
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const v = canonicalMerchant(vendorName(r, moves), links);
    (by.get(v) ?? by.set(v, []).get(v)!).push(r);
  }
  const out = new Map<string, Profile>();
  for (const [v, rs] of by) {
    if (rs.every((r) => ownerMade(r.hash, moves))) continue;
    const amts = new Map<string, number>();
    for (const r of rs) amts.set(r.amount.toFixed(2), (amts.get(r.amount.toFixed(2)) ?? 0) + 1);
    out.set(v, {
      charges: rs.length,
      first: rs[0].date,
      last: rs[rs.length - 1].date,
      amounts: [...amts].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([a, n]) => `$${a}×${n}`).join(", "),
      cards: [...new Set(rs.map((r) => r.account))].slice(0, 3).join("; "),
      latest: rs.slice(-6).map((r) => r.date).join(", "),
    });
  }
  return out;
}

// The pairs worth asking about: close names, one side active. `today` is a
// parameter for the tests.
export function judgeCandidates(today = new Date()): Candidate[] {
  const profiles = vendorProfiles();
  const day = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  const active = day(ACTIVE_DAYS), recent = day(RECENT_DAYS);
  const names = [...profiles.keys()];
  const out: Candidate[] = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]].sort();
      const pa = profiles.get(a)!, pb = profiles.get(b)!;
      const live = (pa.last >= active && pb.last >= recent) || (pb.last >= active && pa.last >= recent);
      if (!live || nameAffinity(a, b) < LOW_MATCH) continue;
      out.push({ a, b, pair: pairKey(a, b), basis: `${pa.charges}|${pb.charges}`, pa, pb });
    }
  return out;
}

const describe = (name: string, p: Profile) =>
  `name "${name}"; ${p.charges} charges from ${p.first} to ${p.last}; amounts ${p.amounts}; card ${p.cards}; latest dates ${p.latest}`;

const PROMPT = `You review a household's card and bank charges. Each item gives two vendor names as the bank or aggregator wrote them, with how each one charges. Decide if both are the SAME merchant/payee — so their charges belong together (same business; a store location suffix, a renamed descriptor, a payment processor prefix, or a price change on the same subscription all count as same). Weigh the charge pattern as heavily as the names: when one name's charges stop and the other's start on the same card, near the same day of the month, at the same or a nearby price, the bank has renamed one payee, even if the names look unrelated. Two names charging side by side in the same months are usually two things. Different products from one parent company (e.g. two different subscriptions) are NOT the same. Different locations of one chain ARE the same.
Answer with only a JSON array, one object per item, in order: {"i": <item number>, "same": true|false, "confidence": <0..1>, "why": "<under 12 words>"}.`;

// One model call for up to BATCH pairs. An item the reply leaves out comes
// back null, and is asked again next run.
export type Ask = (batch: Candidate[]) => Promise<(Judgment | null)[]>;
const askSonnet: Ask = async (batch) => {
  const res = await new Anthropic().messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2000,
    system: PROMPT,
    messages: [{ role: "user", content: batch.map((c, i) => `Item ${i + 1}\nA: ${describe(c.a, c.pa)}\nB: ${describe(c.b, c.pb)}`).join("\n\n") }],
  });
  const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  let arr: { i: number; same: unknown; confidence: unknown; why: unknown }[] = [];
  try {
    arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  } catch {
    return batch.map(() => null);
  }
  return batch.map((_, i) => {
    const r = arr.find((x) => x.i === i + 1);
    if (!r || typeof r.same !== "boolean" || typeof r.confidence !== "number") return null;
    return { same: r.same, confidence: r.confidence, why: String(r.why ?? "") };
  });
};

// Ask about the pairs nobody has asked about (or whose answer short of a sure
// "same" is out of date), most recently active first, up to PER_RUN. Without an API key it
// asks nothing. One run at a time: a second caller waits for the first.
let running: Promise<{ asked: number; answered: number }> | null = null;
export function judgeVendorPairs(opts: { ask?: Ask; today?: Date } = {}): Promise<{ asked: number; answered: number }> {
  if (!opts.ask && !process.env.ANTHROPIC_API_KEY) return Promise.resolve({ asked: 0, answered: 0 });
  running ??= run(opts.ask ?? askSonnet, opts.today).finally(() => (running = null));
  return running;
}

async function run(ask: Ask, today?: Date) {
  const db = getDb();
  ensureVendorJudgments(db);
  const known = new Map(
    (db.prepare("SELECT pair, basis, same, confidence FROM vendor_judgments").all() as { pair: string; basis: string; same: number; confidence: number }[]).map((r) => [r.pair, r])
  );
  const pending = judgeCandidates(today)
    .filter((c) => {
      const k = known.get(c.pair);
      return !k || (k.basis !== c.basis && !(k.same && k.confidence >= SURE));
    })
    .sort((x, y) => (y.pa.last > y.pb.last ? y.pa.last : y.pb.last).localeCompare(x.pa.last > x.pb.last ? x.pa.last : x.pb.last))
    .slice(0, PER_RUN);
  const batches: Candidate[][] = [];
  for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));
  const save = db.prepare(
    `INSERT INTO vendor_judgments (pair, basis, same, confidence, why, model, judgedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pair) DO UPDATE SET basis = excluded.basis, same = excluded.same, confidence = excluded.confidence,
       why = excluded.why, model = excluded.model, judgedAt = excluded.judgedAt`
  );
  let answered = 0, next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      let answers: (Judgment | null)[];
      try {
        answers = await ask(batch);
      } catch {
        continue; // rate limited or down: asked again next run
      }
      batch.forEach((c, i) => {
        const j = answers[i];
        if (!j) return;
        save.run(c.pair, c.basis, j.same ? 1 : 0, j.confidence, j.why, JUDGE_MODEL, new Date().toISOString());
        answered++;
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { asked: pending.length, answered };
}

// The pairs the model is sure are one payee, as they stand now: each name
// read as the vendor it was since combined into, so an answer about "Bp"
// still holds once "Bp" is filed under the owner's BP vendor; a pair now one
// vendor leaves nothing to ask. `pair` is the pair as asked (its dismiss key).
export function sureJudgments(): { a: string; b: string; why: string; pair: string }[] {
  const db = getDb();
  ensureVendorJudgments(db);
  const links = getMerchantLinks();
  const rows = db.prepare("SELECT pair, why FROM vendor_judgments WHERE same = 1 AND confidence >= ?").all(SURE) as { pair: string; why: string }[];
  return rows
    .map((r) => {
      const [a, b] = r.pair.split("|").map((n) => canonicalMerchant(n, links));
      return { a, b, why: r.why, pair: r.pair };
    })
    .filter((r) => r.a !== r.b);
}
