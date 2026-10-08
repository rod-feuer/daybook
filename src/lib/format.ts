import { MIN_ELAPSED_DAYS } from "./budgetOutlook";

export function usd(
  n: number,
  opts: { sign?: boolean; cents?: boolean } = {},
): string {
  const cents = opts.cents ?? true;
  const s = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents ? 2 : 0,
  }).format(Math.abs(n));
  if (opts.sign) return `${n < 0 ? "−" : "+"}${s}`;
  return n < 0 ? `−${s}` : s;
}

// The month to open by default: the most recent month that isn't in the future,
// so future-dated transactions don't make the app land on a month that hasn't
// started yet. Falls back to the most recent month if all data is future-dated.
// `months` is expected sorted descending, as /api/months returns it.
// The viewed month is the calendar month in progress — its figures are partial
// and every surface qualifies them ("so far", "≈") rather than stating them flat.
// "September". The header picker carries the year; the summary card does not repeat the month.
export function monthName(month: string): string {
  return new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

export function isCurrentMonth(month: string): boolean {
  return month === localToday().slice(0, 7);
}

export function defaultMonth(months: string[]): string {
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return months.find((m) => m <= current) ?? months[0] ?? "";
}

// Today on this machine's calendar, as YYYY-MM-DD. toISOString() is UTC: after
// 8pm Eastern it's already tomorrow, and a bank sync at 9pm on Oct 7 dated the
// balances Oct 8.
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function shortDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Zero-padded day ("Jun 09") — uniform width so dates line up in a column.
export function shortDatePad(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });
}

// "Jul 1, 2023" — month/day with the year, no weekday. For dates where the year
// matters (e.g. "price changed … since").
export function monthDayYear(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function longDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// The spent card's comparison with last month. Mid-month (`prevThrough`, the
// day this month's data runs to) last month is summed over the same days, and
// only once there are enough of them: the dashboard's projection waits as
// long, and on day 1 a comparison is mostly when a bill happened to post.
export function spendTrend(spent: number, prevSpent: number, prevThrough: number | null, month: string): string | null {
  if (prevSpent === 0) return spent === 0 ? null : "new this month";
  if (prevThrough != null && prevThrough < MIN_ELAPSED_DAYS) return "too early to compare";
  const pct = Math.round(((spent - prevSpent) / prevSpent) * 100);
  const [y, m] = month.split("-").map(Number);
  const prevName = new Date(Date.UTC(y, m - 2, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${pct > 0 ? "↑" : pct < 0 ? "↓" : "="} ${Math.abs(pct)}% vs ${prevThrough ? `${prevName} 1–${prevThrough}` : "last month"}`;
}

// The line under a charge that posted for another amount than it showed
// pending. A rise of 35% or less on a purchase is a tip; anything else (a
// gas station's $1 hold, a hotel's deposit) says only what it was, since
// calling a $44 settle-up a tip would be a wrong figure.
export const TIP_SHARE = 0.35;
export function pendingNote(amount: number, pendingAmount: number | null | undefined): string | null {
  if (pendingAmount == null || pendingAmount === amount) return null;
  const rise = Math.abs(amount) - Math.abs(pendingAmount);
  if (amount < 0 && pendingAmount < 0 && rise > 0 && rise <= Math.abs(pendingAmount) * TIP_SHARE)
    return `+${usd(rise)} tip`;
  return `was ${usd(Math.abs(pendingAmount))} pending`;
}
