"use client";

import { CommitInput } from "@/components/InlineEdit";
import { StateTag } from "@/components/shelf/parts";
import { usd, monthName, isCurrentMonth } from "@/lib/format";
import { Tooltip } from "@/components/Tooltip";
import { BAR_AREA, barFigure, HATCH, monthLabel } from "@/components/shelf/bars";

export type PlanMonth = {
  month: string;
  amount: number | null;
  usual: number | null;
  edited: boolean;
  spent: number | null; // null for a month still ahead
  lastYear: number;
};

// A monthly budget, planned month by month in the category shelf: the twelve
// months from the one on screen, each box the budget that holds in it. Type a
// month's own amount and Tab to the next; Enter or leaving a box saves it. A
// month with its own amount carries the `edited` tag; emptying it returns it
// to the usual budget. Behind a visible link, never a hover (DESIGN.md §1).
export function BudgetPlan({
  plan,
  open,
  onToggle,
  onSave,
}: {
  plan: PlanMonth[];
  open: boolean; // the shelf holds it: open, its chart takes the last 12 months' place
  onToggle: () => void;
  onSave: (month: string, amount: number | null) => void;
}) {
  const own = plan.filter((p) => p.edited).length;
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
        onClick={onToggle}
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

// The twelve planned months as a chart, in the place of the shelf's last 12
// months while Plan by month is open (one chart, so last year isn't drawn
// twice), in the notation budget reports use (IBCS): the budget is an outline
// (a limit, not money spent), what's been spent is a fill inside it (hatched
// while the month is unfinished), and the same month last year is a grey bar
// behind it, the seasonal evidence the average hides. A month with its own
// amount is outlined in the accent and is the only one with a figure: the
// rest carry the usual budget, which the caption under the boxes states.
export function PlanBars({ plan }: { plan: PlanMonth[] }) {
  const top = Math.max(...plan.flatMap((p) => [p.amount ?? 0, p.spent ?? 0, p.lastYear]));
  if (top <= 0) return null;
  const px = (v: number) => (v / top) * BAR_AREA;
  const anySpent = plan.some((p) => (p.spent ?? 0) > 0); // the legend names only marks it draws
  const money = (v: number) => usd(v, { cents: false });
  const said = plan
    .map((p) => `${monthLabel(p.month, "short")} ${p.amount == null ? "no budget" : money(p.amount)}${p.edited ? " (its own)" : ""}${p.spent != null ? `, spent ${money(p.spent)}${isCurrentMonth(p.month) ? " so far" : ""}` : ""}, last year ${money(p.lastYear)}`)
    .join("; ");
  const swatch = "inline-block h-2 w-3";
  return (
    <div data-plan-bars>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="stat-label">Budget by month</div>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]" data-plan-legend>
          <span className="flex items-center gap-1"><span aria-hidden className={`${swatch} border border-[var(--foreground)]/60`} />Budget</span>
          {anySpent && <span className="flex items-center gap-1"><span aria-hidden className={`${swatch} bg-[var(--foreground)]/60`} />Spent</span>}
          <span className="flex items-center gap-1"><span aria-hidden className={`${swatch} bg-[var(--muted)]/25`} />Last year</span>
        </span>
      </div>
      <div role="img" aria-label={`Budget by month: ${said}.`}>
        {/* Room above the tallest bar for a figure. */}
        <div className="relative flex items-end gap-1" style={{ height: BAR_AREA + 16 }}>
          {plan.map((p) => {
            const budget = p.amount ?? 0;
            const outline = p.edited ? "border-[var(--accent)]" : "border-[var(--foreground)]/60";
            return (
              <Tooltip
                key={p.month}
                label={`${monthLabel(p.month, "short")} ${p.month.slice(0, 4)}: budget ${p.amount == null ? "none" : money(p.amount)}${p.spent != null ? ` · spent ${money(p.spent)}${isCurrentMonth(p.month) ? " so far" : ""}` : ""} · last year ${money(p.lastYear)}`}
                onlyIfTruncated={false}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
              >
                <span className="relative block w-full" style={{ height: BAR_AREA }} data-plan-bar={p.month}>
                  {p.lastYear > 0 && (
                    <span data-last-year className="absolute inset-x-[15%] bottom-0 bg-[var(--muted)]/25" style={{ height: px(p.lastYear) }} />
                  )}
                  {p.spent != null && p.spent > 0 && (
                    <span
                      data-spent
                      className="absolute inset-x-0 bottom-0 bg-[var(--foreground)]/60"
                      style={{ height: Math.max(2, px(p.spent)), ...(isCurrentMonth(p.month) ? HATCH : {}) }}
                    />
                  )}
                  {budget > 0 && (
                    <span data-budget-outline className={`absolute inset-x-0 bottom-0 border-[1.5px] ${outline}`} style={{ height: px(budget) }} />
                  )}
                  {/* A month that differs carries its figure on its outline,
                      even where last year's bar rises past it; no backing,
                      so that bar isn't cut in two. */}
                  {p.edited && (
                    <span
                      aria-hidden
                      data-bar-figure
                      className="absolute inset-x-0 z-20 mx-auto w-fit whitespace-nowrap text-[11px] font-medium leading-4 tabular-nums text-[var(--accent)]"
                      style={{ bottom: px(budget) }}
                    >
                      {barFigure(budget)}
                    </span>
                  )}
                </span>
              </Tooltip>
            );
          })}
        </div>
        <div aria-hidden className="mt-1 flex gap-1 text-[11px] text-[var(--muted)]">
          {plan.map((p) => (
            <span key={p.month} className="flex-1 text-center">{monthLabel(p.month, "narrow")}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
