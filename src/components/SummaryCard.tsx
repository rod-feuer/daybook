import type { ReactNode } from "react";
import Link from "next/link";
import { InfoHint } from "@/components/InfoHint";
import { Tooltip } from "@/components/Tooltip";

// The page-top summary: the result on the left, counter-figures beside it,
// a progress bar, and the verdict under the bar. The month is not repeated
// here — the header's picker already says it. Categories (spent / left),
// Recurrings (paid / left to pay) and the Dashboard (net, income, expenses)
// share the card, so the tabs read as one app.
export type Figure = {
  value: string;
  label: ReactNode;
  sub?: ReactNode; // a quiet line under the label, in normal case (a delta, "so far")
  href?: string; // the figure drills into the list behind it
  tone?: "good" | "bad";
  alarm?: boolean; // = tone "bad"
};
function Fig({ f }: { f: Figure }) {
  const colour =
    f.alarm || f.tone === "bad" ? "text-[var(--bad)]" : f.tone === "good" ? "text-[var(--good)]" : "";
  // A string label is sentence case ("Net so far"). A node is the caller's,
  // already cased — CSS used to uppercase every label, which made the card
  // read as a row of small-caps.
  const label = typeof f.label === "string" ? f.label.charAt(0).toUpperCase() + f.label.slice(1) : f.label;
  const inner = (
    <>
      <div data-figure className={`text-2xl font-semibold tracking-tight tabular-nums ${colour}`}>{f.value}</div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
      {f.sub && <div className="text-xs text-[var(--muted)]">{f.sub}</div>}
    </>
  );
  return f.href ? (
    <Link href={f.href} className="block rounded-lg hover:underline">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}
export function SummaryCard({
  barTitle,
  mark,
  primary,
  secondary,
  progress,
  barLabel,
  barCaption,
  alarm = false,
  status,
  statusDetail,
  note,
  aside,
  className = "",
}: {
  primary: Figure;
  secondary?: Figure | Figure[];
  // 0..1. Omitted, the panel has no bar (Accounts: net worth is a position,
  // not progress through a month), and holds only the status line.
  progress?: number;
  barLabel?: string; // what the bar measures, for assistive tech ("70% of expected bills paid")
  barCaption?: ReactNode; // the same, in sight — where the figures above don't already say it
  barTitle?: string; // the budget panel's label ("Budget", "Bills")
  alarm?: boolean; // the bar turns red (over budget)
  // Where the month is projected to land, 0..1 of the whole: a tick on the bar,
  // so the verdict ("on pace to finish $4,732 under budget") is visible on the
  // gauge it is about. The category bars carry the same device.
  mark?: { at: number; label: string };
  status?: ReactNode; // the line under the bar; the caller sets its colours
  // Counts that follow the verdict ("· 12 upcoming · 70 paid"): bookkeeping,
  // so a caption beside it. At the verdict's size they outranked the figures.
  statusDetail?: ReactNode;
  note?: string; // a caveat on what the bar measures: a "?" beside the caption, so it costs no line
  aside?: ReactNode; // a page's own panel content where it has no bar (Accounts: what moved)
  className?: string;
}) {
  const pct = Math.max(0, Math.min(progress ?? 0, 1)) * 100;
  const secondaries = secondary == null ? [] : Array.isArray(secondary) ? secondary : [secondary];
  // Every figure at the summary size, the result (net, spent so far, paid so
  // far) first. They sit as peers in equal columns, and the result was 24px
  // beside 15px counter-figures: size said "rank" where the layout said
  // "peers", the columns' labels fell on different lines, and the scale gives
  // 24px to summary figures, plural. The result's rank is its place: first.
  // Three columns on every page, so two figures sit as a pair on the left
  // instead of spreading across the panel.
  const figureCols = "lg:grid-cols-3";
  // A card with no bar and nothing to say under it (Accounts, once net worth
  // has its figure) has no right panel: an empty one behind a hairline read as
  // something missing. The figures keep their columns.
  const panel = progress != null || !!status || !!barTitle || !!barCaption || !!aside;
  const hairline = panel
    ? "lg:after:absolute lg:after:-right-3 lg:after:top-0 lg:after:bottom-0 lg:after:border-l lg:after:border-[var(--border)] lg:after:content-['']"
    : "";
  return (
    <div className={`card p-6 ${className}`.trim()} data-summary>
      {/* Two panels: the month's figures on the left, the budget on the right,
          level with them. One column in a full-width card left the right two
          thirds empty above a bar that ran the whole width. A hairline
          separates the panels; on a phone and a tablet they stack. */}
      {/* The same 3:2 grid and 24px gap as the page's cards below, run to the
          card's edges (the negative margin undoes the padding), so the figures
          span the chart card's width and the budget panel the category card's.
          The hairline stands in the middle of the gutter between them. */}
      <div className="grid grid-cols-1 gap-6 lg:-mx-6 lg:grid-cols-5 lg:items-center">
        {/* Figures share a top line. On desktop they are three equal columns
            across the chart card's width below; on a tablet, columns at least
            128px wide (a long label such as Recurrings' "paid so far of
            $19,688 expected" may widen its column to 192px rather than wrap
            into three lines). */}
        <div className={`relative flex flex-wrap items-start gap-x-8 gap-y-4 lg:col-span-3 lg:grid ${figureCols} lg:gap-x-6 lg:pl-6 ${hairline}`}>
          <div className="min-w-0 max-sm:flex-1 sm:min-w-32 sm:max-w-48 lg:max-w-none">
            <Fig f={primary} />
          </div>
          {/* Two counter-figures don't fit beside the primary on a phone: they
              wrapped one under the other, right-aligned, a staircase. There they
              sit as a pair of columns on the primary's left edge instead. */}
          {Array.isArray(secondary) && secondary.length > 1 ? (
            <div data-figure-pair className="grid w-full grid-cols-2 items-start gap-4 sm:flex sm:w-auto sm:flex-wrap sm:gap-8 lg:contents">
              {secondary.map((f, i) => (
                <div key={i} className="min-w-0 sm:min-w-32 sm:max-w-48 lg:max-w-none">
                  <Fig f={f} />
                </div>
              ))}
            </div>
          ) : (
            secondary && (
              <div className="flex flex-wrap items-start gap-8 lg:contents">
                {(Array.isArray(secondary) ? secondary : [secondary]).map((f, i) => (
                  <div key={i} className="min-w-0 sm:min-w-32 sm:max-w-48 lg:max-w-none">
                    <Fig f={f} />
                  </div>
                ))}
              </div>
            )
          )}
        </div>
        {/* The two panels centre on one line: the figures' mass is the numbers,
            the panel's is its bar and verdict, and top-aligned the numbers sat
            level with the panel's small label over empty card. */}
        {panel && <div data-budget-panel className="min-w-0 lg:col-span-2 lg:pl-4 lg:pr-6">
          {(barTitle || barCaption) && (
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <div className="stat-label">{barTitle}</div>
              {(barCaption || note) && (
                <div className="flex items-center gap-1 whitespace-nowrap text-xs text-[var(--muted)]">
                  {barCaption && <span data-bar-caption>{barCaption}</span>}
                  {/* The caveat as a hint, not a line: a note line under one
                      card's bar made that card taller than the others. */}
                  {note && <InfoHint text={note} label="About this figure" />}
                </div>
              )}
            </div>
          )}
          {progress != null && <div className="relative">
            <div
              className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--background)]"
              role="progressbar"
              aria-label={barLabel}
              aria-valuenow={Math.round(pct)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, background: alarm ? "var(--bad)" : "var(--accent)" }}
              />
            </div>
            {mark && (
              <div data-bar-mark className="absolute top-0 -translate-x-1/2" style={{ left: `${Math.max(0, Math.min(mark.at, 1)) * 100}%` }}>
                <Tooltip label={mark.label} onlyIfTruncated={false} className="flex h-2.5 w-2 cursor-help justify-center">
                  <span className="block h-2.5 w-0.5 rounded-full bg-[var(--foreground)]/40" />
                </Tooltip>
              </div>
            )}
          </div>}
          {/* The verdict describes the bar — "on pace to finish under
              budget", "2 overdue · 20 upcoming · 60 paid", "Lake Home over
              budget" — so it sits under it, the panel's conclusion. Above the
              figures it claimed a headline role it didn't have, and on
              Recurrings read as a stray line of counts over the money. */}
          {aside}
          {status && (
            <div data-status className={`${progress != null ? "mt-3 " : ""}flex flex-wrap items-baseline gap-x-2 text-[15px] font-semibold`}>
              {status}
              {statusDetail && <span data-status-detail className="flex flex-wrap items-baseline gap-x-2 text-xs font-normal">{statusDetail}</span>}
            </div>
          )}
        </div>}
      </div>
    </div>
  );
}
