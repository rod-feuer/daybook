"use client";

import { usd, isCurrentMonth, monthName } from "@/lib/format";
import { Tooltip } from "@/components/Tooltip";
import { recurringState } from "@/components/RecurringGlyph";
import type { CatSummary } from "@/components/shelf/types";
import { PropertyCard, ShelfRow } from "@/components/shelf/parts";
import { BudgetField } from "@/components/BudgetField";
import { BudgetPlan } from "@/components/BudgetPlan";
import { BudgetBar, paceOf } from "@/components/BudgetBar";
import { CategoryName, EditableCategoryBadge } from "@/components/CategoryIdentity";

// The category's identity, edited where it's shown (DESIGN.md §2, "The shelf
// is the control surface"): the badge opens icon, colour and type; the name
// renames in place. Both were only on the Categories row, so a category opened
// from the dashboard couldn't be renamed where you met it. The catch-all
// "Uncategorized" keeps its name and type.
export function CategoryHeader({
  data,
  month,
  onRename,
  onEditAppearance,
}: {
  data: CatSummary | null;
  month: string;
  onRename: (name: string) => void;
  onEditAppearance: (patch: { icon?: string; color?: string; kind?: "expense" | "income" }) => void;
}) {
  const label = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  if (!data) return <div className="truncate text-[15px] font-semibold">…</div>;
  const fixed = data.name === "Uncategorized";
  return (
    <div className="flex items-center gap-3" data-category-identity>
      <EditableCategoryBadge icon={data.icon} color={data.color} kind={data.kind} canEditKind={!fixed} onSave={onEditAppearance} />
      <div className="min-w-0 flex-1">
        <CategoryName name={data.name} onRename={fixed ? undefined : onRename} textClassName="text-[15px] font-semibold" />
        <div className="text-xs text-[var(--muted)]">
          {data.upcoming.length > 0
            ? `${data.txCount} posted`
            : `${data.txCount} transaction${data.txCount === 1 ? "" : "s"}`}{" "}
          · {label}
        </div>
      </div>
    </div>
  );
}

