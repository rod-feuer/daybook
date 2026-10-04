import { getDb } from "./db";
import { categorizeByRules, categorizeByHistory, learnRule } from "./core";
import { proposeCategories, CONFIDENCE } from "./categorize";
import { allMergeSuggestions, type MergeSuggestion } from "./merges";
import type { Category } from "./types";

// A proposed category for an uncategorized vendor, with where it came from so the
// reviewer can weigh it: a deterministic rule, the vendor's own history, or the
// model's guess (the one that most warrants a look).
export type CategorySuggestion = {
  merchant: string;
  categoryId: number;
  categoryName: string;
  categoryIcon: string;
  count: number; // uncategorized transactions this would fill
  source: "rule" | "history" | "ai";
  // How sure the model was, when it said. Unset: sure (or a provider with no
  // confidence). "possible": between the two bars. "guess": below the lower bar,
  // where it was right about 4 times in 10 — still shown, because a vendor you
  // have to go and find is worse than a guess you can see is a guess. Both are
  // tagged, sorted after the sure ones, and left out of Apply all.
  possible?: boolean;
  guess?: boolean;
  alternatives?: number[]; // the model's most probable categories, best first — the first choices when redirecting
};

function ensureDismissals(db: ReturnType<typeof getDb>) {
  db.exec("CREATE TABLE IF NOT EXISTS category_suggestion_dismissals (merchant TEXT PRIMARY KEY)");
}

