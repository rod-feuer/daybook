// Replays every finished month as if it were live, to choose how the expense
// forecast paces everyday spending: `npm run backtest:pace [-- --keep]`.
// Snapshots data/copilot.db into a temp copy (as detect:diff does); the real
// file is only read.
//
// At each replay day d of month M, a model sees only M's charges through d and
// the months before M, projects month-end spend, and is scored against how M
// actually ended. The models differ only in the everyday part (charges outside
// any plan, up to LARGE_CHARGE):
//   k = 0      this month's pace alone, run-rated (what the app does today)
//   k > 0      (k × typical daily rate + everyday so far) ÷ (k + d): history
//              counts as k days of evidence, so this month's pace takes over
//              as the month fills in
// "typical" is either the last 6 months (flat) or the last 3 (recent).
//
// Held equal across models, so they can't decide the ranking:
//   - Bills still due are taken as what the month's plans actually charged
//     after d. The live app reads them off the calendar; replaying that would
//     need each past month's plans as they stood then.
//   - Large charges use the app's own rule (variableStillToCome).
//   - Extraordinary charges (over EXTRAORDINARY, outside a plan) are left out
//     of both the projection and the actual: no model forecasts them.
// So the errors are the everyday model's, plus the large rule's shared noise.
import { LIVE, copyOf, tempCopyPath, removeCopy } from "./plan-snapshot";

const DAYS = [5, 7, 10, 15, 20, 25];
// 1000: history alone, this month's pace all but ignored (the far end of the dial).
const KS = [0, 3, 5, 7, 10, 15, 20, 30, 1000];
const PRIORS = ["flat6", "recent3"] as const;
type Prior = (typeof PRIORS)[number];
// k is chosen on the earlier months and checked on the later ones, so the
// winner isn't just the setting that best fits the months it's scored on.
const SPLIT = "2025-01";

type Charge = { day: number; mag: number; plan: boolean };

