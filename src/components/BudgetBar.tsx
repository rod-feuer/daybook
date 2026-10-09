// A category's budget bar (DESIGN.md §2), one on the dashboard and the
// Categories page. The full width is the category's own budget; the fill is
// what is spent, in a soft accent; past the budget the bar holds the budget
// and then the overage, in red. One marker: how far through the budget's
// period we are (the month, or the year for an annual budget), so a fill
// short of it is under pace and one past it is ahead. The category's colour
// is on its icon, never its bar. A monthly bar with bills paces them on
// their due days (billsPace), not evenly through the month.
import { Tooltip } from "@/components/Tooltip";
import { billsPace } from "@/lib/budgetOutlook";
import { usd } from "@/lib/format";

// Share of the period gone by today, for the period being viewed; null when
// that period is over or not begun (a finished month has no pace to keep).
export function paceOf(month: string, period: "monthly" | "annual" = "monthly"): number | null {
  const now = new Date();
  const [y, m] = month.split("-").map(Number);
  if (period === "annual") {
    if (y !== now.getFullYear()) return null;
    const start = new Date(y, 0, 1).getTime();
    const end = new Date(y + 1, 0, 1).getTime();
    return (now.getTime() - start) / (end - start);
  }
  if (y !== now.getFullYear() || m !== now.getMonth() + 1) return null;
  return now.getDate() / new Date(y, m, 0).getDate();
}

export function BudgetBar({
  spent,
  budget,
  pace: dayShare,
  period = "monthly",
  bills = null,
}: {
  spent: number;
  budget: number;
  pace: number | null;
  period?: "monthly" | "annual";
  bills?: { byToday: number; inMonth: number } | null;
}) {
  const span = period === "annual" ? "year" : "month";
  const billed = period === "monthly" && bills != null && bills.inMonth > 0;
  const pace = billed ? billsPace(dayShare, budget, bills) : dayShare;
  // Said on hover, and to a screen reader, which can't see the line.
  const paceLabel =
    pace == null
      ? ""
      : billed
        ? `Expected by today: ${usd(pace * budget, { cents: false })}. That's ${usd(bills.byToday, { cents: false })} in bills due so far, plus the rest of the budget spread over the month. A bar short of this line is under pace.`
        : `Today: ${Math.round(pace * 100)}% through the ${span}. A bar short of this line is under pace.`;
  const over = spent > budget;
  const scale = over ? spent : budget;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  return (
    <div className="relative" data-budget-bar>
      <div className="flex h-2 overflow-hidden rounded-full bg-[var(--muted)]/15">
        <div data-seg="spent" className="h-full bg-[var(--accent)]/60" style={{ width: pct(Math.min(spent, budget)) }} />
        {over && <div data-seg="over" className="h-full bg-[var(--bad)]" style={{ width: pct(spent - budget) }} />}
      </div>
      {pace != null && pace > 0 && pace < 1 && (
        // Taller than the bar and ringed in the card colour, so it reads over
        // the fill and the track alike. Hovering says what it is; the hover
        // zone is wider than the line so it is easy to land on.
        <span data-pace role="img" aria-label={paceLabel} className="absolute -top-0.5 -translate-x-1/2" style={{ left: pct(pace * budget) }}>
          <Tooltip
            label={paceLabel}
            onlyIfTruncated={false}
            className="flex h-3 w-3 cursor-help justify-center"
          >
            <span className="block h-3 w-0.5 rounded-full bg-[var(--foreground)] shadow-[0_0_0_1px_var(--card)]" />
          </Tooltip>
        </span>
      )}
    </div>
  );
}
