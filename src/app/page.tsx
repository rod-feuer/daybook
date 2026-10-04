"use client";

import { buildVerdict } from "@/lib/verdict";
import { MIN_ELAPSED_DAYS } from "@/lib/budgetOutlook";
import { withoutAmountQualifier } from "@/lib/series";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usd, shortDate, defaultMonth, isCurrentMonth } from "@/lib/format";
import type { DashboardData } from "@/lib/core";
import type { TransactionRow } from "@/lib/queries";
import { MonthPicker, ImportButton, SeedButton, SyncBankButton } from "@/components/Actions";
import { RecurringGlyph, RECURRING_LABEL, recurringState } from "@/components/RecurringGlyph";
import { CategoryBadge } from "@/components/CategoryBadge";
import { Money } from "@/components/Money";
import { BudgetBar, paceOf } from "@/components/BudgetBar";
import { InfoHint } from "@/components/InfoHint";
import { SummaryCard } from "@/components/SummaryCard";
import { rowButtonProps, ROW_FOCUS } from "@/components/rowButton";
import { AmountCell, CategoryProperty } from "@/components/RowCells";
import type { Category } from "@/lib/types";
import { LoadError, LoadingRows } from "@/components/LoadState";
import Shell from "@/components/Shell";
import { HeaderMenu } from "@/components/HeaderMenu";
import { useTxDrawer, useCategoryShelf, useShelfActive } from "@/components/TransactionDrawer";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { useMonthBoot } from "@/components/useMonthBoot";
import { useMutation } from "@/components/useMutation";
// Aliased: `Tooltip` is already taken by recharts' chart tooltip above.
import { Tooltip as HoverTip } from "@/components/Tooltip";
import { getJson, patchJson, postJson } from "@/lib/http";
import type { CategorySuggestion, DeferredToMerge } from "@/lib/categorizeSuggest";

// Shapes come from the library that produces them; the aliases keep the file's
// existing names.
type Dash = DashboardData;

// Spending in categories without a budget, and whether it's enough to say so
// (2% of spend, or $250). The summary card's note names it; the chart then
// withholds its budget line, which would set all spending against part of it.
function outsideBudget(data: Dash) {
  const b = data.budget;
  const amount = b ? Math.max(0, Number((data.expenses - b.spent).toFixed(2))) : 0;
  return { amount, material: amount > 0 && (amount >= 250 || amount / data.expenses >= 0.02) };
}

// The chart in words, for a screen reader (and anyone who'd rather read it):
// where spending is, where it's headed, and what it's measured against.
function chartSummary(data: Dash, budgetLine: number | null) {
  const pts = data.pace.series;
  const now = [...pts].reverse().find((p) => p.actual != null);
  const end = [...pts].reverse().find((p) => p.projected != null)?.projected ?? null;
  const prevEnd = Math.max(0, ...pts.map((p) => p.prev ?? 0));
  const $ = (v: number) => usd(v, { cents: false });
  return [
    now ? `Spent ${$(now.actual as number)} through ${shortDate(now.date)}.` : "No spending yet.",
    end != null ? `Projected to finish at ${$(end)}.` : null,
    prevEnd > 0 ? `Last month finished at ${$(prevEnd)}.` : null,
    budgetLine != null ? `Budget ${$(budgetLine)}.` : null,
  ].filter(Boolean).join(" ");
}

// Charts and bars hold still when the system asks for less motion.
const reducedMotion = "(prefers-reduced-motion: reduce)";
function useReducedMotion() {
  return useSyncExternalStore(
    (on) => {
      const q = window.matchMedia(reducedMotion);
      q.addEventListener("change", on);
      return () => q.removeEventListener("change", on);
    },
    () => window.matchMedia(reducedMotion).matches,
    () => false
  );
}
type Tx = TransactionRow;

