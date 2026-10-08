// How much spending outside any plan is still to come this month.
//
// The old rule was one line: this month's variable spend per day, times the days
// left. Backtested on 32 finished months of real data it missed the remaining
// spend by a median $7,500 at day 10 and $3,300 at day 20, because it treats a
// $975 Best Buy trip as $51 a day for the rest of the month.
//
// But large purchases are not rare events to be ignored either. In that data
// there were a median of three a month over $1,000, about $10,000 a month, 55%
// of all variable spend — dropping them under-forecast every month. They are a
// monthly amount that arrives in lumps. So the two are forecast separately:
//
//   everyday  — charges up to LARGE_CHARGE: this month's pace, times days left.
//   large     — the SMALLER of (a) the recent months' large-purchase pace for the
//               days left, and (b) what is left of a typical month's large
//               purchases after the ones already seen. (a) stops a quiet start
//               from promising a whole month's worth in the last week; (b)
//               stops a month that has already had its share from expecting
//               another.
//
// Same data, same months: median miss $3,600 at day 10, $1,900 at day 20, $1,100
// at day 25 — 45–55% better — with the bias near zero where the old rule ran
// $1,700–$2,800 off. Every line from $750 to $2,000 and window from 3 to 12
// months beat the old rule; $1,000 and six months are round numbers, not tuned.
//
// A charge over EXTRAORDINARY (a down payment, a tax bill) is neither
// extrapolated nor taught to the forecast: nothing predicts those.
export const LARGE_CHARGE = 1000;
export const EXTRAORDINARY = 20000;
export const HISTORY_MONTHS = 6;

export function variableStillToCome(input: {
  seen: number[]; // magnitudes of this month's charges outside any plan, so far
  daysElapsed: number;
  daysRemaining: number;
  history: { large: number; days: number }[]; // recent finished months: their large-purchase total, and length
}): number {
  const { seen, daysElapsed, daysRemaining, history } = input;
  if (daysElapsed <= 0 || daysRemaining <= 0) return 0;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const everyday = (sum(seen.filter((x) => x <= LARGE_CHARGE)) / daysElapsed) * daysRemaining;
  const largeSeen = sum(seen.filter((x) => x > LARGE_CHARGE && x <= EXTRAORDINARY));
  // No history to lean on (a new database): the old rule, for the large ones too.
  if (history.length === 0) return everyday + (largeSeen / daysElapsed) * daysRemaining;
  const typicalMonth = sum(history.map((h) => h.large)) / history.length;
  const typicalPace = sum(history.map((h) => h.large / h.days)) / history.length;
  return everyday + Math.min(typicalPace * daysRemaining, Math.max(0, typicalMonth - largeSeen));
}

// How wide a month-end projection's honest range is, as a share of it.
// `npm run backtest:pace` replays every finished month: 80% of the projections
// made on day d of 2025-01 – 2026-09 landed within this share of how the month
// ended. Measured with each month's remaining bills known exactly, so the live
// miss runs a little wider. No day gets a narrower band than a later one: day 5
// measured ±24% and day 7 ±26%, which is noise, not information.
const BAND: [day: number, share: number][] = [[5, 0.26], [7, 0.26], [10, 0.19], [15, 0.15], [20, 0.12], [25, 0.09]];

export function projectionBand(day: number, daysInMonth: number): number {
  if (day >= daysInMonth) return 0;
  if (day <= BAND[0][0]) return BAND[0][1];
  for (let i = 1; i < BAND.length; i++) {
    const [d1, s1] = BAND[i];
    const [d0, s0] = BAND[i - 1];
    if (day <= d1) return s0 + ((s1 - s0) * (day - d0)) / (d1 - d0);
  }
  // Past the last measured day, narrowing to nothing at month-end.
  const [dl, sl] = BAND[BAND.length - 1];
  return (sl * (daysInMonth - day)) / (daysInMonth - dl);
}

// The first day the chart draws the range as a band. Before it the band is
// ±25% of the month: past months really did end that far from a day-7
// projection, and neither blending in past months, splitting out large
// purchases, nor any everyday line from $150 to $1,500 narrowed it
// (backtest:pace). A band that wide fills the chart and says little, so it
// waits; the verdict still says the range in words.
export const CHART_RANGE_FROM_DAY = 10;

// The range a projection is said as. Never below what's already spent.
export function projectionRange(projected: number, spent: number, band: number): { low: number; high: number } {
  return {
    low: Number(Math.max(spent, projected * (1 - band)).toFixed(2)),
    high: Number((projected * (1 + band)).toFixed(2)),
  };
}
