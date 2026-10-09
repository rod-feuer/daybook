// Where a month is heading against its budget, in one place so the dashboard's
// headline and its budget block can never disagree.
//
// A projection is an estimate, so a miss inside its own noise is not a miss:
// "$88 over" on a $42,530 budget (0.2%) wore the same red as a real overrun.
// Within TOLERANCE of the budget the month is ON budget — said in neutral words,
// without a dollar figure that pretends to a precision the forecast doesn't have.
// A finished month is a fact, not a forecast, so it gets no tolerance: $88 over
// is $88 over.
export const BUDGET_TOLERANCE = 0.01;

// Days of a month's data before a rate or a comparison means anything: the
// dashboard's projection and the category shelf's "vs last month" wait for
// them. On day 1 a comparison is mostly when a bill happened to post.
export const MIN_ELAPSED_DAYS = 5;

export type BudgetOutlook = { kind: "over" | "under" | "on"; delta: number };

// With a forecast's range (projectionRange), the range decides: under or over
// only when all of it is on one side of the budget; a range that spans the
// budget is "on". The 1% tolerance is for a bare figure, without a range.
export function budgetOutlook(
  total: number,
  projected: number,
  isForecast: boolean,
  range?: { low: number; high: number } | null
): BudgetOutlook {
  const delta = projected - total;
  if (isForecast && range) {
    if (range.high < total) return { kind: "under", delta };
    if (range.low > total) return { kind: "over", delta };
    return { kind: "on", delta };
  }
  const slack = isForecast ? BUDGET_TOLERANCE * total : 0.5; // a finished month: on budget only to the dollar
  if (Math.abs(delta) <= slack) return { kind: "on", delta };
  return { kind: delta > 0 ? "over" : "under", delta };
}

// Whether a category is over its budget. An annual budget is judged on the
// calendar year so far, a monthly one on the month — so a category with an
// annual budget is not "over" for one heavy month.
type Budgeted = { budget: number | null; budgetPeriod: "monthly" | "annual"; ytdSpent: number; total: number };
export const budgetSpent = (c: Budgeted) => (c.budgetPeriod === "annual" ? c.ytdSpent : c.total);
export const isOverBudget = (c: Budgeted) => c.budget != null && budgetSpent(c) > c.budget;

// Where a monthly budget bar's pace line sits, as a share of the budget. Bills
// land on their days, not evenly: a home whose mortgage charges on the 1st has
// spent most of its month by the 9th, and an even line through the month
// called that "ahead" (DESIGN.md §2). So the line is the bills due by today
// plus the rest of the budget spread evenly over the month. `dayShare` is the
// share of the month gone (paceOf); null when the month isn't the one being
// lived, and then there is no line.
export function billsPace(
  dayShare: number | null,
  budget: number,
  bills: { byToday: number; inMonth: number } | null | undefined
): number | null {
  if (dayShare == null || !bills || budget <= 0) return dayShare;
  const rest = Math.max(budget - bills.inMonth, 0);
  return Math.min(1, (bills.byToday + rest * dayShare) / budget);
}
