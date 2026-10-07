// The one cadence table. Every place that converts a cadence to a period, an
// annual multiple, or a per-month share reads from here — a cadence the detector
// can emit but a consumer's table lacks silently falls back to the wrong factor
// (quarterly bills were once counted at 12× their real monthly cost).
import type { Recurring } from "./types";

export type Cadence = Recurring["cadence"];

// Approximate days between charges.
export const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  bimonthly: 61, // every two months — a subscription that moved from monthly to a two-month plan
  quarterly: 91,
  semiannual: 182,
  yearly: 365,
};

// Charges per year.
export const PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
  semiannual: 2,
  yearly: 1,
};

// What a cadence is called, everywhere it is shown. There were two copies (the
// recurrings row's tag and the shelf's picker); adding "Every 2 months" meant
// editing both, and missing one would have shown the raw key.
export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  bimonthly: "Every 2 months",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  yearly: "Yearly",
};
export const cadenceLabel = (cadence: string): string => CADENCE_LABEL[cadence as Cadence] ?? cadence;

// Share of one charge that lands in a typical month. Unknown cadence → monthly.
export function monthlyFactor(cadence: string): number {
  return (PER_YEAR[cadence as Cadence] ?? 12) / 12;
}

// Median gap, not mean — robust to missing occurrences. A skipped month, or a
// payment that landed under a drifted descriptor, would otherwise inflate the
// mean gap and push a genuine monthly bill out of the cadence window. Even
// counts average the two middles; the detector and the suggester must agree.
export function medianGap(gaps: number[]): number {
  if (gaps.length === 0) return 0;
  const s = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Days between a charge and the nearest posting of a monthly bill on `day`:
// in the charge's month, the one before, or the one after. A bill on the 31st
// posts on the 30th in a 30-day month, and Feb 28 is one day from the 1st,
// which counting every month as 31 days put four days apart.
export function monthDayGap(iso: string, day: number): number {
  const t = Date.parse(iso + "T00:00:00Z");
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1;
  let best = Infinity;
  for (const k of [-1, 0, 1]) {
    const last = new Date(Date.UTC(y, m + k + 1, 0)).getUTCDate();
    const due = Date.UTC(y, m + k, Math.min(day, last));
    best = Math.min(best, Math.abs(t - due) / 86_400_000);
  }
  return best;
}

// One cadence period after a date (YYYY-MM-DD), in UTC. The detector's next
// due and the overrides' re-derived one both step by this, so they agree.
export function addCadence(date: string, cadence: string): string {
  const d = new Date(date + "T00:00:00Z");
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "biweekly") d.setUTCDate(d.getUTCDate() + 14);
  else if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "bimonthly") d.setUTCMonth(d.getUTCMonth() + 2);
  else if (cadence === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (cadence === "semiannual") d.setUTCMonth(d.getUTCMonth() + 6);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
