// What the category shelf's two month charts share: the last 12 months
// (CategoryShelf's MonthBars) and the budget plan (BudgetPlan's PlanBars).

export const BAR_AREA = 64; // px

// A bar's figure, short enough for a 24px column: 420, 9.9k, 14k. The "$"
// is left to the section (every figure here is money); exact on hover.
export function barFigure(v: number): string {
  if (v < 1000) return String(Math.round(v));
  // Tenths of a thousand rounded as whole numbers: 1450 / 1000 is 1.4499… in
  // floating point, which toFixed(1) rounds to "1.4k".
  const tenths = Math.round(v / 100);
  return tenths < 100 ? `${(tenths / 10).toFixed(1)}k` : `${Math.round(v / 1000)}k`;
}

// An unfinished month is hatched: it isn't a whole month yet (DESIGN.md §1, Honest).
export const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, var(--card) 0 2px, transparent 2px 5px)" };

export const monthLabel = (m: string, style: "short" | "narrow") =>
  new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", { month: style, timeZone: "UTC" });
