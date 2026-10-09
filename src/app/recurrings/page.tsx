"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Shell, { Toolbar } from "@/components/Shell";
import { useNewCategory } from "@/components/NewCategoryOption";
import { AmountCell, CategoryProperty } from "@/components/RowCells";
import { withoutAmountQualifier, isSeriesKey, seriesVendor } from "@/lib/series";
import { CategoryBadge } from "@/components/CategoryBadge";
import { rowButtonProps, ROW_FOCUS } from "@/components/rowButton";
import { MonthPicker } from "@/components/Actions";
import { useMutation } from "@/components/useMutation";
import { useTxDrawer, useShelfActive } from "@/components/TransactionDrawer";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { InfoHint } from "@/components/InfoHint";
import { Tooltip } from "@/components/Tooltip";
import { SearchBox } from "@/components/SearchBox";
import { getJson, postJson } from "@/lib/http";
import { CADENCE_DAYS, CADENCE_LABEL } from "@/lib/cadence";
import { LoadError, LoadingRows } from "@/components/LoadState";
import { SummaryCard } from "@/components/SummaryCard";
import { useMonthBoot } from "@/components/useMonthBoot";
import { usePeriodLabel } from "@/components/usePeriodLabel";
import { billStatus, billDelta, chargedOften } from "@/lib/bills";
import { usd, shortDate, isCurrentMonth as isCurrentMonthOf, localToday } from "@/lib/format";
import type { RecurringForMonth, RecurringSuggestion } from "@/lib/queries";
import type { Category } from "@/lib/types";

// Shapes come from the library that produces them; the aliases keep the file's
// existing names.
type Rec = RecurringForMonth;
type Cat = Category;
type Suggestion = RecurringSuggestion;

// Active = charged within ~1.5 cycles (plus grace); else treated as stopped. A
// user-ended (canceled) subscription is inactive immediately, regardless of how
// recently it last charged.
function isActive(r: Rec): boolean {
  if (r.ended) return false;
  const days = (Date.now() - new Date(r.lastDate + "T00:00:00Z").getTime()) / 86_400_000;
  return days <= CADENCE_DAYS[r.cadence] * 1.5 + 5;
}

