"use client";

import { useState } from "react";
import { CommitInput } from "@/components/InlineEdit";
import { StateTag } from "@/components/shelf/parts";
import { usd, monthName } from "@/lib/format";

type PlanMonth = { month: string; amount: number | null; usual: number | null; edited: boolean };

// A monthly budget, planned month by month in the category shelf: the twelve
// months from the one on screen, each box the budget that holds in it. Type a
// month's own amount and Tab to the next; Enter or leaving a box saves it. A
// month with its own amount carries the `edited` tag; emptying it returns it
// to the usual budget. Behind a visible link, never a hover (DESIGN.md §1).
export function BudgetPlan({
  plan,
  onSave,
}: {
  plan: PlanMonth[];
  onSave: (month: string, amount: number | null) => void;
}) {
  const own = plan.filter((p) => p.edited).length;
  const [open, setOpen] = useState(false);
  const usual = plan[0]?.usual ?? null;

  function commit(p: PlanMonth, raw: string) {
    const t = raw.trim();
    if (t === "") return p.edited ? onSave(p.month, null) : undefined;
    const n = Number(t.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n >= 0 && n !== p.amount) onSave(p.month, n);
  }

  const label = (m: string) => {
    const short = monthName(m).slice(0, 3);
    return m.endsWith("-01") ? `${short} ${m.slice(0, 4)}` : short;
  };

  return (
    <div data-budget-plan>
      <button
        type="button"
        className="btn-ghost tap text-xs"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide months" : "Plan by month"}{own > 0 && ` · ${own} month${own === 1 ? "" : "s"} set`}
      </button>
      {open && (
        <>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {plan.map((p) => (
              <label key={p.month} className="min-w-0" data-plan-month={p.month} data-edited={p.edited ? "1" : undefined}>
                <span className="mb-1 flex items-center justify-between gap-1 text-xs text-[var(--muted)]">
                  {label(p.month)}
                  {p.edited && <StateTag edited />}
                </span>
                <CommitInput
                  key={`${p.month}-${p.amount ?? "none"}`}
                  defaultValue={p.amount === null ? "" : p.amount.toLocaleString("en-US")}
                  onCommit={(raw) => commit(p, raw)}
                  placeholder="—"
                  inputMode="decimal"
                  aria-label={`Budget for ${monthName(p.month)} ${p.month.slice(0, 4)}`}
                  className="tap-native w-full min-w-0 rounded-lg border border-[var(--border)] bg-card px-2 py-2 text-[13px] tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">
            {usual !== null
              ? `A month you set holds for that month alone. Empty it to return to the usual ${usd(usual, { cents: false })}.`
              : "A month you set holds for that month alone. Empty it to remove it."}
          </p>
        </>
      )}
    </div>
  );
}