export function CategoryBody({
  data,
  onOpenMerchant,
  onSetExcluded,
  onSetBudget,
  onSetMonthBudget,
  onDelete,
  confirmingDelete,
}: {
  data: CatSummary;
  onOpenMerchant: (merchant: string) => void;
  onSetExcluded: (exclude: boolean) => void;
  onSetBudget: (amount: number | null, period: "monthly" | "annual") => void;
  onSetMonthBudget: (month: string, amount: number | null) => void;
  onDelete: () => void;
  confirmingDelete: boolean;
}) {
  const isIncome = data.kind === "income";
  const isExcluded = data.excludeFromTotals === 1;
  // Income, money movement and the catch-all carry no budget.
  const budgetable = !isIncome && !isExcluded && data.name !== "Uncategorized";

  // Two cards at one size, each carrying what it's measured against beneath
  // its label: spent, with the trend; what's left, of what, with what's
  // recurring (the average month when there's no budget). Then the budget's
  // bar, the 12 months with their average, and the field. The comparisons
  // were two loose caption lines under the bar. Mid-month, "spent" is
  // labelled "so far" and last month is compared over the same days.
  const partial = isCurrentMonth(data.month);
  const delta = data.spent - data.prevSpent;
  const pct = data.prevSpent ? Math.round((delta / data.prevSpent) * 100) : 0;
  const [py, pm] = data.month.split("-").map(Number);
  const prevName = new Date(Date.UTC(py, pm - 2, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const trend =
    data.prevSpent === 0
      ? data.spent === 0
        ? null
        : "new this month"
      : `${pct > 0 ? "↑" : pct < 0 ? "↓" : "="} ${Math.abs(pct)}% vs ${data.prevThrough ? `${prevName} 1–${data.prevThrough}` : "last month"}`;
  const recurring = !isExcluded && data.recurringMonthly > 0 ? data.recurringMonthly : 0;

  // The budget as saved: an annual one measures the year to date.
  const b = data.budgetEntry;
  const annual = b.period === "annual";
  const spentNow = annual ? b.ytdSpent : data.spent;
  const recurNow = annual ? recurring * 12 : recurring;
  const remaining = (b.amount ?? 0) - spentNow;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <PropertyCard label={`${isIncome ? "received" : isExcluded ? "total" : "spent"}${partial ? " so far" : ""}`} detail={trend}>
          <div className="text-2xl font-semibold tabular-nums" data-shelf-lead>{usd(data.spent, { cents: false })}</div>
        </PropertyCard>
        {budgetable && b.amount != null ? (
          <PropertyCard
            label={`${remaining >= 0 ? "left" : "over"}${annual ? " this year" : partial ? " so far" : ""}`}
            detail={
              <>
                <div>of {usd(b.amount, { cents: false })}</div>
                {/* The plans' cost, as on the Categories row: what of the
                    budget is already spoken for. Warn when it alone exceeds it.
                    Its own line: beside "of $10,375" it wrapped mid-phrase. */}
                {recurring > 0 && (
                  <div data-shelf-recurring className={recurNow > b.amount ? "text-[var(--warn)]" : ""}>
                    {usd(recurNow, { cents: false })} recurring
                  </div>
                )}
              </>
            }
          >
            <div className={`text-2xl font-semibold tabular-nums ${remaining < 0 ? "text-[var(--bad)]" : ""}`} data-shelf-left>
              {usd(Math.abs(remaining), { cents: false })}
            </div>
          </PropertyCard>
        ) : (
          <PropertyCard
            label="avg month"
            detail={
              <>
                {budgetable ? "No budget" : null}
                {recurring > 0 && (
                  <span data-shelf-recurring>
                    {budgetable ? " · " : ""}
                    {usd(recurring, { cents: false })} recurring
                  </span>
                )}
              </>
            }
          >
            <div className="text-2xl font-semibold tabular-nums">{usd(data.monthlyAvg, { cents: false })}</div>
          </PropertyCard>
        )}
      </div>
      {budgetable && b.amount != null && (
        <div className="-mt-2" data-shelf-status>
          <BudgetBar spent={spentNow} budget={b.amount} pace={paceOf(data.month, b.period)} period={b.period} />
        </div>
      )}

      <MonthBars history={data.history} avg={data.monthlyAvg} partial={partial} />

      {budgetable && (
        <div className="space-y-2">
          {/* The field edits the usual budget; a month with its own (set in
              Plan by month) says so, since the bar above shows that one. */}
          <BudgetField
            key={`${data.id}-${b.usual ?? "none"}-${b.period}`}
            budget={b.usual}
            period={b.period}
            suggested={b.suggested}
            suggestedAnnual={b.suggestedAnnual}
            month={data.month}
            onSave={onSetBudget}
          />
          {b.plan[0]?.edited && b.amount !== null && (
            <p className="text-xs text-[var(--muted)]" data-month-own>
              {monthName(data.month)} has its own budget, {usd(b.amount, { cents: false })}; the field sets the usual one.
            </p>
          )}
          {b.period === "monthly" && <BudgetPlan plan={b.plan} onSave={onSetMonthBudget} />}
        </div>
      )}

      {data.upcoming.length > 0 && (
        <div>
          <div className="stat-label mb-2">Upcoming this month</div>
          <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list>
            {data.upcoming.map((u) => (
              <ShelfRow
                key={u.merchant}
                date={u.dueDate}
                name={u.displayName}
                amount={-u.amount}
                muted
                recurring="in"
                flush
                showGlyph
              />
            ))}
            {/* Total — a column-foot total: the label sits under the name column,
                the amount under the amount column, mirroring the rows above. */}
            <li className="-mx-2 flex items-center gap-2 px-2 py-2 text-xs">
              <span className="w-3.5 shrink-0" aria-hidden />
              <span className="w-11 shrink-0" aria-hidden />
              <span className="flex-1 font-medium text-[var(--muted)]">Total expected</span>
              <span className="shrink-0 font-medium tabular-nums">
                {usd(-data.upcoming.reduce((a, u) => a + u.amount, 0))}
              </span>
            </li>
          </ul>
        </div>
      )}

      <div>
        <div className="stat-label mb-2">Transactions</div>
        {data.transactions.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">No transactions this month.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list>
            {data.transactions.map((t) => (
              <ShelfRow
                key={t.id}
                date={t.date}
                name={t.displayName}
                amount={t.amount}
                sign
                muted={t.excluded === 1}
                excluded={isExcluded}
                recurring={recurringState(t)}
                onClick={() => onOpenMerchant(t.merchant)}
                flush
                showGlyph
              />
            ))}
          </ul>
        )}
      </div>

      {/* The category's verbs, in the shelf like the vendor's. Exclude from
          totals is money movement (transfers, card payments, reimbursements);
          delete needs a second click within three seconds. */}
      <div className="flex gap-2">
        <button
          onClick={() => onSetExcluded(!isExcluded)}
          title="Leaves this category out of your income and expense totals — for money movement like transfers, credit-card payments, and reimbursements."
          className={`btn-ghost flex-1 text-xs ${isExcluded ? "text-[var(--warn)]" : ""}`}
        >
          {isExcluded ? "Count in totals" : "Exclude from totals"}
        </button>
        <button
          onClick={onDelete}
          aria-label={`Delete ${data.name}`}
          className={`btn-ghost flex-1 text-xs ${confirmingDelete ? "font-semibold text-[var(--bad)]" : ""}`}
        >
          {confirmingDelete ? "Confirm delete?" : "Delete category"}
        </button>
      </div>
    </div>
  );
}