export default function RecurringsPage() {
  const { months, month, setMonth, status, setStatus, boot } = useMonthBoot();
  const period = usePeriodLabel(month); // the days the figures cover, said once
  const [recs, setRecs] = useState<Rec[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState(""); // "" = all, "none" = uncategorized, else id
  const openTx = useTxDrawer();
  const shelfActive = useShelfActive();

  const load = useCallback(async (m: string) => {
    try {
      setRecs(await getJson<Rec[]>(`/api/recurrings?month=${m}`));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [setStatus]);

  const mutate = useMutation(useCallback(() => load(month), [load, month]));

  const loadSuggestions = useCallback(async () => {
    try {
      setSuggestions(await getJson<Suggestion[]>("/api/recurrings/suggested"));
    } catch {
      // Suggestions are an aside; a failed read leaves the last list in place.
    }
  }, []);
  useSyncedRefresh(() => {
    load(month);
    loadSuggestions();
  });

  // Months, then the month's bills. Also the Retry path.
  const start = useCallback(() => boot(load), [boot, load]);

  useEffect(() => {
    // Category and vendor pickers are secondary: a failed read leaves them
    // empty rather than failing the page.
    getJson<Cat[]>("/api/categories").then(setCats).catch(() => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSuggestions();
    void start();
  }, [start, loadSuggestions]);


  // Add a suggested recurring. One the detector found is confirmed as it is;
  // one it couldn't claim folds in any clustered aliases (so the vendor's
  // descriptor variants become one recurring), then is forced.
  async function addSuggestion(s: Suggestion) {
    setSuggestions((arr) => arr.filter((x) => x.merchant !== s.merchant));
    const write = async () => {
      if (s.reason === "detected") return postJson("/api/recurrings/confirm", { key: s.merchant });
      for (const alias of s.aliases)
        await postJson("/api/recurrings/link", { alias, primary: s.merchant });
      await postJson("/api/recurrings/override", { merchant: s.merchant, status: "force" });
    };
    if (
      !(await mutate(write, {
        error: "Couldn't update — please try again",
      }))
    )
      loadSuggestions(); // restore the optimistic removal
  }

  // Dismiss a suggestion: mute every descriptor so the whole cluster stays gone.
  async function dismissSuggestion(s: Suggestion) {
    setSuggestions((arr) => arr.filter((x) => x.merchant !== s.merchant));
    const write = async () => {
      for (const m of [s.merchant, ...s.aliases])
        await postJson("/api/recurrings/override", { merchant: m, status: "mute" });
    };
    if (
      !(await mutate(
        write,
        { error: "Couldn't dismiss — please try again" },
        { refresh: "never" }
      ))
    )
      loadSuggestions();
  }

  function changeMonth(m: string) {
    setMonth(m);
    load(m);
  }

  // A category created from a row's dropdown: add it to the pickers, then
  // apply it to that row (which reloads the month).
  async function addCategoryFromRow(cat: Cat, r: Rec) {
    setCats((cs) => [...cs, cat]);
    await recategorize(r, cat.id);
  }

  async function recategorize(r: Rec, categoryId: number | null) {
    const merchant = r.vendor;
    // Always the plan's own id. The server moves the whole vendor only when
    // its charges already share a category; otherwise this stays on the plan.
    const recurringId = r.id;
    await mutate(
      () => postJson("/api/recurrings/recategorize", { merchant, categoryId, recurringId }),
      { error: "Couldn't recategorize — please try again" }
    );
  }

  const isCurrentMonth = isCurrentMonthOf(month);
  const byDue = (a: Rec, b: Rec) => a.dueDate.localeCompare(b.dueDate);

  // Upcoming only applies to the live month (a past month is already settled).
  const upcoming = (r: Rec) => !r.paid && r.expectedThisMonth && isActive(r);

  // A plan in a category that is not counted (Transfers: a card autopay, or
  // the card's "thank you" for it) is neither a bill nor income; it is named
  // at the foot so it does not vanish.
  const notCounted = recs.filter((r) => r.categoryExcluded && !r.ended);
  const counted = recs.filter((r) => !r.categoryExcluded);
  const expenses = counted.filter((r) => r.avgAmount < 0);
  const bills = [
    ...expenses.filter((r) => r.paid),
    ...(isCurrentMonth ? expenses.filter(upcoming) : []),
  ].sort(byDue);

  const income = counted.filter((r) => r.avgAmount >= 0);
  const incomeBills = [
    ...income.filter((r) => r.paid),
    ...(isCurrentMonth ? income.filter(upcoming) : []),
  ].sort(byDue);

  const paidSoFar = bills.filter((r) => r.paid).reduce((a, r) => a + (r.paidAmount ?? 0), 0);
  // What is still to come: an unpaid bill's charge, and a plan charged every
  // week or two its charges from the next due date to the month's end, paid
  // this month or not (Precision Cutz on the 29th, after four already paid).
  const leftToPay = bills.reduce(
    (a, r) => a + r.expectedAmount * (r.paid ? r.chargesStillDue : Math.max(1, r.chargesStillDue)),
    0
  );
  const totalBills = paidSoFar + leftToPay;
  // The status line under the summary bar: overdue in red when there are any.
  const todayIso = localToday();
  const overdueCount = bills.filter((r) => billStatus(r, todayIso) === "od").length;
  const upcomingCount = bills.filter((r) => billStatus(r, todayIso) === "up").length;
  const paidCount = bills.filter((r) => r.paid).length;

  // Stale recurrings that didn't charge this month — tucked away.
  const inactive = recs
    .filter((r) => !isActive(r) && !r.paid)
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate));

  // The search box and the category picker both filter the displayed lists (not
  // the summary). Suggestions carry a category by name (no id), so match those by
  // the selected category's name.
  const ql = q.trim().toLowerCase();
  const catName =
    catFilter && catFilter !== "none"
      ? cats.find((c) => String(c.id) === catFilter)?.name ?? null
      : null;
  const matchText = (text: string) => !ql || text.toLowerCase().includes(ql);
  // Search the shown name AND the bank's descriptor, so "zelle" still finds a
  // payee whose display name has the rail stripped.
  const matchRec = (r: Rec) =>
    matchText(`${r.displayName ?? r.merchant} ${r.merchant} ${r.categoryName ?? ""}`) &&
    (!catFilter ||
      (catFilter === "none" ? r.categoryId == null : String(r.categoryId) === catFilter));
  const matchSug = (s: Suggestion) =>
    matchText(`${s.displayName} ${s.merchant} ${s.category?.name ?? ""}`) &&
    (!catFilter || (catFilter === "none" ? !s.category : s.category?.name === catName));
  const shownBills = bills.filter(matchRec);
  const shownIncome = incomeBills.filter(matchRec);
  const shownInactive = inactive.filter(matchRec);
  const shownSuggestions = suggestions.filter(matchSug);
  const filtering = ql.length > 0 || catFilter !== "";
  const noMatches =
    filtering &&
    shownBills.length + shownIncome.length + shownInactive.length + shownSuggestions.length === 0;

  return (
    <Shell
      title="Recurrings"
      subtitle={period}
      month={<MonthPicker months={months} value={month} onChange={changeMonth} />}
    >
      {status === "loading" ? (
        <LoadingRows />
      ) : status === "error" ? (
        <LoadError what="recurring bills" onRetry={start} />
      ) : recs.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="mb-2 text-2xl">↻</div>
          <p className="text-[13px] text-[var(--muted)]">
            No recurring patterns detected yet. Recurrings are found automatically
            from 3+ regular, similar-amount charges — load data or re-scan.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {totalBills > 0 && (
            <SummaryCard
              // The month is the header picker. The whole is the panel's caption;
              // the labels are short. "Paid so far of $19,708 expected" wrapped under its figure.
              primary={{
                value: usd(paidSoFar, { cents: false }),
                label: "paid",
              }}
              secondary={{
                value: usd(leftToPay, { cents: false }),
                // A closed month's unmatched bills weren't "left to pay"; they went unpaid.
                label: <span className="whitespace-nowrap">{isCurrentMonth ? "Left to pay" : "Unpaid"}</span>,
              }}
              progress={paidSoFar / totalBills}
              barLabel={`${Math.round((paidSoFar / totalBills) * 100)}% of expected bills paid`}
              barTitle="Bills"
              // "Expected" is the word that needs teaching; the hint sits on it.
              barCaption={`${Math.round((paidSoFar / totalBills) * 100)}% of ${usd(totalBills, { cents: false })} expected`}
              note="Expected amounts are each bill's latest charge. Change one, or its cadence, in the shelf."
              status={
                <>
                  {overdueCount > 0 ? (
                    <SectionLink section="od" className="text-[var(--warn)]">
                      {overdueCount} {isCurrentMonth ? "overdue" : "unpaid"}
                    </SectionLink>
                  ) : (
                    <span className="text-[var(--muted)]">{isCurrentMonth ? "Nothing overdue" : "Nothing unpaid"}</span>
                  )}
                </>
              }
              statusDetail={
                <>
                  {isCurrentMonth && (
                    <>
                      <span className="text-[var(--muted)]">·</span>
                      <SectionLink section="up">{upcomingCount} upcoming</SectionLink>
                    </>
                  )}
                  <span className="text-[var(--muted)]">·</span>
                  <SectionLink section="pd">{paidCount} paid</SectionLink>
                </>
              }
            />
          )}

          <Toolbar>
          <SearchBox value={q} onChange={setQ} placeholder="Search…" className="min-w-0 flex-1 sm:w-48 sm:flex-none" />
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            aria-label="Filter by category"
            className={`btn-ghost select-caret max-w-44 cursor-pointer appearance-none pr-8 ${
              catFilter ? "text-[var(--foreground)]" : "text-[var(--muted)]"
            }`}
          >
            <option value="">All categories</option>
            <option value="none">Uncategorized</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
          </Toolbar>

          <BillList
            title=""
            recs={shownBills}
            cats={cats}
            onRecategorize={recategorize}
            onNewCategory={addCategoryFromRow}
            onOpen={(m, series) => openTx(m, { onChange: () => load(month), series })}
            pastMonth={!isCurrentMonth}
          />
          <BillList
            title="Recurring income"
            recs={shownIncome}
            cats={cats}
            onRecategorize={recategorize}
            onNewCategory={addCategoryFromRow}
            onOpen={(m, series) => openTx(m, { onChange: () => load(month), series })}
          />

          {!filtering && bills.length === 0 && incomeBills.length === 0 && (
            <p className="card p-6 text-center text-[13px] text-[var(--muted)]">
              No recurring bills this month.
            </p>
          )}

          {noMatches && (
            <p className="card p-6 text-center text-[13px] text-[var(--muted)]">
              No recurrings match {ql ? `“${q}”` : "this filter"}.
            </p>
          )}

          {!filtering && notCounted.length > 0 && (
            <p className="px-1 text-xs text-[var(--muted)]" data-not-counted>
              Not counted: {notCounted.map((r) => `${withoutAmountQualifier(r.displayName)} (${r.categoryName})`).join(" · ")}. A plan in a
              category that isn&rsquo;t counted is neither a bill nor income.
            </p>
          )}

          {shownSuggestions.length > 0 && (
            <div>
              <button
                onClick={() => setShowSuggestions((s) => !s)}
                className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--accent)] hover:opacity-80"
              >
                {showSuggestions ? "▾" : "▸"} Suggested ({shownSuggestions.length})
              </button>
              {showSuggestions && (
                <div className="card divide-y divide-[var(--border)] overflow-hidden">
                  {shownSuggestions.map((s) => {
                    return (
                      <div key={s.merchant}>
                      <div
                        data-drawer-row
                        {...rowButtonProps(() =>
                          // A detected plan split off a vendor opens that plan's shelf.
                          openTx(isSeriesKey(s.merchant) ? seriesVendor(s.merchant) : s.merchant, {
                            onChange: loadSuggestions,
                            amountHint: Math.abs(s.avgAmount),
                            series: isSeriesKey(s.merchant) ? s.merchant : undefined,
                          })
                        )}
                        className={`group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors ${ROW_FOCUS} ${
                          shelfActive.isMerchant(s.merchant)
                            ? "bg-[var(--accent)]/10"
                            : "hover:bg-[var(--hover)]"
                        }`}
                      >
                        <CategoryBadge icon={s.category?.icon} color={s.category?.color} fallback={s.displayName} size="xs" plain />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium">{s.displayName}</div>
                          <div className="text-xs text-[var(--muted)]">
                            {s.reason === "detected"
                              ? `found in your charges · ${s.cadence ?? ""}`
                              : s.reason === "variable"
                              ? `regular ${s.cadence ?? ""} bill · variable amount`
                              : `looks like a subscription · ${s.count} charge${
                                  s.count === 1 ? "" : "s"
                                } so far`}
                            {s.aliases.length > 0
                              ? ` · ${s.aliases.length + 1} names`
                              : ""}
                          </div>
                        </div>
                        <div className="w-20 text-right text-[13px] font-semibold tabular-nums text-[var(--muted)]">
                          {usd(Math.abs(s.avgAmount))}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            addSuggestion(s);
                          }}
                          className="tap shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium hover:bg-[var(--hover)]"
                        >
                          Add
                        </button>
                        <Tooltip label="Dismiss" onlyIfTruncated={false} className="shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              dismissSuggestion(s);
                            }}
                            className="tap rounded-lg px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--bad)]"
                          >
                            ✕
                          </button>
                        </Tooltip>
                      </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {shownInactive.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <button
                  onClick={() => setShowInactive((s) => !s)}
                  className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  {showInactive ? "▾" : "▸"} Inactive ({shownInactive.length})
                </button>
                <InfoHint text="Recurrings that haven't charged within ~1.5 cycles — including subscriptions you marked ended. They no longer count as upcoming or toward expected spend, but their history is kept." />
              </div>
              {(showInactive || filtering) && (
                <BillList
                  title=""
                  recs={shownInactive}
                  dim
                  onOpen={(m, series) => openTx(m, { onChange: () => load(month), series })}
                />
              )}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

// A count in the summary's status line that jumps to its section below —
// the same job the Categories status line does with its filters.
function SectionLink({
  section,
  className = "text-[var(--muted)] hover:text-[var(--foreground)]",
  children,
}: {
  section: "od" | "up" | "pd";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-section-link={section}
      onClick={() =>
        document
          .querySelector(`[data-bill-anchor="${section}"], [data-bill-status="${section}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
      className={`tap hover:underline ${className}`}
    >
      {children}
    </button>
  );
}

function BillList({
  title,
  recs,
  dim,
  cats,
  onRecategorize,
  onNewCategory,
  onOpen,
  pastMonth = false,
}: {
  title: string;
  recs: Rec[];
  dim?: boolean;
  cats?: Cat[];
  onRecategorize?: (r: Rec, categoryId: number | null) => void;
  onNewCategory?: (cat: Cat, r: Rec) => void; // created from the row's dropdown → apply to the row
  onOpen?: (merchant: string, series?: string) => void; // series: the plan's key when the vendor carries several
  pastMonth?: boolean; // a closed month: unmatched bills are "Unpaid", not "Overdue"
}) {
  const shelfActive = useShelfActive();
  // "+ New category…" chosen in a row's dropdown: the create form opens under
  // that dropdown and the new category is applied to that row on Add.
  const newCat = useNewCategory<Rec>((cat, rec) => onNewCategory?.(cat, rec));
  if (recs.length === 0) return null;
  const editable = !!(cats && onRecategorize);

  // One list in date order — the month as it happens — instead of three cards
  // (Overdue / Upcoming / Paid) that put a Sep 26 bill above a Sep 3 one. The
  // amount cell already carries the state (settled, provisional, overdue) and
  // the summary card the counts, so grouping said nothing the row didn't. A
  // "Today" divider splits what has happened from what is ahead; an unpaid
  // bill above it is overdue and wears amber. A past month has no today.
  const today = localToday();
  const status = (r: Rec) => billStatus(r, today);
  const dividerAt = dim || pastMonth ? -1 : recs.findIndex((r) => r.dueDate >= today);
  const showDivider = dividerAt > 0; // something behind it and something ahead
  return (
    <div className="flex flex-col gap-4">
      {title && (
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          {title}
        </h3>
      )}
      <div className="card divide-y divide-[var(--border)] overflow-hidden" data-bill-list>
        {recs.map((r, i) => {
          const st = status(r);
          const amount = r.paid ? r.paidAmount ?? 0 : r.expectedAmount;
          // The amount column already says "$200"; a series keyed by amount
          // needn't repeat it in its name. A user-set name is shown as typed.
          const rowName = r.settings?.alias ? r.displayName : withoutAmountQualifier(r.displayName);
          return (
            <div key={r.id}>
            {i === dividerAt && showDivider && (
              <div
                data-bill-anchor="up"
                className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--hover)]/60 px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]"
              >
                <span className="w-12 shrink-0">Today</span>
                <span className="tabular-nums">{shortDate(today)}</span>
              </div>
            )}
            <div
              data-drawer-row
              data-bill-status={st}
              data-due={r.dueDate}
              {...(onOpen ? rowButtonProps(() => onOpen(r.vendor, isSeriesKey(r.merchant) ? r.merchant : undefined)) : {})}
              className={`group flex items-center gap-3 px-4 py-3 text-[13px] sm:py-2 ${ROW_FOCUS} ${
                dim ? "opacity-60" : ""
              } ${
                onOpen
                  ? shelfActive.isMerchant(r.vendor, isSeriesKey(r.merchant) ? r.merchant : undefined)
                    ? "cursor-pointer bg-[var(--accent)]/10"
                    : "cursor-pointer hover:bg-[var(--hover)]"
                  : ""
              }`}
            >
              {/* Date and cadence as two fixed columns with tabular figures, so
                  every row's cadence starts on the same x. The date carries the
                  status colour: amber when overdue. */}
              <div
                className={`w-12 shrink-0 text-xs tabular-nums ${
                  st === "od" ? "font-medium text-[var(--warn)]" : "text-[var(--muted)]"
                }`}
              >
                {dim ? shortDate(r.lastDate) : shortDate(r.dueDate)}
              </div>
              {/* The name has the row: a tag that doesn't fit beside it wraps to
                  a meta line below rather than truncating the name (a phone
                  gives the name ~130px; "Chase Mortgage (L…" told you less
                  than "Quarterly" did). */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
                {/* Renamed on the shelf the row opens: one place to name a vendor. */}
                <span className="truncate font-medium">{rowName}</span>
                {/* Cadence only when it isn't monthly, as a quiet tag after the
                    name: the exception is the information, and a column for it
                    sat empty on nearly every row. The shelf states it in full. */}
                {r.cadence !== "monthly" && (
                  <span
                    data-cadence
                    className="shrink-0 rounded-full bg-[var(--border)] px-2 text-[11px] font-medium text-[var(--muted)]"
                  >
                    {CADENCE_LABEL[r.cadence]}
                  </span>
                )}
                {r.ended && (
                  <Tooltip
                    label="You marked this subscription ended — it no longer counts as upcoming or expected"
                    onlyIfTruncated={false}
                    className="inline-flex shrink-0 rounded-full bg-[var(--warn)]/15 px-2 py-1 text-[11px] font-medium text-[var(--warn)]"
                  >
                    Ended{r.endedDate ? ` ${shortDate(r.endedDate)}` : ""}
                  </Tooltip>
                )}
              </div>
              {/* The category as a quiet property (a shared cell). It needs
                  ~176px, which fits once the content column is a tablet width;
                  on a phone the shelf carries it. */}
              <div className="hidden w-44 shrink-0 justify-end md:flex">
                {editable && cats && onRecategorize ? (
                  <CategoryProperty
                    categoryId={r.categoryId}
                    categoryName={r.categoryName}
                    categoryIcon={r.categoryIcon}
                    cats={cats}
                    onChange={(id) => onRecategorize(r, id)}
                    onNewCategory={(anchor) => newCat.open(anchor, r, `New category for ${r.displayName}`)}
                  />
                ) : (
                  r.categoryName && (
                    <span className="truncate text-xs text-[var(--muted)]">
                      {r.categoryIcon} {r.categoryName}
                    </span>
                  )
                )}
              </div>
              {/* The only visible control: the row's ⋯ (the row itself opens the
                  shelf, which is where editing lives). */}
              {/* No row menu. Mark ended / Reactivate / Not recurring are rare
                  verbs and live in the shelf — the control surface — which the
                  row opens on click, tap, or Enter. */}
              {(() => {
                const state = r.paid ? "settled" : st === "od" ? "overdue" : "provisional";
                const delta = billDelta(r);
                // A plan charged every week or two shows the month's sum; the
                // note says what it is made of, so $739.30 doesn't read as a
                // $369.65 bill doubled.
                const note =
                  r.paid && chargedOften(r) && r.paidTimes >= 2
                    ? `${r.paidTimes} × ${usd(r.expectedAmount)}`
                    : null;
                return (
                  <AmountCell
                    value={amount}
                    unsigned
                    state={state}
                    delta={delta}
                    note={note}
                    className="w-24 shrink-0 sm:w-32"
                  />
                );
              })()}
            </div>
            </div>
          );
        })}
      </div>
      {newCat.popover}
    </div>
  );
}

// Inline editor for a recurring's overrides: display name (alias), go-forward
// expected amount, cadence, next-due, and the match rule. Empty / "Auto" means
// "no override — use the detected value". Save sends a full patch so cleared
// fields revert. Reset removes all overrides.
