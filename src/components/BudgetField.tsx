"use client";

import { useState } from "react";
import { CommitInput } from "@/components/InlineEdit";
import { usd, monthName } from "@/lib/format";

type Period = "monthly" | "annual";

// A category's budget, edited in its shelf (DESIGN.md §2, "The shelf is the
// control surface"): a bordered amount, the period as a native select, and,
// with no budget yet, a "Use $X" offer of the typical spend. The Categories
// row only shows the budget. It used to be a field there disguised as text,
// with a "/mo" label that silently converted it to an annual budget.
// Uncontrolled and remounted via `key` when the saved value changes.
export function BudgetField({
  budget,
  period: savedPeriod = "monthly",
  suggested = 0,
  suggestedAnnual = 0,
  month,
  onSave,
}: {
  budget: number | null;
  period?: Period;
  suggested?: number;
  suggestedAnnual?: number;
  month: string; // the month on screen: a save holds from it on
  onSave: (amount: number | null, period: Period) => void;
}) {
  const [period, setPeriod] = useState<Period>(savedPeriod);
  // How to remove a budget is said while you're editing it, not always.
  const [editing, setEditing] = useState(false);
  const sug = period === "annual" ? suggestedAnnual : suggested;

  function commit(raw: string) {
    const t = raw.trim();
    if (t === "") return budget === null ? undefined : onSave(null, period);
    const n = Number(t.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n >= 0 && (n !== budget || period !== savedPeriod)) onSave(n, period);
  }

  // Switching the period keeps the real dollars when a budget is set
  // ($259 monthly is $3,108 annual) and saves; with none, it only changes
  // which typical spend is offered.
  function changePeriod(next: Period) {
    setPeriod(next);
    if (budget !== null) onSave(Number((next === "annual" ? budget * 12 : budget / 12).toFixed(2)), next);
  }

  return (
    <div data-shelf-budget onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}>
      <div className="stat-label mb-2">Budget</div>
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center rounded-lg border border-[var(--border)] bg-card px-3 focus-within:ring-2 focus-within:ring-[var(--accent)]/40">
          <span className="text-[13px] text-[var(--muted)]">$</span>
          <CommitInput
            defaultValue={budget === null ? "" : budget.toLocaleString("en-US")}
            onCommit={commit}
            placeholder="No budget"
            inputMode="decimal"
            aria-label="Budget amount"
            className="tap-native min-w-0 flex-1 bg-transparent py-2 pl-1 text-[13px] font-medium tabular-nums focus:outline-none"
          />
        </label>
        <select
          value={period}
          onChange={(e) => changePeriod(e.target.value as Period)}
          aria-label="Budget period"
          className="select-caret tap-native cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-2 pl-3 pr-8 text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
        >
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
        {budget === null && sug > 0 && (
          <button type="button" className="btn-ghost tap whitespace-nowrap" onClick={() => onSave(sug, period)}>
            Use {usd(sug, { cents: false })}
          </button>
        )}
      </div>
      {/* What a save does is said while you're editing: it holds from the
          month on screen, so the months before keep the budget they had. */}
      {editing && (
        <p className="mt-2 text-xs text-[var(--muted)]" data-budget-hint>
          From {monthName(month)} on; earlier months keep theirs.{budget !== null && " Empty the amount to remove it."}
        </p>
      )}
    </div>
  );
}
