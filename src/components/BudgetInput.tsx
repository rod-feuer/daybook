"use client";

import { type MouseEvent, useState } from "react";
import { CommitInput } from "@/components/InlineEdit";
import { Tooltip } from "@/components/Tooltip";
import { usd } from "@/lib/format";


// Inline budget editor, rendered as "of $<amount> /mo|/yr" next to the spent
// figure. A monthly or annual period can be chosen via the unit toggle.
// Uncontrolled + remounted via `key` when the saved value/period changes, so we
// avoid syncing prop→state in an effect. The recurring baseline and spent-vs-
// budget status are shown by the row's bar + caption, not here.
export function BudgetInput({
  budget,
  period: initialPeriod = "monthly",
  suggested = 0,
  suggestedAnnual = 0,
  lead = "of",
  onSave,
}: {
  budget: number | null;
  period?: "monthly" | "annual";
  suggested?: number;
  suggestedAnnual?: number;
  lead?: string; // the word before "$": "of" beside a spent figure, none on its own
  onSave: (amount: number | null, period: "monthly" | "annual") => void;
}) {
  const [period, setPeriod] = useState<"monthly" | "annual">(initialPeriod);
  const unit = period === "annual" ? "/yr" : "/mo";
  // What the input shows right now, so its box is exactly as wide as its digits
  // (an <input> can't size to its content; a hidden twin of the text can).
  const [draft, setDraft] = useState(budget === null ? "" : budget.toLocaleString("en-US"));
  const sug = period === "annual" ? suggestedAnnual : suggested;

  function commit(raw: string) {
    const t = raw.trim();
    if (t === "") return budget === null ? undefined : onSave(null, period);
    const n = Number(t.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n >= 0 && (n !== budget || period !== initialPeriod))
      onSave(n, period);
  }

  // Toggle monthly ⇄ annual. When a budget is already set, convert the amount so
  // the real budgeted dollars stay the same (e.g. $259/mo ⇄ $3,108/yr) and save
  // immediately. When empty, just switch which suggestion/unit applies next.
  function togglePeriod(e: MouseEvent) {
    e.stopPropagation();
    const next = period === "annual" ? "monthly" : "annual";
    setPeriod(next);
    if (budget !== null) {
      const converted = next === "annual" ? budget * 12 : budget / 12;
      onSave(Number(converted.toFixed(2)), next);
    }
  }

  // No budget yet, but we have a typical-spend figure → offer it as a single
  // one-tap chip ("Use $20") rather than stuffing the number into the input
  // (suggest, you confirm). The input stays empty so you can type your own. The
  // chip lives in a fixed-width slot that's reserved even when there's no
  // suggestion, so the "—"/amount columns line up across all unbudgeted rows.
  return (
    <span className="inline-flex items-baseline whitespace-nowrap text-[var(--muted)]">
      {lead && <>{lead}&nbsp;</>}$
      <Tooltip
        label={period === "annual" ? "Annual budget" : "Monthly budget"}
        onlyIfTruncated={false}
        className="inline-flex"
      >
        {/* Sized to its digits so "of $259/mo" reads as one tight phrase: an
            invisible twin of the text sets the width and the input sits over
            it. The `size` attribute over-measured and left a gap after the
            dollar sign ("of $ 10,375"). */}
        {/* Blur re-reads the input: Escape reverts its value without a change
            event, and the box must follow the text back. */}
        <span className="inline-grid" onBlur={(e) => setDraft((e.target as HTMLInputElement).value)}>
          <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre font-medium tabular-nums">
            {draft || "—"}
          </span>
          <CommitInput
            defaultValue={budget === null ? "" : budget.toLocaleString("en-US")}
            onChange={(e) => setDraft(e.target.value)}
            onCommit={commit}
            placeholder="—"
            inputMode="decimal"
            aria-label={period === "annual" ? "Annual budget" : "Monthly budget"}
            className="tap-native col-start-1 row-start-1 w-0 min-w-full rounded-lg bg-transparent px-0 font-medium tabular-nums text-[var(--foreground)] hover:bg-[var(--hover)] focus:bg-[var(--background)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/40"
          />
        </span>
      </Tooltip>
      <Tooltip
        label={period === "annual" ? "Annual budget — click for monthly" : "Monthly budget — click for annual"}
        onlyIfTruncated={false}
      >
        <button
          onClick={togglePeriod}
          className="tap rounded-lg px-1 text-[11px] font-medium text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
        >
          {unit}
        </button>
      </Tooltip>
      {budget === null && (
        <span className="ml-1 flex w-20 shrink-0 justify-end">
          {sug > 0 && (
            <Tooltip
              label={
                period === "annual"
                  ? `Set an annual budget of your ~${usd(sug, { cents: false })}/yr spend`
                  : `Set this month's budget to your ~${usd(sug, { cents: false })}/mo average`
              }
              onlyIfTruncated={false}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSave(sug, period);
                }}
                className="tap whitespace-nowrap rounded-lg bg-[var(--accent)]/10 px-2 py-1 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
              >
                Use {usd(sug, { cents: false })}
              </button>
            </Tooltip>
          )}
        </span>
      )}
    </span>
  );
}
