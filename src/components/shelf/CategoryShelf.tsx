"use client";

import { usd, isCurrentMonth } from "@/lib/format";
import { Tooltip } from "@/components/Tooltip";
import { recurringState } from "@/components/RecurringGlyph";
import type { CatSummary } from "@/components/shelf/types";
import { PropertyCard, ShelfRow } from "@/components/shelf/parts";
import { BudgetField } from "@/components/BudgetField";
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
  onDelete,
  confirmingDelete,
}: {
  data: CatSummary;
  onOpenMerchant: (merchant: string) => void;
  onSetExcluded: (exclude: boolean) => void;
  onSetBudget: (amount: number | null, period: "monthly" | "annual") => void;
  onDelete: () => void;
  confirmingDelete: boolean;
}) {
  const isIncome = data.kind === "income";
  const isExcluded = data.excludeFromTotals === 1;
  // Income, money movement and the catch-all carry no budget.
  const budgetable = !isIncome && !isExcluded && data.name !== "Uncategorized";

  // Two blocks. This month: what it spent against a typical month, and one
  // caption for the trend. The budget: its field, the bar that measures
  // against it (the Categories row's BudgetBar, with its pace line), and one
  // caption for what's left and what's recurring. The budget used to be
  // split across both, with its figure said twice. Mid-month, "spent" is
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
        {/* The month's figure leads at the summary size; "typical month" is
            its benchmark, at the card-title size on the same line height so
            the two labels still align. Equal weight was no hierarchy. */}
        <PropertyCard label={`${isIncome ? "received" : isExcluded ? "total" : "spent"}${partial ? " so far" : ""}`}>
          <div className="text-2xl font-semibold tabular-nums" data-shelf-lead>{usd(data.spent, { cents: false })}</div>
        </PropertyCard>
        <PropertyCard label="typical month">
          <div className="text-[15px] font-semibold leading-8 tabular-nums">{usd(data.monthlyAvg, { cents: false })}</div>
        </PropertyCard>
      </div>
      {/* The budget's reading sits under the figures it measures: the bar,
          then what's left of what, then what's recurring. The field that sets
          the budget comes after the evidence; between the figures and this
          line it split one reading in two. */}
      {budgetable && (
        <div className="-mt-2" data-shelf-status>
          {b.amount != null && (
            <BudgetBar spent={spentNow} budget={b.amount} pace={paceOf(data.month, b.period)} period={b.period} />
          )}
          <p className={`${b.amount != null ? "mt-2" : ""} text-xs text-[var(--muted)]`}>
            {b.amount != null ? (
              <span className={remaining < 0 ? "text-[var(--bad)]" : ""}>
                {remaining >= 0 ? `${usd(remaining, { cents: false })} left` : `${usd(-remaining, { cents: false })} over`}{" "}
                of {usd(b.amount, { cents: false })}
                {annual ? " this year" : partial ? " so far" : ""}
              </span>
            ) : (
              <span>No budget</span>
            )}
            {/* The plans' cost, as on the Categories row: what of the budget
                is already spoken for. Warn when it alone exceeds it. */}
            {recurring > 0 && (
              <span data-shelf-recurring className={b.amount != null && recurNow > b.amount ? "text-[var(--warn)]" : ""}>
                {" · "}
                {usd(recurNow, { cents: false })} recurring
              </span>
            )}
          </p>
        </div>
      )}
      {(trend || (!budgetable && recurring > 0)) && (
        <div className={`${budgetable ? "-mt-3" : "-mt-2"} text-xs text-[var(--muted)]`} data-shelf-trend>
          {trend}
          {/* No budget here (income, the catch-all): the recurring cost joins
              this caption instead. */}
          {!budgetable && recurring > 0 && (
            <span data-shelf-recurring>{trend ? " · " : ""}{usd(recurring, { cents: false })} recurring</span>
          )}
        </div>
      )}

      <MonthBars history={data.history} typical={data.monthlyAvg} partial={partial} />

      {budgetable && (
        <BudgetField
          key={`${data.id}-${b.amount ?? "none"}-${b.period}`}
          budget={b.amount}
          period={b.period}
          suggested={b.suggested}
          suggestedAnnual={b.suggestedAnnual}
          onSave={onSetBudget}
        />
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

// Twelve months of the category's spending, ending with the viewed one: the
// evidence behind "typical month", which is the dashed line. Mid-month the
// viewed bar is hatched, since it isn't a whole month (DESIGN.md §1, Honest).
function MonthBars({ history, typical, partial }: { history: CatSummary["history"]; typical: number; partial: boolean }) {
  const top = Math.max(typical, ...history.map((h) => h.spent));
  if (top <= 0) return null;
  const name = (m: string, style: "short" | "narrow") =>
    new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", { month: style, timeZone: "UTC" });
  const said = history
    .map((h, i) => `${name(h.month, "short")} ${usd(h.spent, { cents: false })}${partial && i === history.length - 1 ? " so far" : ""}`)
    .join(", ");
  return (
    <div data-month-bars>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="stat-label">Last 12 months</div>
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <span aria-hidden className="w-3 border-t border-dashed border-[var(--muted)]" />
          typical
        </span>
      </div>
      <div role="img" aria-label={`Spending by month: ${said}. Typical month ${usd(typical, { cents: false })}.`}>
        <div className="relative flex h-16 items-end gap-1">
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
                className="flex h-full flex-1 items-end"
              >
                <span
                  data-bar={h.month}
                  className={`block w-full ${tone}`}
                  style={{ height: h.spent > 0 ? `max(2px, ${(h.spent / top) * 100}%)` : 0, ...hatch }}
                />
              </Tooltip>
            );
          })}
          <span
            aria-hidden
            data-typical-line
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[var(--muted)]"
            style={{ bottom: `${(typical / top) * 100}%` }}
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
