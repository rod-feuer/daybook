"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useCategoryShelf } from "@/components/TransactionDrawer";
import { rowButtonProps, ROW_FOCUS } from "@/components/rowButton";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { HeaderMenu } from "@/components/HeaderMenu";
import Shell from "@/components/Shell";
import { MonthPicker } from "@/components/Actions";
import { useToast } from "@/components/Toast";
import { useMutation } from "@/components/useMutation";
import { usd } from "@/lib/format";
import type { CategoryWithTotals } from "@/lib/queries";
import { getJson, patchJson } from "@/lib/http";
import { NewCategoryForm } from "@/components/NewCategoryForm";
import { CategoryName, EditableCategoryBadge } from "@/components/CategoryIdentity";
import { Tooltip } from "@/components/Tooltip";
import { LoadError, LoadingRows } from "@/components/LoadState";
import { SummaryCard } from "@/components/SummaryCard";
import { useMonthBoot } from "@/components/useMonthBoot";
import { usePeriodLabel } from "@/components/usePeriodLabel";
import { budgetSpent, isOverBudget } from "@/lib/budgetOutlook";
import { BudgetBar, paceOf } from "@/components/BudgetBar";

type Cat = CategoryWithTotals;


export default function CategoriesPage() {
  const { months, month, setMonth, status, setStatus, boot } = useMonthBoot();
  const period = usePeriodLabel(month); // the days the figures cover, said once
  const [cats, setCats] = useState<Cat[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  // Default to budget pressure so the categories nearest/over their budget rise
  // to the top — the thing a budget exists to surface. "spent" is the old order.
  // "Most spent" first: where the money went is the question the page answers.
  const [sort, setSort] = useState<"pressure" | "spent" | "name">("spent");
  // Attention filter, driven by clicking the summary counts: narrow the expense
  // list to the categories that need action (over budget / not yet budgeted).
  const [filter, setFilter] = useState<"over" | "unbudgeted" | null>(null);
  const toast = useToast();

  const load = useCallback(async (m: string) => {
    try {
      setCats(await getJson<Cat[]>(`/api/categories${m ? `?month=${m}` : ""}`));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [setStatus]);
  const mutate = useMutation(useCallback(() => load(month), [load, month]));
  useSyncedRefresh(() => load(month));

  // Months, then the month's categories. Also the Retry path.
  const start = useCallback(() => boot(load), [boot, load]);

  useEffect(() => {
    void start();
  }, [start]);

  function changeMonth(m: string) {
    setMonth(m);
    load(m);
  }

  // Edit a category's badge appearance (icon/color) or its kind (expense↔income).
  async function saveAppearance(
    id: number,
    patch: { icon?: string; color?: string; kind?: "expense" | "income" }
  ) {
    await mutate(
      () => patchJson(`/api/categories/${id}`, patch),
      { error: "Couldn't update category — please try again" },
      { refresh: "always" }
    );
  }

  // Rename a category. The PATCH route rejects an empty name; the inline editor
  // also guards, so this only fires for a real, changed value.
  async function saveName(id: number, newName: string) {
    const res = await fetch(`/api/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) {
      toast("Couldn't rename — please try again", "error");
      return;
    }
    load(month);
  }

  // Budget pressure: fraction of budget spent. Unbudgeted categories have no
  // pressure, so they sort below budgeted ones (and among themselves by spend).
  const pressure = (c: Cat) => (c.budget && c.budget > 0 ? budgetSpent(c) / c.budget : -1);
  const sortCats = (list: Cat[]) => {
    const arr = [...list];
    if (sort === "name") return arr.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "pressure")
      return arr.sort((a, b) => pressure(b) - pressure(a) || b.total - a.total);
    return arr.sort((a, b) => b.total - a.total); // "spent"
  };
  const excluded = sortCats(cats.filter((c) => c.excludeFromTotals));
  const expense = sortCats(
    cats.filter((c) => c.kind === "expense" && !c.excludeFromTotals)
  );
  // The attention filter only narrows expenses (where budgets live).
  const shownExpense =
    filter === "over"
      ? expense.filter(isOverBudget)
      : filter === "unbudgeted"
      ? expense.filter((c) => c.budget == null && c.name !== "Uncategorized")
      : expense;
  const income = sortCats(
    cats.filter((c) => c.kind === "income" && !c.excludeFromTotals)
  );

  return (
    <Shell
      title="Categories"
      subtitle={period}
      month={<MonthPicker months={months} value={month} onChange={changeMonth} />}
      // Behind ⋯ like the other pages' rarer actions: beside the month picker
      // on a phone, the button left the title a few pixels ("Catego").
      actions={
        <HeaderMenu>
          <button onClick={() => setShowAddForm((v) => !v)} className="btn-ghost">
            New category
          </button>
        </HeaderMenu>
      }
    >
      <BudgetSummary
        cats={cats}
        filter={filter}
        onFilter={(f) => setFilter((cur) => (cur === f ? null : f))}
      />

      {showAddForm && (
      <div className="card mb-6 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold">New category</h3>
          <button
            onClick={() => setShowAddForm(false)}
            className="rounded-lg px-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <NewCategoryForm autoFocus onCreated={() => load(month)} />
      </div>
      )}

      {status === "loading" ? (
        <LoadingRows />
      ) : status === "error" ? (
        <LoadError what="categories" onRetry={start} />
      ) : (
        <>
      <Group
        title={filter === "over" ? "Over budget" : filter === "unbudgeted" ? "Not budgeted" : "Expenses"}
        month={month}
        cats={shownExpense}
        // The sort shares the section title's line, directly above the list it
        // orders. Alone in a toolbar it held a 72px row of a phone's screen.
        aside={
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label="Sort categories"
            className="btn-ghost select-caret cursor-pointer appearance-none pr-8 text-[13px]"
          >
            <option value="spent">Most spent</option>
            <option value="pressure">Budget used</option>
            <option value="name">Name A–Z</option>
          </select>
        }
        showBudgets
        onEditAppearance={saveAppearance}
        onRename={saveName}
        onChange={() => load(month)}
      />
      {/* While an attention filter is active, hide unrelated sections to focus. */}
      {!filter && income.length > 0 && (
        <div className="mt-6">
          <Group
            title="Income"
            month={month}
            cats={income}
            onEditAppearance={saveAppearance}
            onRename={saveName}
            onChange={() => load(month)}
          />
        </div>
      )}
      {!filter && excluded.length > 0 && (
        <div className="mt-6">
          <Group
            title="Excluded from totals"
            hint="Not counted toward income or expenses — e.g. transfers, credit-card payments, reimbursements."
            month={month}
            cats={excluded}
            onEditAppearance={saveAppearance}
            onRename={saveName}
            onChange={() => load(month)}
          />
        </div>
      )}
        </>
      )}
    </Shell>
  );
}

// Top-of-page orientation: how the month's spend sits against budgets overall,
// plus the two things that need attention (categories over budget, categories
// with no budget). Scoped to budgeted expense categories so the bar compares
// like-for-like; unbudgeted spend is surfaced separately rather than distorting it.
function BudgetSummary({
  cats,
  filter,
  onFilter,
}: {
  cats: Cat[];
  filter: "over" | "unbudgeted" | null;
  onFilter: (f: "over" | "unbudgeted") => void;
}) {
  // Mid-month, "spent" and "left" are month-to-date against a whole-month
  // budget: the header's period ("Oct 1–4") says so, once, for the page.
  const expense = cats.filter((c) => c.kind === "expense" && !c.excludeFromTotals);
  if (expense.length === 0) return null;
  const budgeted = expense.filter((c) => c.budget != null);
  // "Uncategorized" is a catch-all, not a real budget line — don't count it as
  // needing a budget.
  const unbudgeted = expense.filter((c) => c.budget == null && c.name !== "Uncategorized");
  // Monthly-equivalent: an annual budget contributes amount/12, so this month's
  // spend compares like-for-like against a single combined monthly figure.
  const monthlyEquiv = (c: Cat) =>
    c.budgetPeriod === "annual" ? (c.budget ?? 0) / 12 : c.budget ?? 0;
  const budget = budgeted.reduce((s, c) => s + monthlyEquiv(c), 0);

  if (budget === 0) {
    const totalSpent = expense.reduce((s, c) => s + c.total, 0);
    return (
      <SummaryCard
        className="mb-6"
        primary={{
          value: usd(totalSpent, { cents: false }),
          label: "spent",
        }}
        progress={0}
        barLabel="No budget set"
        barTitle="Budget"
        barCaption={`0% of ${usd(0, { cents: false })}`}
        status={<span className="text-[var(--muted)]">Set a budget on a category below</span>}
      />
    );
  }

  const spent = budgeted.reduce((s, c) => s + c.total, 0);
  // Over-budget is period-aware (annual categories judged on calendar-YTD), so
  // the chip and the list filter agree.
  const overCats = budgeted.filter(isOverBudget);
  const overCount = overCats.length;
  // Name the over-budget categories when there are only a couple — far more
  // useful than a bare count; fall back to a count when there are several.
  const overLabel =
    overCount <= 2 ? `${overCats.map((c) => c.name).join(" & ")} over budget` : `${overCount} categories over budget`;
  const remaining = budget - spent;
  const over = remaining < 0;
  const pct = Math.min((spent / budget) * 100, 100);
  const hasAnnual = budgeted.some((c) => c.budgetPeriod === "annual");
  return (
    <SummaryCard
      className="mb-6"
      // The month is the header picker. The whole is the panel's caption;
      // the labels are one or two words. "Spent so far of $42,530 budgeted"
      // wrapped under its figure.
      primary={{
        value: usd(spent, { cents: false }),
        label: "spent",
      }}
      secondary={{
        value: usd(Math.abs(remaining), { cents: false }),
        label: over ? "over budget" : "left",
      }}
      progress={pct / 100}
      barLabel={`${Math.round(pct)}% of the monthly budget spent`}
      barTitle="Budget"
      barCaption={`${Math.round(pct)}% of ${usd(budget, { cents: false })}`}
      alarm={over}
      status={
        <>
          {overCount > 0 ? (
            <Tooltip label="Show the categories over budget" onlyIfTruncated={false}>
              <button
                onClick={() => onFilter("over")}
                className={`tap text-[var(--bad)] hover:underline ${filter === "over" ? "underline" : ""}`}
              >
                {overLabel}
              </button>
            </Tooltip>
          ) : (
            <span className="text-[var(--muted)]">Nothing over budget</span>
          )}
        </>
      }
      statusDetail={
        <>
          {unbudgeted.length > 0 && (
            <>
              <span className="text-[var(--muted)]">·</span>
              <Tooltip label="Show the categories with no budget, to set one" onlyIfTruncated={false}>
                <button
                  onClick={() => onFilter("unbudgeted")}
                  className={`tap text-[var(--muted)] hover:text-[var(--foreground)] hover:underline ${
                    filter === "unbudgeted" ? "text-[var(--foreground)] underline" : ""
                  }`}
                >
                  {unbudgeted.length} not budgeted
                </button>
              </Tooltip>
            </>
          )}
          {filter && (
            <button
              onClick={() => onFilter(filter)}
              className="ml-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              ✕ clear
            </button>
          )}
        </>
      }
      // Why this budget isn't the sum of the ones you typed. That an annual
      // category tracks its year is said on its own row, below.
      note={hasAnnual ? "Annual budgets count here at 1⁄12 per month." : undefined}
    />
  );
}

function Group({
  title,
  hint,
  aside,
  month,
  cats,
  showBudgets = false,
  onEditAppearance,
  onRename,
  onChange,
}: {
  title: string;
  hint?: string;
  aside?: ReactNode; // a control on the title's line (the sort)
  month: string;
  cats: Cat[];
  showBudgets?: boolean; // expense lists show budgets; income has none
  onEditAppearance?: (
    id: number,
    patch: { icon?: string; color?: string; kind?: "expense" | "income" }
  ) => void;
  onRename?: (id: number, name: string) => void;
  // Reload the list when a transaction is edited inside the category shelf, so
  // totals/budgets update in place instead of needing a manual refresh.
  onChange?: () => void;
}) {
  const openCategory = useCategoryShelf();
  return (
    <div>
      <div className={`flex items-center justify-between gap-2 ${hint ? "mb-1" : "mb-2"}`}>
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--foreground)]">{title}</h3>
        {aside}
      </div>
      {hint && <p className="mb-2 px-1 text-xs text-[var(--muted)]">{hint}</p>}
      <div className="card divide-y divide-[var(--border)]">
        {cats.length === 0 && (
          <p className="p-4 text-[13px] text-[var(--muted)]">No categories.</p>
        )}
        {cats.map((c) => {
          const budgeted = showBudgets && c.budget != null;
          const budget = c.budget ?? 0;
          const annual = c.budgetPeriod === "annual";
          // An annual budget tracks calendar-YTD spend; a monthly one tracks the
          // viewed month. The recurring baseline is monthly, so annualize it to
          // compare against an annual budget.
          const spentNow = annual ? c.ytdSpent : c.total;
          const recur = annual ? c.recurringBaseline * 12 : c.recurringBaseline;
          // The row's one colour signal. Over budget, the bar's overage and
          // the verdict line are red; nothing else on the row takes a colour.
          // Pace is the bar's marker, not a colour: a flat "90% spent" amber
          // fired late in every month, when 90% is on pace.
          const over = budgeted && spentNow > budget;
          const remaining = budget - spentNow;
          return (
            <div
              key={c.id}
              data-drawer-row
              {...rowButtonProps(() => openCategory(c.id, month, { onChange }))}
              className={`group flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-[var(--hover)] ${ROW_FOCUS}`}
            >
              <EditableCategoryBadge
                icon={c.icon}
                color={c.color}
                kind={c.kind}
                // Uncategorized is a fixed catch-all — its kind isn't a meaningful
                // correction, so don't offer the toggle for it.
                canEditKind={c.name !== "Uncategorized"}
                onSave={onEditAppearance ? (patch) => onEditAppearance(c.id, patch) : undefined}
              />
              <div className="min-w-0 flex-1">
                {/* When the figures wrap under the name (a phone, an unbudgeted
                    row with its "Use $X" chip), the two lines sit 12px apart:
                    the name's pencil and the "/mo" toggle are both touch
                    targets, and at 4px the lower one's hit area took the
                    upper one's. */}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-3 sm:flex-nowrap">
                  <CategoryName
                    name={c.name}
                    onRename={
                      onRename && c.name !== "Uncategorized"
                        ? (n) => onRename(c.id, n)
                        : undefined
                    }
                  />
                  {/* On mobile the spent+budget cluster drops to its own line
                      (flex-wrap above) rather than wrapping mid-number; each
                      monetary value stays nowrap so figures never split. */}
                  <span className="flex shrink-0 items-baseline gap-1 whitespace-nowrap text-[13px]">
                    <span
                      className={`font-semibold tabular-nums ${
                        c.excludeFromTotals ? "text-[var(--muted)] line-through" : ""
                      }`}
                    >
                      {usd(spentNow, { cents: false })}
                    </span>
                    {/* Annual budgets read year-to-date, not the viewed month —
                        mark the figure so it isn't mistaken for monthly spend. */}
                    {budgeted && annual && (
                      <span className="text-[11px] font-medium uppercase text-[var(--muted)]">
                        ytd
                      </span>
                    )}
                    {/* Shown, not edited: the budget is set in the shelf the row opens. */}
                    {budgeted && (
                      <span className="text-[var(--muted)]" data-row-budget>
                        of <span className="font-medium tabular-nums text-[var(--foreground)]">{usd(budget, { cents: false })}</span>
                        {annual ? "/yr" : "/mo"}
                      </span>
                    )}
                  </span>
                </div>

                {budgeted && (
                  <div className="mt-2">
                    <BudgetBar spent={spentNow} budget={budget} pace={paceOf(month, annual ? "annual" : "monthly")} period={annual ? "annual" : "monthly"} />
                  </div>
                )}

                {/* Count left, money right. The verbs (exclude from totals,
                    delete) live in the category shelf, which the row opens —
                    a destructive verb on every row was the one place the app
                    still put a verb outside the shelf, and on a phone the two
                    links wrapped the row into a three-line stack. */}
                <div className="mt-1 flex items-start justify-between gap-2 text-xs text-[var(--muted)]">
                  <span className="shrink-0">
                    {c.txCount} transaction{c.txCount === 1 ? "" : "s"}
                  </span>
                  {budgeted ? (
                    <span
                      className={`text-right font-medium ${
                        over ? "text-[var(--bad)]" : "text-[var(--foreground)]"
                      }`}
                    >
                      {/* Two units — "$1,344 left" and "· $6,683 recurring" —
                          so a narrow row breaks between them, never inside one. */}
                      <span className="whitespace-nowrap">
                        {remaining >= 0
                          ? `${usd(remaining, { cents: false })} left`
                          : `${usd(-remaining, { cents: false })} over`}
                        {annual ? " this year" : ""}
                      </span>
                      {recur > 0 && (
                        <Tooltip
                          label={
                            recur > budget
                              ? "Budget is below this category's known recurring cost"
                              : "Recurring cost in this category"
                          }
                          onlyIfTruncated={false}
                        >
                          {/* One unit, so a narrow row wraps "· $6,683 recurring" whole
                              instead of orphaning "recurring". */}
                          <span
                            className={`whitespace-nowrap font-normal ${
                              recur > budget ? "text-[var(--warn)]" : "text-[var(--muted)]"
                            }`}
                          >
                            {" · "}
                            {usd(recur, { cents: false })} recurring{annual ? "/yr" : ""}
                          </span>
                        </Tooltip>
                      )}
                    </span>
                  ) : showBudgets && c.recurringBaseline > 0 ? (
                    <span>
                      {usd(c.recurringBaseline, { cents: false })} recurring · set a budget
                    </span>
                  ) : null}
                </div>
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}

