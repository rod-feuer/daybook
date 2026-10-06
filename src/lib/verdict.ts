import { budgetOutlook } from "./budgetOutlook";
import { usd } from "./format";
import type { DashboardData } from "./core";

// Where a forecast's range lands against the budget, in words: "$2,100–$9,400
// under budget", "between $3,000 under and $8,000 over budget". Rounded to $100:
// a range is a statement about spread, not about dollars. The dashboard and the
// digest both say it, so it lives here once.
export function rangeAgainstBudget(total: number, range: { low: number; high: number }): string {
  const r = (n: number) => Math.round(n / 100) * 100;
  const m = (n: number) => usd(n, { cents: false });
  const span = (a: number, b: number, side: string) =>
    b === 0 ? "on budget" : a === b ? `${m(b)} ${side} budget` : a === 0 ? `up to ${m(b)} ${side} budget` : `${m(a)}–${m(b)} ${side} budget`;
  if (range.high < total) return span(r(total - range.high), r(total - range.low), "under");
  if (range.low > total) return span(r(range.low - total), r(range.high - total), "over");
  const under = r(total - range.low), over = r(range.high - total);
  if (under === 0 && over === 0) return "on budget";
  return `between ${m(under)} under and ${m(over)} over budget`;
}

// One plain-language headline answering "how am I doing this month?" — so the
// dashboard leads with a verdict instead of three co-equal numbers. Leads with
// the budget (the user's own plan); for an in-progress month it speaks in pace
// terms and stays neutral until there's enough data to project. Falls back to
// cash flow when no budgets are set. Shared by the dashboard and the digests,
// so a message can never say something the screen doesn't.
export function buildVerdict(
  data: Pick<DashboardData, "budget" | "expenses" | "net">,
  isCurrentMonth: boolean
): { tone: "good" | "bad" | "neutral"; text: string } {
  const m = (n: number) => usd(Math.abs(n), { cents: false });
  const b = data.budget;
  if (b && b.total > 0) {
    // Only the judgement: the card's own caption says how much of the budget is
    // used, and the sentence with both wrapped to two lines.
    if (b.projected == null) return { tone: "neutral", text: "Too early to project the month" };
    // budgetOutlook is the one rule for over / under / on budget, including
    // what counts as "on".
    const o = budgetOutlook(b.total, b.projected, isCurrentMonth, b.range);
    // In progress, the projection is said as its range; the colour only once
    // all of it is on one side of the budget.
    if (isCurrentMonth && b.range) {
      const tone = o.kind === "over" ? "bad" : o.kind === "under" ? "good" : "neutral";
      return { tone, text: `On pace to finish ${rangeAgainstBudget(b.total, b.range)}` };
    }
    const verb = isCurrentMonth ? "On pace to finish" : "Finished";
    if (o.kind === "over") return { tone: "bad", text: `${verb} ${m(o.delta)} over budget` };
    if (o.kind === "under") return { tone: "good", text: `${verb} ${m(o.delta)} under budget` };
    return { tone: "neutral", text: `${verb} on budget` };
  }
  // No budgets set — fall back to cash flow. Mid-month net is partial, so stay
  // factual rather than calling a verdict on an incomplete month.
  if (isCurrentMonth)
    return { tone: "neutral", text: `${m(data.expenses)} spent so far this month` };
  const net = Math.round(data.net);
  if (net >= 0) return { tone: "good", text: `Net positive — you kept ${m(net)} this month` };
  return { tone: "bad", text: `Net negative — you spent ${m(net)} more than you earned` };
}
