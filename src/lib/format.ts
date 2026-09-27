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
  return month === new Date().toISOString().slice(0, 7);
}

export function defaultMonth(months: string[]): string {
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return months.find((m) => m <= current) ?? months[0] ?? "";
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