export default function DashboardPage() {
  const { months, setMonths, month, setMonth, status, setStatus, boot } = useMonthBoot();
  const [data, setData] = useState<Dash | null>(null);
  const still = useReducedMotion();
  const [recent, setRecent] = useState<Tx[]>([]);
  const openTx = useTxDrawer();
  const shelfActive = useShelfActive();

  const load = useCallback(async (m: string) => {
    setStatus("loading");
    try {
      const q = m ? `?month=${m}` : "";
      const [d, r] = await Promise.all([
        getJson<Dash>(`/api/dashboard${q}`),
        getJson<{ rows?: Tx[] } | Tx[]>(`/api/transactions${m ? `?month=${m}&` : "?"}limit=8`),
      ]);
      setData(d);
      setRecent(Array.isArray(r) ? r : r.rows ?? []); // route now returns { rows, count, net }
      setStatus("ready");
    } catch {
      // A failed read is an error state, not a blank page and not "no data".
      // Caught (rather than an unhandled rejection) so dev's red indicator
      // doesn't flash on a transient blip; Retry re-runs the whole boot.
      setStatus("error");
    }
  }, [setStatus]);

  // Months, then the month's data. Also the Retry path, so a failed months
  // read and a failed dashboard read recover the same way.
  const start = useCallback(() => boot(load), [boot, load]);

  useEffect(() => {
    void start();
  }, [start]);

  // After a sync: months may have grown, so re-read them, then reload the
  // month on screen (or the default if none is chosen yet).
  const refresh = useCallback(async () => {
    try {
      const ms = await getJson<string[]>("/api/months");
      setMonths(ms);
      await load(month || defaultMonth(ms));
    } catch {
      setStatus("error");
    }
  }, [load, month, setMonths, setStatus]);
  useSyncedRefresh(refresh);

  function changeMonth(m: string) {
    setMonth(m);
    load(m);
  }

  if (status === "ready" && months.length === 0) {
    return (
      <Shell title="Dashboard" subtitle="No data yet">
        <div className="card flex flex-col items-center gap-4 p-8 text-center">
          <div className="text-2xl">📊</div>
          <div>
            <h2 className="text-lg font-semibold">Nothing here yet</h2>
            <p className="mt-1 max-w-sm text-[13px] text-[var(--muted)]">
              Load realistic sample data to explore the app, or import a CSV export
              from your bank or Copilot.
            </p>
          </div>
          <div className="flex gap-2">
            <SeedButton onDone={refresh} />
            <ImportButton onDone={refresh} />
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Dashboard"
      // No subtitle: the month picker already shows the month (it was duplicated
      // as "June 2026" both here and in the picker below).
      month={<MonthPicker months={months} value={month} onChange={changeMonth} />}
      actions={
        <HeaderMenu>
          <SyncBankButton onDone={refresh} />
          <ImportButton onDone={refresh} />
        </HeaderMenu>
      }
    >
      {status === "error" && <LoadError what="the dashboard" onRetry={start} />}
      {status === "loading" && !data && <LoadingRows />}
      {status !== "error" && data && (
        <div className="flex flex-col gap-6">
          {/* One summary card, as on Categories and Recurrings: the projected
              net leads (the one figure that answers "how am I doing"), income
              and expenses beside it, the budget bar, and the verdict as the
              status line. The three tiles and the standalone verdict sentence
              this replaces were the last of the dashboard's own dialect. */}
          {(() => {
            const current = isCurrentMonth(month);
            const b = data.budget;
            const v = buildVerdict(data, current);
            // One frame. While the month is being projected, all three big
            // figures are the month-end view and each carries its actual "so far"
            // beneath — so the headline can be checked on the card itself:
            // expected income − projected expenses = projected net. Before, the
            // headline was projected and the two beside it were actuals, and the
            // projected spend it was built from appeared only under the chart.
            const projecting = data.projectedNet != null && data.projectedIncome != null && data.pace.projectedMonthEnd != null;
            const net = projecting ? (data.projectedNet as number) : data.net;
            const { amount: unbudgeted, material: unbudgetedMaterial } = outsideBudget(data);
            const progress = b && b.total > 0 ? b.spent / b.total : data.income > 0 ? data.expenses / data.income : 0;
            const barLabel =
              b && b.total > 0
                ? `${Math.round((b.spent / b.total) * 100)}% of budget used`
                : `${Math.round(progress * 100)}% of income spent`;
            const prevLabel = prevPeriodLabel(data.prev);
            return (
              <SummaryCard
                // The month is the header picker. Three labels each used to
                // carry the frame ("net cash flow, projected") and the card
                // read as a paragraph. Too early to project, the labels say
                // "so far"; with a projection, the line under each figure does.
                primary={{
                  value: usd(net, { sign: true, cents: false }),
                  // In progress but too early to project, the figures are the
                  // month so far and the label says so (with a projection, the
                  // "$X so far" beneath each figure carries it).
                  label: current && !projecting ? "net so far" : "net",
                  // One colour signal per card, and it is the verdict's. A red
                  // net beside a green "under budget" argued with it. Only a
                  // finished month's net is a fact, and only then does it take
                  // its colour.
                  tone: current ? undefined : net >= 0 ? "good" : "bad",
                  href: `/transactions?month=${month}`,
                  sub:
                    projecting ? (
                      // Mid-month net is misleading (income hasn't posted) — lead
                      // with the projected month-end figure, keep the actual as context.
                      <span>{usd(data.net, { sign: true, cents: false })} so far</span>
                    ) : (
                      <DeltaLine cur={data.net} prev={data.prev?.net} prevLabel={prevLabel} throughDay={data.prev?.throughDay} />
                    ),
                }}
                secondary={[
                  {
                    value: usd(projecting ? (data.projectedIncome as number) : data.income, { cents: false }),
                    label: current && !projecting ? "income so far" : "income",
                    href: `/transactions?month=${month}&type=income`,
                    sub:
                      projecting ? (
                        // Income posts late in the month, so a vs-prior delta on the
                        // amount-so-far is noise — what has arrived is the context.
                        <span>{usd(data.income, { cents: false })} so far</span>
                      ) : (
                        <DeltaLine cur={data.income} prev={data.prev?.income} prevLabel={prevLabel} throughDay={data.prev?.throughDay} />
                      ),
                  },
                  {
                    value: usd(projecting ? (data.pace.projectedMonthEnd as number) : data.expenses, { cents: false }),
                    label: current && !projecting ? "expenses so far" : "expenses",
                    href: `/transactions?month=${month}&type=expense`,
                    sub: projecting ? (
                      // One comparison while the month runs, and it is the chart's
                      // (projected vs last month). A second one here, so far vs the
                      // same days, gave a different number an inch away.
                      <span>{usd(data.expenses, { cents: false })} so far</span>
                    ) : (
                      <DeltaLine cur={data.expenses} prev={data.prev?.expenses} prevLabel={prevLabel} throughDay={data.prev?.throughDay} />
                    ),
                  },
                ]}
                progress={progress}
                // The projected month end on the budget bar, where the verdict
                // can be checked against the gauge: short of the end when under
                // budget, at the end when over.
                mark={
                  b && b.total > 0 && b.projected != null
                    ? { at: b.projected / b.total, label: `Projected to finish at ${usd(b.projected, { cents: false })} of the ${usd(b.total, { cents: false })} budget` }
                    : undefined
                }
                barLabel={barLabel}
                barTitle={b && b.total > 0 ? "Budget" : "Income"}
                // Say what the bar measures, as the other two tabs do: it sat
                // under net, income and expenses and was about none of them.
                // The share and the whole; the spent figure sits just above,
                // under Expenses, and needn't be said twice.
                // The panel's label names the whole ("Budget", or "Income" when
                // no budget is set), so the caption is the share and the figure.
                barCaption={
                  b && b.total > 0
                    ? `${Math.round((b.spent / b.total) * 100)}% of ${usd(b.total, { cents: false })}`
                    : `${Math.round(progress * 100)}% of ${usd(data.income, { cents: false })}`
                }
                alarm={!!b && b.total > 0 && b.spent > b.total}
                // The bar counts budgeted categories only. When spending outside
                // them is material (2% of spend, or $250), one line says what
                // the bar leaves out — a sentence, not an equation: its first
                // term (the budgeted spend) is no longer printed on the card.
                note={
                  b && b.total > 0 && unbudgetedMaterial
                    ? `The bar leaves out ${usd(unbudgeted, { cents: false })} spent in categories without a budget.`
                    : undefined
                }
                // The words carry the tone ("under budget") and the text its
                // colour; a status dot beside them read as a bullet under the bar.
                status={
                  <span className={v.tone === "good" ? "text-[var(--good)]" : v.tone === "bad" ? "text-[var(--bad)]" : "text-[var(--muted)]"}>
                    {v.text}
                  </span>
                }
              />
            );
          })()}

          {data.needsReview > 0 && (
            <UncategorizedResolver
              month={month}
              count={data.needsReview}
              onResolved={refresh}
            />
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <div className="card flex flex-col p-4 lg:col-span-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h3 className="text-[15px] font-semibold">Spending this month</h3>
                {/* The projected figure lives once, in the summary card; the header
                    carries the trend the chart implies but never states — how this
                    month's projection compares to last month's full total. */}
                {data.pace.projectedMonthEnd != null && data.prev != null && (
                  <PaceDelta
                    projected={data.pace.projectedMonthEnd}
                    series={data.pace.series}
                    prevMonth={data.prev.month}
                  />
                )}
              </div>
              {(() => {
                // The month's budget as a line, so the chart answers "will I
                // finish under?" by itself. Withheld when material spending sits
                // outside the budget: the curve counts it, the budget doesn't.
                const b = data.budget;
                const budgetLine = b && b.total > 0 && !outsideBudget(data).material ? b.total : null;
                return (
                  <>
                    <ChartLegend
                      showProjected={data.pace.projectedMonthEnd != null}
                      showPrev={data.prev != null}
                      showBudget={budgetLine != null}
                    />
                    <div className="min-h-[14rem] flex-1" role="img" aria-label={chartSummary(data, budgetLine)} data-pace-chart>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data.pace.series} margin={{ left: -8, right: 8, top: 4 }}>
                          <defs>
                            <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <XAxis
                            dataKey="date"
                            tickFormatter={shortDate}
                            tick={{ fontSize: 11, fill: "var(--muted)" }}
                            axisLine={false}
                            tickLine={false}
                            minTickGap={28}
                          />
                          <YAxis
                            domain={[0, (max: number) => Math.max(max, (budgetLine ?? 0) * 1.05)]}
                            tick={{ fontSize: 11, fill: "var(--muted)" }}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
                            width={44}
                          />
                          <Tooltip
                            formatter={(v, name) =>
                              [
                                usd(Number(v), { cents: false }),
                                name === "projected"
                                  ? "Projected"
                                  : name === "prev"
                                    ? "Last month"
                                    : "Spent",
                              ] as [string, string]
                            }
                            labelFormatter={(label) => shortDate(String(label))}
                            contentStyle={{
                              borderRadius: 12,
                              border: "1px solid var(--border)",
                              background: "var(--card)",
                              fontSize: 12,
                            }}
                            labelStyle={{ color: "var(--foreground)" }}
                          />
                          {budgetLine != null && (
                            <ReferenceLine
                              y={budgetLine}
                              stroke="var(--muted)"
                              strokeDasharray="2 3"
                              ifOverflow="extendDomain"
                              label={{ value: `Budget ${usd(budgetLine, { cents: false })}`, position: "insideTopRight", fontSize: 11, fill: "var(--muted)" }}
                            />
                          )}
                          {/* Faint prior-month curve, drawn first so it sits beneath. */}
                          <Area
                            type="monotone"
                            dataKey="prev"
                            isAnimationActive={!still}
                            stroke="var(--border)"
                            strokeWidth={1.5}
                            fill="none"
                            connectNulls
                            dot={false}
                            activeDot={false}
                          />
                          <Area
                            type="monotone"
                            dataKey="actual"
                            isAnimationActive={!still}
                            stroke="var(--accent)"
                            strokeWidth={2}
                            fill="url(#g)"
                            connectNulls={false}
                          />
                          <Area
                            type="monotone"
                            dataKey="projected"
                            isAnimationActive={!still}
                            stroke="var(--accent)"
                            strokeWidth={2}
                            strokeDasharray="5 4"
                            fill="none"
                            connectNulls
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                );
              })()}
            </div>

            <div className="card p-4 lg:col-span-2">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="flex items-center gap-1 text-[15px] font-semibold">
                  Spending by category
                  <InfoHint text="Each bar is the category's budget. The line marks how far through the month we are: a bar short of it is under pace, one past it is ahead." />
                </h3>
                <SeeAll href="/categories" />
              </div>
              <CategoryBars rows={data.byCategory} month={month} />
            </div>
          </div>

          {data.upcoming.count > 0 && (
            <div className="card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[15px] font-semibold">
                  Upcoming bills · next {data.upcoming.windowDays} days
                </h3>
                <SeeAll href="/recurrings" />
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {data.upcoming.items.map((u, i) => (
                  <li key={i}>
                    <button
                      data-drawer-row
                      onClick={() => openTx(u.merchant, { onChange: refresh, series: u.series ?? undefined })}
                      className={`group -mx-2 flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors ${
                        shelfActive.isMerchant(u.merchant, u.series ?? undefined)
                          ? "bg-[var(--accent)]/10"
                          : "hover:bg-[var(--hover)]"
                      }`}
                    >
                      <CategoryBadge icon={u.categoryIcon} color={u.categoryColor} fallback={u.name} />
                      <div className="min-w-0 flex-1">
                        {/* Beside its amount, a series keyed by amount needn't repeat it. */}
                        <div className="truncate text-[13px] font-medium">{withoutAmountQualifier(u.name)}</div>
                        <div className="text-xs text-[var(--muted)]">
                          {shortDate(u.nextDate)}
                          {u.categoryName ? ` · ${u.categoryName}` : ""}
                        </div>
                      </div>
                      <div className="text-[13px] font-semibold tabular-nums">
                        {usd(u.amount, { sign: true })}
                      </div>
                      <DrillChevron />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between text-xs text-[var(--muted)]">
                <span>
                  {data.upcoming.count > data.upcoming.items.length
                    ? `+${data.upcoming.count - data.upcoming.items.length} more`
                    : `${data.upcoming.count} total`}
                </span>
                <span className="font-medium">
                  {usd(data.upcoming.total)} due in {data.upcoming.windowDays} days
                </span>
              </div>
            </div>
          )}

          <div className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">Recent activity</h3>
              <SeeAll href={`/transactions${month ? `?month=${month}` : ""}`} />
            </div>
            <ul className="divide-y divide-[var(--border)]">
              {recent.map((t) => (
                <li key={t.id}>
                  <button
                    data-drawer-row
                    onClick={() => openTx(t.merchant, { onChange: refresh })}
                    className={`group -mx-2 flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors ${
                      shelfActive.isMerchant(t.merchant)
                        ? "bg-[var(--accent)]/10"
                        : "hover:bg-[var(--hover)]"
                    }`}
                  >
                    <CategoryBadge icon={t.categoryIcon} color={t.categoryColor} fallback={t.displayName} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium">{t.displayName}</span>
                        {recurringState(t) !== "none" && (
                          <HoverTip label={RECURRING_LABEL[recurringState(t)]} onlyIfTruncated={false} className="shrink-0 text-xs">
                            <RecurringGlyph state={recurringState(t)} />
                          </HoverTip>
                        )}
                      </div>
                      <div className="text-xs text-[var(--muted)]">
                        {shortDate(t.date)} · {t.categoryName ?? "Uncategorized"}
                      </div>
                    </div>
                    <Money
                      value={t.amount}
                      excluded={!!t.categoryExcluded}
                      className="text-[13px] font-semibold"
                    />
                    <DrillChevron />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Shell>
  );
}

// Legend for the pace chart's three lines — so the faint "last month" reference
// and the dashed projection are self-explanatory, not mystery lines.
function ChartLegend({
  showProjected,
  showPrev,
  showBudget,
}: {
  showProjected: boolean;
  showPrev: boolean;
  showBudget: boolean;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--muted)]">
      <span className="flex items-center gap-2">
        <span className="inline-block h-0.5 w-3.5 rounded-full bg-[var(--accent)]" />
        This month
      </span>
      {showProjected && (
        <span className="flex items-center gap-2">
          <span className="inline-block w-3.5 border-t-2 border-dashed border-[var(--accent)]" />
          Projected
        </span>
      )}
      {showPrev && (
        <span className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3.5 rounded-full bg-[var(--border)]" />
          Last month
        </span>
      )}
      {showBudget && (
        <span className="flex items-center gap-2">
          <span className="inline-block w-3.5 border-t border-dotted border-[var(--muted)]" />
          Budget
        </span>
      )}
    </div>
  );
}

// Pace metrics under the chart — fills the height the category card forces on this
// card with useful context (and gives the chart card a reason to be this tall).
// Persistent-but-faint affordance marking a row/card as drillable. Visible at
// rest (so the interaction is discoverable, not hover-only) and strengthens +
// nudges right on hover. Parent must carry `group`.
// Secondary header actions behind a "⋯" on mobile (rendered inline on desktop by
// the caller). Lightweight dropdown — mirrors the transactions "+ Filter" menu.
function DrillChevron({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`h-4 w-4 shrink-0 text-[var(--muted)] opacity-60 transition-all group-hover:opacity-100 group-hover:translate-x-0.5 ${className}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// One consistent "See all →" link for every truncated list on the dashboard.
function SeeAll({ href }: { href: string }) {
  return (
    <Link href={href} className="btn-link">
      See all →
    </Link>
  );
}

function shortMonth(month: string): string {
  return new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

// Label for the comparison baseline. When the viewed month is in progress the
// baseline is bounded to the prior month's first `throughDay` days, so say so
// ("May 1–9") rather than implying a full-month comparison ("May").
function prevPeriodLabel(prev: Dash["prev"]): string | null {
  if (!prev) return null;
  const m = shortMonth(prev.month);
  return prev.throughDay != null ? `${m} 1–${prev.throughDay}` : m;
}

// Month-over-month delta shown under a stat, as "$abs (%)" — dollars answer
// "how much", percent answers "how unusual". Color reflects whether the move is
// favorable, which depends on the metric — hence `higherIsGood`. The percent is
// omitted when the base is zero or the sign flips (where a % would mislead);
// that only arises for net cash flow, since income/expenses are non-negative.
// One colour signal per card, and it is the verdict's (DESIGN.md §2): the
// deltas were red or green under every figure, three signals beside the
// verdict. They read in the muted text; the arrow says the direction.
// Compared over fewer than MIN_ELAPSED_DAYS of the month, a delta is when a
// bill happened to post ("Income ▼ 67% vs Sep 1–3" on $82), so there is none:
// the "so far" labels and the verdict already say the month is young, and a
// "too early to compare" under each figure said it three more times.
function DeltaLine({
  cur,
  prev,
  prevLabel,
  throughDay,
}: {
  cur: number;
  prev: number | undefined;
  prevLabel: string | null | undefined;
  throughDay?: number | null;
}) {
  if (prev === undefined || !prevLabel) return null;
  if (throughDay != null && throughDay < MIN_ELAPSED_DAYS) return null;
  const change = cur - prev;
  if (Math.round(change) === 0) {
    return (
      <div className="mt-1 text-xs font-medium text-[var(--muted)]">
        No change vs {prevLabel}
      </div>
    );
  }
  const up = change > 0;
  const dollars = usd(Math.abs(change), { cents: false });
  const showPct = prev !== 0 && Math.sign(cur) === Math.sign(prev);
  const pct = showPct
    ? ` (${Math.abs(Math.round((change / Math.abs(prev)) * 100))}%)`
    : "";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1 text-xs font-medium text-[var(--muted)]">
      {/* In a narrow column the line breaks between its two halves, never
          inside one. */}
      <span className="whitespace-nowrap">
        {up ? "▲" : "▼"} {dollars}
        {pct}
      </span>
      <span className="whitespace-nowrap font-normal text-[var(--muted)]">vs {prevLabel}</span>
    </div>
  );
}

// Header delta for the pace chart: projected month-end vs last month's full
// total (the gray curve's endpoint = the max of its cumulative series). States
// the trend the chart shows visually, instead of repeating the projected dollar
// figure that already appears in the summary card. Mirrors DeltaLine's idiom
// (▲/▼ · dollars · "vs <month>") for consistency; spending less is favorable.
function PaceDelta({
  projected,
  series,
  prevMonth,
}: {
  projected: number;
  series: Dash["pace"]["series"];
  prevMonth: string;
}) {
  const lastMonthEnd = Math.max(0, ...series.map((p) => p.prev ?? 0));
  if (lastMonthEnd <= 0) return null;
  const delta = projected - lastMonthEnd;
  const label = shortMonth(prevMonth);
  if (Math.round(delta) === 0)
    return <span className="text-xs font-medium text-[var(--muted)]">On pace to match {label}</span>;
  const under = delta < 0;
  return (
    <span
      className={`flex items-center gap-1 text-xs font-medium ${
        under ? "text-[var(--good)]" : "text-[var(--bad)]"
      }`}
    >
      {/* Says which two things it compares: the dashed line's end and last
          month's total. */}
      <span className="font-normal text-[var(--muted)]">projected</span>
      <span>{under ? "▼" : "▲"}</span>
      <span className="tabular-nums">{usd(Math.abs(delta), { cents: false })}</span>
      <span className="font-normal text-[var(--muted)]">vs {label}</span>
    </span>
  );
}

// Resolve this month's uncategorized transactions inline — the common case is a
// single straggler, so making the user leave for a filtered list is overkill.
// Replaces the old "Review →" banner: lists up to CAP of them with a category
// picker each and assigns in place, then refreshes the dashboard so the count and
// totals update and the card self-dismisses at zero. The long tail keeps a
// "Review all →" out to the filtered transactions list, so the dashboard never
// balloons into a worklist. (Transaction-level, so the count reconciles exactly —
// unlike the vendor-level Suggested-categories queue on the transactions page.)
function UncategorizedResolver({
  month,
  count,
  onResolved,
}: {
  month: string;
  count: number;
  onResolved: () => void;
}) {
  const CAP = 4;
  type UncatTx = { id: number; merchant: string; displayName: string; date: string; amount: number; excluded: 0 | 1 };
  const [rows, setRows] = useState<UncatTx[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cats, setCats] = useState<Category[]>([]);
  // The Suggested-categories queue's proposals, by vendor, so a row here shows
  // what the app would file it under and one tap takes it. Without this the
  // dashboard showed the work and hid the help, which sat on Transactions.
  const [proposals, setProposals] = useState<Map<string, CategorySuggestion>>(new Map());
  // Vendors whose category waits on a merge decision: the row points at it.
  const [deferred, setDeferred] = useState<Map<string, DeferredToMerge>>(new Map());
  const askedFor = useRef("");
  const openTx = useTxDrawer();
  const [busy, setBusy] = useState<number | null>(null);
  // "always": onResolved refreshes the dashboard (count, totals) and re-syncs
  // this list either way — a failed write has to put the optimistic row back.
  const mutate = useMutation(onResolved);

  // Re-fetch when the count changes (after a resolve refreshes the dashboard) so
  // the inline list refills from the next uncategorized charges. Pulls CAP+1 to
  // know whether a "Review all" tail exists without trusting the optimistic count.
  useEffect(() => {
    let cancelled = false;
    const q = `category=none${month ? `&month=${month}` : ""}`;
    Promise.all([
      fetch(`/api/transactions?${q}&limit=${CAP + 1}`).then((r) => r.json()),
      fetch("/api/categories").then((r) => r.json()),
    ])
      .then(([tx, cs]) => {
        if (cancelled) return;
        // Drop excluded rows so the inline list reconciles with the header count
        // (needsReview counts only excluded=0 uncategorized rows).
        const all = ((tx.rows ?? []) as UncatTx[]).filter((r) => !r.excluded);
        setRows(all.slice(0, CAP));
        setHasMore(all.length > CAP);
        setCats(cs);
      })
      .catch(() => {});
    // Proposals load free (rules, history, what the model already said). Vendors
    // nobody has asked about yet are asked once per count, as the queue does,
    // and the answers read back; a failure just leaves the plain picker.
    type Suggested = { suggestions: CategorySuggestion[]; deferred: DeferredToMerge[]; needsModelCount: number; modelEnabled: boolean };
    const read = () => getJson<Suggested>("/api/category-suggestions");
    read()
      .then(async (d) => {
        if (d.needsModelCount > 0 && d.modelEnabled && askedFor.current !== String(count)) {
          askedFor.current = String(count);
          await postJson("/api/category-suggestions", { action: "suggestAI" });
          d = await read();
        }
        if (cancelled) return;
        setProposals(new Map(d.suggestions.map((x) => [x.merchant, x])));
        setDeferred(new Map((d.deferred ?? []).map((x) => [x.merchant, x])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [month, count]);

  async function assign(t: UncatTx, categoryId: number) {
    setBusy(t.id);
    setRows((prev) => prev.filter((x) => x.id !== t.id)); // optimistic
    await mutate(
      () => patchJson(`/api/transactions/${t.id}`, { categoryId }),
      {
        // The row leaving the queue is the confirmation (DESIGN.md §2, toasts).
        error: "Couldn't categorize — please try again",
      },
      { refresh: "always" }
    );
    setBusy(null);
  }

  // Taking a proposal is the queue's Apply: the vendor's rule is learned and its
  // other uncategorized charges fill with it, not only this row's.
  async function applyProposal(t: UncatTx, s: CategorySuggestion) {
    setBusy(t.id);
    setRows((prev) => prev.filter((x) => x.merchant !== t.merchant)); // optimistic
    await mutate(
      () => postJson("/api/category-suggestions", { action: "apply", merchant: s.merchant, categoryId: s.categoryId }),
      { error: "Couldn't categorize — please try again" },
      { refresh: "always" }
    );
    setBusy(null);
  }

  // The picker on a row: the proposal preselected when there is one, so the row
  // reads "Ben Franklin Plumbing → Carmel Home, Apply" instead of "Uncategorized".
  // Choosing the proposed category is taking it; any other choice files this
  // charge alone, as before.
  const picker = (t: UncatTx, s: CategorySuggestion | undefined, className?: string) => (
    <CategoryProperty
      categoryId={s?.categoryId ?? null}
      categoryName={s?.categoryName ?? null}
      categoryIcon={s?.categoryIcon ?? null}
      cats={cats}
      likely={s?.alternatives}
      onChange={(id) => id != null && (s && id === s.categoryId ? applyProposal(t, s) : assign(t, id))}
      ariaLabel={`Category for ${t.displayName}`}
      className={className}
    />
  );
  const proposalTag = (s: CategorySuggestion) =>
    s.possible || s.guess ? (
      <span data-possible={s.guess ? "guess" : "possible"} className="shrink-0 rounded-full bg-[var(--warn)]/15 px-2 py-1 text-[11px] font-medium text-[var(--warn)]">
        {s.guess ? "a guess" : "possible match"}
      </span>
    ) : null;
  // The merge card and its evidence live on Transactions; the row only points.
  const mergeLink = (d: DeferredToMerge) => (
    <Link href="/transactions" data-deferred={d.to} onClick={(e) => e.stopPropagation()} className="btn-link shrink-0 text-xs">
      possibly {d.to} →
    </Link>
  );
  const applyButton = (t: UncatTx, s: CategorySuggestion) => (
    <button
      disabled={busy === t.id}
      onClick={(e) => {
        e.stopPropagation();
        applyProposal(t, s);
      }}
      data-queue-accept
      className="btn-ghost shrink-0 text-xs disabled:opacity-50"
    >
      Apply
    </button>
  );

  return (
    // A section like any other: a small-caps title above one card of standard
    // rows (date, name, the category as the quiet property, the amount). The
    // amber box with white cards nested inside it was the one place the app
    // nested a card in a tinted card, and it out-shouted the money above.
    <section className="flex flex-col gap-2" data-uncategorized>
      <div className="flex items-center gap-2 border-x border-transparent px-4">
        <h3 className="stat-label text-[var(--warn)]">
          {count} transaction{count === 1 ? "" : "s"} need{count === 1 ? "s" : ""} a category
        </h3>
        {hasMore && (
          <Link
            href={`/transactions?category=none${month ? `&month=${month}` : ""}`}
            className="btn-link ml-auto text-[var(--warn)]"
          >
            Review all →
          </Link>
        )}
      </div>
      <ul className="card divide-y divide-[var(--border)] overflow-hidden">
        {rows.map((t) => {
          const s = proposals.get(t.merchant);
          const d = deferred.get(t.merchant);
          return (
            <li
              key={t.id}
              data-drawer-row
              data-proposed={s ? s.categoryName : undefined}
              {...rowButtonProps(() => openTx(t.merchant))}
              className={`group flex cursor-pointer items-center gap-3 px-4 py-2 text-[13px] hover:bg-[var(--hover)] ${ROW_FOCUS} ${
                busy === t.id ? "opacity-50" : ""
              }`}
            >
              <div className="w-12 shrink-0 text-xs tabular-nums text-[var(--muted)]">{shortDate(t.date)}</div>
              {/* The property sits in its own column on desktop and under the
                  name on a phone, as on Transactions, so the name keeps its room. */}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{t.displayName}</div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
                  {picker(t, s, "-ml-2")}
                  {s && proposalTag(s)}
                  {d && mergeLink(d)}
                </div>
              </div>
              <span className="hidden shrink-0 items-center justify-end gap-2 sm:flex">
                {s && proposalTag(s)}
                {d && mergeLink(d)}
                {picker(t, s)}
                {s && applyButton(t, s)}
              </span>
              {/* On a phone the verb sits under the amount, so the name's column
                  keeps the property and its tag and the row stays short. */}
              <span className="flex shrink-0 flex-col items-end gap-1">
                <AmountCell value={t.amount} excluded={!!t.excluded} className="w-24 shrink-0" />
                {s && <span className="sm:hidden">{applyButton(t, s)}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CategoryBars({
  rows,
  month,
}: {
  rows: {
    name: string;
    categoryId: number | null;
    color: string;
    icon: string;
    total: number;
    budget: number | null;
    recurringBaseline: number;
  }[];
  month: string;
}) {
  const openCategory = useCategoryShelf();
  const shelfActive = useShelfActive();
  if (rows.length === 0)
    return <p className="text-[13px] text-[var(--muted)]">No spending this month.</p>;
  const pace = paceOf(month);
  const current = isCurrentMonth(month);
  const fmt = (v: number) => usd(v, { cents: false });
  const shown = rows.slice(0, 7);
  return (
    <div className="flex flex-col gap-3">
      {shown.map((r) => {
        const over = r.budget != null && r.total > r.budget;
        const active = r.categoryId != null && shelfActive.isCategory(r.categoryId, month);
        const cls = `group block w-full cursor-pointer rounded-lg text-left transition-opacity hover:opacity-80${
          active ? " -mx-2 -my-1 bg-[var(--accent)]/10 px-2 py-1" : ""
        }`;
        const body = (
          <>
            <div className="mb-1 flex items-center justify-between text-[13px]">
              <span className="flex items-center gap-2">
                <span>{r.icon}</span>
                <span className="font-medium">{r.name}</span>
              </span>
              <span className="flex items-center gap-2">
                {/* The whole spent/budget pair right-aligns to one clean edge before
                    the chevron (matching the aligned chevron column), with the slash
                    snug between. Spent is ranked foreground; the budget reference is
                    muted — the bar below already encodes the ratio, so these are a
                    per-row readout, not a column to scan. Spent's left edge goes
                    ragged, but that's hidden in the gap after the category name. */}
                <span className="whitespace-nowrap text-right tabular-nums">
                  <span className={over ? "font-semibold text-[var(--bad)]" : "font-medium"}>
                    {fmt(r.total)}
                  </span>
                  {r.budget != null && (
                    <span className="font-normal text-[var(--muted)]"> / {fmt(r.budget)}</span>
                  )}
                </span>
                <DrillChevron className="-mr-1 h-3.5 w-3.5" />
              </span>
            </div>
            {/* Its own budget is the bar; a category without one has none. */}
            {r.budget != null && <BudgetBar spent={r.total} budget={r.budget} pace={pace} />}
            {/* What's left, said: the pair above made you subtract. The
                Categories row's words, so the two pages agree. */}
            {r.budget != null && (
              <div className={`mt-1 text-right text-xs ${over ? "font-medium text-[var(--bad)]" : "text-[var(--muted)]"}`} data-row-left>
                {over ? `${fmt(r.total - r.budget)} over` : `${fmt(r.budget - r.total)} left${current ? " so far" : ""}`}
              </div>
            )}
          </>
        );
        return r.categoryId != null ? (
          <button
            key={r.name}
            data-drawer-row
            onClick={() => openCategory(r.categoryId as number, month)}
            className={cls}
          >
            {body}
          </button>
        ) : (
          <Link key={r.name} href={`/transactions?month=${month}&category=none`} className={cls}>
            {body}
          </Link>
        );
      })}
    </div>
  );
}
