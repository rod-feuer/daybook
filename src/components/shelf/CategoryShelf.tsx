"use client";

import { usd, isCurrentMonth } from "@/lib/format";
import { recurringState } from "@/components/RecurringGlyph";
import type { CatSummary } from "@/components/shelf/types";
import { PropertyCard, ShelfRow } from "@/components/shelf/parts";
import { BudgetField } from "@/components/BudgetField";

export function CategoryHeader({ data, month }: { data: CatSummary | null; month: string }) {
  const label = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return (
    <>
      <div className="truncate text-[15px] font-semibold">
        {data ? `${data.icon} ${data.name}` : "…"}
      </div>
      {data && (
        <div className="text-xs text-[var(--muted)]">
          {data.upcoming.length > 0
            ? `${data.txCount} posted`
            : `${data.txCount} transaction${data.txCount === 1 ? "" : "s"}`}{" "}
          · {label}
        </div>
      )}
    </>
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
  const budgeted = data.budget != null && !isIncome && !isExcluded;
  // Income, money movement and the catch-all carry no budget.
  const budgetable = !isIncome && !isExcluded && data.name !== "Uncategorized";

  // The category's properties in the vendor shelf's anatomy: two cards (how
  // much this month; a typical month), then one caption line for the trend
  // and the budget, then a slim bar. Mid-month, "spent" and the trend compare
  // a partial month with full ones, so the labels say "so far".
  const partial = isCurrentMonth(data.month);
  const remaining = (data.budget ?? 0) - data.spent;
  const delta = data.spent - data.prevSpent;
  const pct = data.prevSpent ? Math.round((delta / data.prevSpent) * 100) : 0;
  const better = isIncome ? delta > 0 : delta < 0;
  const hasTrend = data.prevSpent > 0 && pct !== 0;
  const trend =
    data.prevSpent === 0
      ? data.spent === 0
        ? null
        : "new this month"
      : `${pct > 0 ? "↑" : pct < 0 ? "↓" : "="} ${Math.abs(pct)}% vs last month${partial ? " so far" : ""}`;
  const pctOfBudget = budgeted && data.budget ? Math.min(100, (data.spent / data.budget) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <PropertyCard label={`${isIncome ? "received" : isExcluded ? "total" : "spent"}${partial ? " so far" : ""}`}>
          <div className="text-[15px] font-semibold tabular-nums">{usd(data.spent, { cents: false })}</div>
        </PropertyCard>
        <PropertyCard label="typical month">
          <div className="text-[15px] font-semibold tabular-nums">{usd(data.monthlyAvg, { cents: false })}</div>
        </PropertyCard>
      </div>
      <div className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
        {trend && (
          <span className={hasTrend ? (better ? "text-[var(--good)]" : "text-[var(--warn)]") : ""}>{trend}</span>
        )}
        {budgeted && data.budget != null && (
          <span className={`whitespace-nowrap ${remaining < 0 ? "text-[var(--warn)]" : ""}`}>
            {usd(data.spent, { cents: false })} of {usd(data.budget, { cents: false })} budget ·{" "}
            {remaining >= 0 ? `${usd(remaining, { cents: false })} left` : `${usd(-remaining, { cents: false })} over`}
          </span>
        )}
      </div>
      {budgeted && data.budget != null && (
        <div
          className="-mt-2 h-2 overflow-hidden rounded-full bg-[var(--muted)]/15"
          role="progressbar"
          aria-label={`${Math.round(pctOfBudget)}% of budget used`}
          aria-valuenow={Math.round(pctOfBudget)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full ${remaining < 0 ? "bg-[var(--bad)]" : "bg-[var(--accent)]"}`}
            style={{ width: `${pctOfBudget}%` }}
          />
        </div>
      )}

      {budgetable && (
        <BudgetField
          key={`${data.id}-${data.budgetEntry.amount ?? "none"}-${data.budgetEntry.period}`}
          budget={data.budgetEntry.amount}
          period={data.budgetEntry.period}
          suggested={data.budgetEntry.suggested}
          suggestedAnnual={data.budgetEntry.suggestedAnnual}
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