async function main() {
  const keep = process.argv.includes("--keep");
  const copy = tempCopyPath("backtest-pace");
  await copyOf(LIVE, copy);
  process.env.COPILOT_DB_PATH = copy;
  const { getDb } = await import("../src/lib/db");
  const { counted, countedPlanId } = await import("../src/lib/queries");
  const { variableStillToCome, LARGE_CHARGE, EXTRAORDINARY, HISTORY_MONTHS } = await import("../src/lib/forecast");

  const rows = getDb()
    .prepare(
      `SELECT substr(COALESCE(t.effectiveDate, t.date),1,7) AS m,
              CAST(substr(COALESCE(t.effectiveDate, t.date),9,2) AS INTEGER) AS day,
              -t.amount AS mag, ${countedPlanId("t")} IS NOT NULL AS plan
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
       WHERE ${counted()} AND t.amount < 0`
    )
    .all() as { m: string; day: number; mag: number; plan: number }[];
  const byMonth = new Map<string, Charge[]>();
  for (const r of rows) {
    if (!r.plan && r.mag > EXTRAORDINARY) continue;
    const list = byMonth.get(r.m) ?? [];
    list.push({ day: r.day, mag: r.mag, plan: !!r.plan });
    byMonth.set(r.m, list);
  }

  const shift = (m: string, n: number) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
  };
  const daysIn = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const sum = (xs: Charge[]) => xs.reduce((a, c) => a + c.mag, 0);
  const everyday = (c: Charge) => !c.plan && c.mag <= LARGE_CHARGE;
  const large = (c: Charge) => !c.plan && c.mag > LARGE_CHARGE;
  const prior = (m: string, n: number) =>
    Array.from({ length: n }, (_, i) => shift(m, -1 - i)).filter((p) => byMonth.has(p));
  const dailyRate = (months: string[]) =>
    sum(months.flatMap((p) => byMonth.get(p)!.filter(everyday))) / months.reduce((a, p) => a + daysIn(p), 0);

  const current = new Date().toISOString().slice(0, 7);
  const months = [...byMonth.keys()].sort().filter((m) => m < current && prior(m, HISTORY_MONTHS).length === HISTORY_MONTHS);

  // errors[prior][k][day] = one signed relative error per month
  const errors = new Map<string, number[]>();
  const push = (key: string, e: number) => errors.set(key, [...(errors.get(key) ?? []), e]);
  // Where today's miss comes from, in dollars: each part's projection against
  // what that part actually added after d (later months, days through 15).
  const miss = { everyday: [] as number[], large: [] as number[] };
  for (const m of months) {
    const all = byMonth.get(m)!;
    const D = daysIn(m);
    const actual = sum(all);
    const history = prior(m, HISTORY_MONTHS).map((p) => ({ large: sum(byMonth.get(p)!.filter(large)), days: daysIn(p) }));
    const rates: Record<Prior, number> = { flat6: dailyRate(prior(m, 6)), recent3: dailyRate(prior(m, 3)) };
    for (const d of DAYS) {
      const seen = all.filter((c) => c.day <= d);
      const billsAfter = sum(all.filter((c) => c.plan && c.day > d));
      const largeToCome = variableStillToCome({ seen: seen.filter(large).map((c) => c.mag), daysElapsed: d, daysRemaining: D - d, history });
      const everydaySeen = sum(seen.filter(everyday));
      if (m >= SPLIT && d <= 15) {
        const after = all.filter((c) => c.day > d);
        miss.everyday.push(Math.abs((everydaySeen / d) * (D - d) - sum(after.filter(everyday))));
        miss.large.push(Math.abs(largeToCome - sum(after.filter(large))));
      }
      for (const p of PRIORS)
        for (const k of KS) {
          const rate = (k * rates[p] + everydaySeen) / (k + d);
          const projected = sum(seen) + billsAfter + largeToCome + rate * (D - d);
          push(`${m < SPLIT ? "fit" : "check"}|${p}|${k}|${d}`, (projected - actual) / actual);
        }
    }
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mape = (xs: number[]) => mean(xs.map(Math.abs));
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(7);
  const early = DAYS.filter((d) => d <= 15);
  const score = (part: string, p: Prior, k: number) => mape(early.flatMap((d) => errors.get(`${part}|${p}|${k}|${d}`) ?? []));

  const fit = months.filter((m) => m < SPLIT), check = months.filter((m) => m >= SPLIT);
  console.log(`Replayed ${months.length} finished months: ${fit.length} to choose k (${fit[0]} – ${fit.at(-1)}), ${check.length} to check it (${check[0]} – ${check.at(-1)}).`);
  console.log(`Score: mean absolute error of the month-end projection, days ${early.join("/")}.\n`);

  console.log("k".padStart(4) + PRIORS.map((p) => `${p} choose`.padStart(16) + `${p} check`.padStart(15)).join(""));
  for (const k of KS)
    console.log(String(k).padStart(4) + PRIORS.map((p) => pct(score("fit", p, k)).padStart(16) + pct(score("check", p, k)).padStart(15)).join(""));

  let best = { p: "flat6" as Prior, k: 0, s: Infinity };
  for (const p of PRIORS) for (const k of KS) if (score("fit", p, k) < best.s) best = { p, k, s: score("fit", p, k) };
  console.log(`\nChosen on the earlier months: ${best.p}, k = ${best.k}.`);

  console.log(`\nBy replay day, on the later months only (error / bias; bias > 0 means projected too high):`);
  console.log("day".padStart(4) + "today (k = 0)".padStart(22) + `${best.p}, k = ${best.k}`.padStart(26));
  for (const d of DAYS) {
    const a = errors.get(`check|flat6|0|${d}`)!, b = errors.get(`check|${best.p}|${best.k}|${d}`)!;
    console.log(String(d).padStart(4) + `${pct(mape(a))} / ${pct(mean(a))}`.padStart(22) + `${pct(mape(b))} / ${pct(mean(b))}`.padStart(26));
  }
  // The spread a range should show: 80% of later months landed within this.
  const p80 = (xs: number[]) => [...xs.map(Math.abs)].sort((x, y) => x - y)[Math.floor(xs.length * 0.8)];
  console.log(`\n80% of later months landed within (chosen model): ${DAYS.map((d) => `day ${d} ±${(p80(errors.get(`check|${best.p}|${best.k}|${d}`)!) * 100).toFixed(0)}%`).join(", ")}`);

  const avg = (xs: number[]) => Math.round(mean(xs)).toLocaleString("en-US");
  console.log(`\nWhere today's miss comes from (later months, days ${early.join("/")}; average dollars off per projection):`);
  console.log(`  everyday pace (charges up to $${LARGE_CHARGE.toLocaleString("en-US")}):  $${avg(miss.everyday)}`);
  console.log(`  large purchases (over $${LARGE_CHARGE.toLocaleString("en-US")}):         $${avg(miss.large)}`);

  if (keep) console.log(`\nkept ${copy}`);
  else removeCopy(copy);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