// Calendar months from firstSeen through today (inclusive), clamped to [1, 12]

// Twelve months of the category's spending, ending with the viewed one, each
// bar with its figure on top: the evidence behind the average month, which is the
// dashed line. Mid-month the viewed bar is hatched, since it isn't a whole
// month (DESIGN.md §1, Honest), and the average leaves it out.
const BAR_AREA = 64; // px

// A bar's figure, short enough for a 24px column: 420, 9.9k, 14k. The "$"
// is left to the section (every figure here is money); exact on hover.
function barFigure(v: number): string {
  if (v < 1000) return String(Math.round(v));
  const k = v / 1000;
  return k < 9.95 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

function MonthBars({ history, avg, partial }: { history: CatSummary["history"]; avg: number; partial: boolean }) {
  const top = Math.max(avg, ...history.map((h) => h.spent));
  if (top <= 0) return null;
  const name = (m: string, style: "short" | "narrow") =>
    new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", { month: style, timeZone: "UTC" });
  const said = history
    .map((h, i) => `${name(h.month, "short")} ${usd(h.spent, { cents: false })}${partial && i === history.length - 1 ? " so far" : ""}`)
    .join(", ");
  const px = (v: number) => (v / top) * BAR_AREA;
  return (
    <div data-month-bars>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="stat-label">Last 12 months</div>
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]" data-avg-legend>
          <span aria-hidden className="w-3 border-t border-dashed border-[var(--muted)]" />
          Avg {usd(avg, { cents: false })}
        </span>
      </div>
      <div role="img" aria-label={`Spending by month: ${said}. Average month ${usd(avg, { cents: false })}.`}>
        {/* Room above the tallest bar for its figure. */}
        <div className="relative flex items-end gap-1" style={{ height: BAR_AREA + 16 }}>
          {history.map((h, i) => {
            const last = i === history.length - 1;
            // The viewed month is dark; mid-month it's hatched as well, since
            // it isn't a whole month yet.
            const tone = last ? "bg-[var(--foreground)]/60" : "bg-[var(--muted)]/35";
            const hatch = last && partial ? { backgroundImage: "repeating-linear-gradient(135deg, var(--card) 0 2px, transparent 2px 5px)" } : {};
            return (
              <Tooltip
                key={h.month}
                label={`${name(h.month, "short")} ${h.month.slice(0, 4)}: ${usd(h.spent, { cents: false })}${partial && last ? " so far" : ""}`}
                onlyIfTruncated={false}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              >
                {/* Each figure sits on its bar. Its backing is the panel's
                    colour, so where the average line meets a figure the
                    figure reads and the line gives way. */}
                <span
                  aria-hidden
                  data-bar-figure
                  className={`relative z-20 whitespace-nowrap bg-card text-[11px] leading-4 tabular-nums ${last ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}
                >
                  {barFigure(h.spent)}
                </span>
                <span
                  data-bar={h.month}
                  className={`block w-full ${tone}`}
                  style={{ height: h.spent > 0 ? Math.max(2, px(h.spent)) : 0, ...hatch }}
                />
              </Tooltip>
            );
          })}
          <span
            aria-hidden
            data-typical-line
            className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-[var(--muted)]"
            style={{ bottom: px(avg) }}
          />
        </div>
        <div aria-hidden className="mt-1 flex gap-1 text-[11px] text-[var(--muted)]">
          {history.map((h) => (
            <span key={h.month} className="flex-1 text-center">{name(h.month, "narrow")}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