// What the model said about a vendor, remembered. The queue asks on its own when
// the page loads (no button to press to see a suggestion), so without this every
// reload would ask again about the same vendors — including the ones the model
// was not sure of, which it would be not sure of again. An answer holds for the
// category list it was given (`catsKey`): rename or add a category and the
// vendor is asked afresh. categoryId is never applied from here; it is only a
// proposal until the user presses Apply.
type ModelAnswer = { merchant: string; categoryId: number; confidence: number | null; alternatives: string; provider: string; catsKey: string };
function ensureModelAnswers(db: ReturnType<typeof getDb>) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS category_model_answers (
       merchant TEXT PRIMARY KEY, categoryId INTEGER NOT NULL, confidence REAL, alternatives TEXT NOT NULL DEFAULT '[]',
       provider TEXT NOT NULL, catsKey TEXT NOT NULL, askedAt TEXT NOT NULL)`
  );
}
const catsKeyOf = (cats: Category[]) => [...cats].sort((a, b) => a.id - b.id).map((c) => `${c.id}:${c.name}:${c.kind}`).join("|");
function modelAnswers(db: ReturnType<typeof getDb>, cats: Category[]): Map<string, ModelAnswer> {
  ensureModelAnswers(db);
  const rows = db.prepare("SELECT merchant, categoryId, confidence, alternatives, provider, catsKey FROM category_model_answers WHERE catsKey = ?").all(catsKeyOf(cats)) as ModelAnswer[];
  return new Map(rows.map((r) => [r.merchant, r]));
}

// A vendor with no category that is also a duplicate candidate ("Dga" beside
// the monthly "Dgappcare Chicago" bill) has one decision, not two: is it that
// vendor? Its category follows from the answer, and Combine sets it. So the
// category queue proposes nothing for it and the model is not asked; it points
// at the merge card instead. Dismiss the merge and the vendor is back here.
// A charge whose vendor waits on a merge card: the card rides along, so a row
// can be answered where it sits (Combine) as well as on Transactions.
export type DeferredToMerge = { merchant: string; count: number; to: string; merge: MergeSuggestion };
function pendingMerges(): Map<string, MergeSuggestion> {
  const to = new Map<string, MergeSuggestion>();
  for (const g of allMergeSuggestions()) for (const v of g.variants) if (v.merchant !== g.canonical) to.set(v.merchant, g);
  return to;
}

function context(db: ReturnType<typeof getDb>) {
  ensureDismissals(db);
  const dismissed = new Set(
    (db.prepare("SELECT merchant FROM category_suggestion_dismissals").all() as { merchant: string }[]).map(
      (r) => r.merchant
    )
  );
  const cats = db.prepare("SELECT * FROM categories").all() as Category[];
  const byId = new Map(cats.map((c) => [c.id, c]));
  const uncats = db
    .prepare("SELECT merchant, COUNT(*) AS count FROM transactions WHERE categoryId IS NULL GROUP BY merchant")
    .all() as { merchant: string; count: number }[];
  return { dismissed, cats, byId, uncats, mergeTo: pendingMerges() };
}

// Proposals for every uncategorized vendor: rules and the vendor's own history
// (free, deterministic), then what the model has already said about the rest.
// No model call — cheap enough to load with the page. `needsModelCount` is the
// vendors nobody has been asked about yet.
export function categorizeSuggestions(): {
  suggestions: CategorySuggestion[];
  needsModelCount: number;
  dismissedCount: number; // vendors still uncategorized that a Dismiss keeps out of the queue
  deferred: DeferredToMerge[]; // vendors whose category waits on a merge decision
  modelEnabled: boolean;
} {
  const db = getDb();
  const { dismissed, cats, byId, uncats, mergeTo } = context(db);
  const answers = modelAnswers(db, cats);
  const suggestions: CategorySuggestion[] = [];
  const deferred: DeferredToMerge[] = [];
  let needsModelCount = 0;
  let dismissedCount = 0;

  for (const u of uncats) {
    if (dismissed.has(u.merchant)) {
      dismissedCount++;
      continue;
    }
    const merge = mergeTo.get(u.merchant);
    if (merge) {
      deferred.push({ merchant: u.merchant, count: u.count, to: merge.bill?.name ?? merge.canonical, merge });
      continue;
    }
    let categoryId = categorizeByRules(u.merchant);
    let source: CategorySuggestion["source"] = "rule";
    if (categoryId == null) {
      categoryId = categorizeByHistory(u.merchant);
      source = "history";
    }
    let possible: true | undefined;
    let guess: true | undefined;
    let alternatives: number[] | undefined;
    if (categoryId == null) {
      const a = answers.get(u.merchant);
      if (!a) {
        needsModelCount++;
        continue;
      }
      categoryId = a.categoryId;
      source = "ai";
      guess = a.confidence != null && a.confidence < CONFIDENCE.show ? true : undefined;
      possible = !guess && a.confidence != null && a.confidence < CONFIDENCE.sure ? true : undefined;
      alternatives = (JSON.parse(a.alternatives) as number[]).filter((id) => byId.has(id));
    }
    const cat = byId.get(categoryId);
    if (!cat) continue;
    suggestions.push({
      merchant: u.merchant,
      categoryId,
      categoryName: cat.name,
      categoryIcon: cat.icon,
      count: u.count,
      source,
      possible,
      guess,
      alternatives: alternatives?.length ? alternatives : undefined,
    });
  }
  // Sure ones first, then possible matches, then guesses; busiest vendor first within each.
  const tier = (s: CategorySuggestion) => (s.guess ? 2 : s.possible ? 1 : 0);
  suggestions.sort((a, b) => tier(a) - tier(b) || b.count - a.count || a.merchant.localeCompare(b.merchant));
  return { suggestions, needsModelCount, dismissedCount, deferred, modelEnabled: !!(process.env.TYPESAFE_API_KEY || process.env.ANTHROPIC_API_KEY) };
}

// Up to three merchants the user has already filed under each category (its
// busiest, never one being asked about): the context a model needs to tell
// "Lake Home" from "Carmel Home".
function categoryExamples(db: ReturnType<typeof getDb>, asking: Set<string>): Map<number, string[]> {
  const rows = db
    .prepare(
      `SELECT categoryId, merchant, COUNT(*) n FROM transactions
       WHERE categoryId IS NOT NULL AND excluded = 0 AND hash NOT LIKE '%:s%'
       GROUP BY categoryId, merchant ORDER BY n DESC`
    )
    .all() as { categoryId: number; merchant: string; n: number }[];
  const out = new Map<number, string[]>();
  for (const r of rows) {
    if (asking.has(r.merchant)) continue;
    const e = out.get(r.categoryId) ?? out.set(r.categoryId, []).get(r.categoryId)!;
    if (e.length < 3) e.push(r.merchant);
  }
  return out;
}

// Ask the model about the vendors nobody has asked about yet, and remember what
// it said — nothing is applied and no rule is learned. The page calls this on
// its own when it loads. A vendor the provider could not answer (rate limited,
// or an answer naming no real category) is not remembered, so it is asked again
// next time; a low-confidence answer IS remembered, as "not sure".
export async function categorizeSuggestionsAI(): Promise<{ asked: number; answered: number; provider: string | null }> {
  const db = getDb();
  const { dismissed, cats, uncats, mergeTo } = context(db);
  const answers = modelAnswers(db, cats);
  const asking = uncats
    .filter((u) => !dismissed.has(u.merchant) && !mergeTo.has(u.merchant) && !answers.has(u.merchant) && categorizeByRules(u.merchant) == null && categorizeByHistory(u.merchant) == null)
    .map((u) => u.merchant);
  if (asking.length === 0) return { asked: 0, answered: 0, provider: null };
  const { provider, proposals } = await proposeCategories(asking, cats, categoryExamples(db, new Set(asking)));
  const key = catsKeyOf(cats);
  const save = db.prepare(
    `INSERT INTO category_model_answers (merchant, categoryId, confidence, alternatives, provider, catsKey, askedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(merchant) DO UPDATE SET categoryId = excluded.categoryId, confidence = excluded.confidence, alternatives = excluded.alternatives,
       provider = excluded.provider, catsKey = excluded.catsKey, askedAt = excluded.askedAt`
  );
  const wanted = new Set(asking);
  db.transaction(() => {
    for (const p of proposals)
      if (wanted.has(p.merchant)) save.run(p.merchant, p.categoryId, p.confidence ?? null, JSON.stringify(p.alternatives ?? []), provider ?? "", key, new Date().toISOString());
  })();
  return { asked: asking.length, answered: proposals.filter((p) => wanted.has(p.merchant)).length, provider };
}

// Apply an approved suggestion: learn it as a user rule (so it's never asked
// again) and fill the vendor's uncategorized transactions. Returns rows filled.
export function applyCategorization(merchant: string, categoryId: number): number {
  const db = getDb();
  learnRule(merchant, categoryId, "user");
  const res = db
    .prepare("UPDATE transactions SET categoryId = ? WHERE merchant = ? AND categoryId IS NULL")
    .run(categoryId, merchant);
  return res.changes;
}

export function dismissCategorize(merchant: string) {
  const db = getDb();
  ensureDismissals(db);
  db.prepare(
    "INSERT INTO category_suggestion_dismissals (merchant) VALUES (?) ON CONFLICT(merchant) DO NOTHING"
  ).run(merchant);
}

// A Dismiss is not a one-way door: bring every dismissed vendor back into the
// queue (and the model's ask). Declining a wrong guess used to hide the
// vendor for good, so 107 dismissals once left "3 vendors need a closer look"
// over 38 uncategorized.
export function undismissCategorize() {
  const db = getDb();
  ensureDismissals(db);
  return db.prepare("DELETE FROM category_suggestion_dismissals").run().changes;
}
