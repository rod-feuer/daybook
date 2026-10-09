"use client";

import {
  Fragment,
  Suspense,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import Shell, { Toolbar } from "@/components/Shell";
import { usePeriodLabel } from "@/components/usePeriodLabel";
import { RecurringGlyph, RECURRING_LABEL, recurringState } from "@/components/RecurringGlyph";
import { CategoryBadge } from "@/components/CategoryBadge";
import { AmountCell, CategoryProperty } from "@/components/RowCells";
import { rowButtonProps, ROW_FOCUS } from "@/components/rowButton";
import { LoadError, LoadingRows } from "@/components/LoadState";
import { MonthPicker, ImportButton } from "@/components/Actions";
import { HeaderMenu } from "@/components/HeaderMenu";
import { useToast } from "@/components/Toast";
import { useMutation } from "@/components/useMutation";
import { useChargeShelf, useShelfActive } from "@/components/TransactionDrawer";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { PlanMatchQueue } from "@/components/PlanMatchQueue";
import { MergeQueue } from "@/components/MergeQueue";
import { NameCleanupQueue } from "@/components/NameCleanupQueue";
import { CategorizeQueue } from "@/components/CategorizeQueue";
import { SearchBox } from "@/components/SearchBox";
import { Tooltip } from "@/components/Tooltip";
import { getJson, patchJson } from "@/lib/http";
import { usd, longDate, shortDate, defaultMonth, pendingNote } from "@/lib/format";
import type { TransactionRow } from "@/lib/queries";
import type { Category } from "@/lib/types";
import { createLatestGuard } from "@/lib/latestGuard";

type Tx = TransactionRow;
type Cat = Category;

type Filters = {
  month: string;
  cat: string;
  q: string;
  vendor: string;
  type: string;
  account: string;
  minAmount: string;
  maxAmount: string;
  recurring: string;
  sort: string;
  dir: string;
};

// Render the list in pages of this many rows, appending more as the user scrolls
// (or via "Show more"). Caps the initial React mount regardless of match count —
// a single month or a 10k-row all-history search both mount one page first.
const PAGE = 60;

// useSearchParams needs a Suspense boundary above it for a prerendered route
// (see node_modules/next/dist/docs/.../use-search-params.md).
export default function TransactionsPage() {
  return (
    <Suspense fallback={null}>
      <TransactionsView />
    </Suspense>
  );
}

function TransactionsView() {
  const [months, setMonths] = useState<string[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  // txs accumulates the pages fetched so far (server-side pagination). count/net
  // describe the FULL filtered set (the header figures), since the list is paged.
  const [txs, setTxs] = useState<Tx[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [netTotal, setNetTotal] = useState(0);
  // The vendor statement's heading. A charge's own name can be its plan
  // ("Benjamin Franklin (Carmel)"); the statement is every charge of the vendor.
  const [vendorName, setVendorName] = useState<string | null>(null);
  // Whether every charge of the vendor has one category (from the server,
  // across every page). When they don't, the heading names none and each row
  // shows its own.
  const [categoryShared, setCategoryShared] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false); // synchronous guard against double-fetch
  // Review-queue widgets are deferred to after first paint so their fetches
  // (esp. the ~155ms merge scan) don't compete with the list on load.
  const [showQueues, setShowQueues] = useState(false);
  // Which row's category <select> has its full option list mounted. At rest a
  // row renders only its current value (1 option), not all ~27 categories — so a
  // long month builds ~1 option/row instead of ~28, the page's main render cost.
  const [activeCatSelect, setActiveCatSelect] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [month, setMonth] = useState("");
  const period = usePeriodLabel(month); // "Oct 1–4"; none for All months
  const [catFilter, setCatFilter] = useState("");
  const [q, setQ] = useState("");
  // Search is otherwise scoped to the selected month, so a typed query would
  // silently miss anything outside it. When a search begins we widen to all
  // months (stashing where we were); clearing the search snaps back — unless
  // the user manually narrowed to a month mid-search, which we respect.
  const monthBeforeSearch = useRef<string | null>(null);
  function search(value: string) {
    const had = q.length > 0;
    const has = value.length > 0;
    if (!had && has) {
      monthBeforeSearch.current = month;
      setMonth("");
    } else if (had && !has) {
      if (month === "" && monthBeforeSearch.current) setMonth(monthBeforeSearch.current);
      monthBeforeSearch.current = null;
    }
    setQ(value);
  }
  const [vendor, setVendor] = useState(""); // deep-link only (from the drawer)
  const [type, setType] = useState("");
  const [account, setAccount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [recurring, setRecurring] = useState(""); // "", "yes", "no"
  const [sort, setSort] = useState("date");
  const [dir, setDir] = useState("desc");
  const [added, setAdded] = useState<string[]>([]); // filters explicitly added but maybe not yet valued
  const [menuOpen, setMenuOpen] = useState(false);
  // Gate the URL←→filter sync until the initial deep-link has been read, so the
  // sync never wipes the incoming params before loadStatic applies them.
  const [ready, setReady] = useState(false);
  // First-page read state. Loading only replaces the list while it is empty
  // (a filter change keeps the old rows until the new ones land); "error" is
  // set once the retries are exhausted, so a dead API never reads as
  // "No transactions match."
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const toast = useToast();
  const mutate = useMutation(useCallback(() => setRefreshKey((k) => k + 1), []));
  const openCharge = useChargeShelf();
  const shelfActive = useShelfActive();
  useSyncedRefresh(() => setRefreshKey((k) => k + 1));

  const loadStatic = useCallback(async () => {
    const [ms, cs, accts] = await Promise.all([
      fetch("/api/months").then((r) => r.json()),
      fetch("/api/categories").then((r) => r.json()),
      fetch("/api/accounts").then((r) => r.json()),
    ]);
    setMonths(ms);
    setCats(cs);
    setAccounts(accts);
    // Honor deep-links from the dashboard, e.g. /transactions?month=2026-05&category=35
    // or ?type=expense or ?q=Chubb. Each present param pre-applies its filter.
    const params = new URLSearchParams(window.location.search);
    // A vendor deep-link (from the drawer's "View all transactions") or a search
    // deep-link spans history, so default to all months unless a month was given.
    const wide = !!params.get("vendor") || !!params.get("q");
    setMonth(
      (cur) => cur || params.get("month") || (wide ? "" : defaultMonth(ms))
    );
    const apply = (key: string, setter: (v: string) => void) => {
      const v = params.get(key);
      if (v) setter(v);
    };
    apply("category", setCatFilter);
    apply("type", setType);
    apply("account", setAccount);
    apply("q", setQ);
    apply("vendor", setVendor);
    apply("recurring", setRecurring);
    apply("minAmount", setMinAmount);
    apply("maxAmount", setMaxAmount);
    setReady(true);
  }, []);

  // A vendor deep-link that lands on THIS page — the shelf's "View all 17 transactions →"
  // opened from a Transactions charge — changes only the query string, so the
  // page doesn't remount and loadStatic's one-time read never sees it. When
  // the vendor param changes to a new value, apply it as a fresh load would:
  // that vendor's whole statement, other filters cleared. The first value is
  // loadStatic's; a vendor the page itself clears from the URL is left alone.
  const vendorParam = useSearchParams().get("vendor") ?? "";
  const appliedVendor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (appliedVendor.current === null || vendorParam === appliedVendor.current) {
      appliedVendor.current = vendorParam;
      return;
    }
    appliedVendor.current = vendorParam;
    if (!vendorParam) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVendor(vendorParam);
    setMonth("");
    setQ("");
    setCatFilter("");
    setType("");
    setAccount("");
    setRecurring("");
    setMinAmount("");
    setMaxAmount("");
  }, [ready, vendorParam]);

  // Query string for one page of the current filter set.
  const buildTxQuery = useCallback((f: Filters, offset: number) => {
    const p = new URLSearchParams();
    if (f.month) p.set("month", f.month);
    if (f.cat) p.set("category", f.cat);
    if (f.q) p.set("q", f.q);
    if (f.vendor) p.set("vendor", f.vendor);
    if (f.type) p.set("type", f.type);
    if (f.account) p.set("account", f.account);
    if (f.minAmount) p.set("minAmount", f.minAmount);
    if (f.maxAmount) p.set("maxAmount", f.maxAmount);
    if (f.recurring) p.set("recurring", f.recurring);
    p.set("sort", f.sort);
    p.set("dir", f.dir);
    // A vendor (statement) view is bounded — load it whole so its totals and
    // grouping are exact. Otherwise page the list server-side.
    if (!f.vendor) {
      p.set("limit", String(PAGE));
      if (offset) p.set("offset", String(offset));
    }
    return p.toString();
  }, []);

  // Latest filters + loaded count, so loadMore (fired from the scroll observer)
  // always pages the current view without re-subscribing on every render.
  const filtersRef = useRef<Filters | null>(null);
  const loadedCountRef = useRef(0);
  useEffect(() => {
    loadedCountRef.current = txs.length;
  }, [txs.length]);

  // "Latest wins" guard (see lib/latestGuard): every page-1 load supersedes prior
  // tokens, and each fetch applies its result only if its token is still current —
  // so an out-of-order page-1 response, or a loadMore still in flight when the
  // filter changes, is discarded instead of corrupting a newer result set.
  const guardRef = useRef(createLatestGuard());

  // Page 1: replace the list and capture the full-set count + net total. Retries
  // a transient failure (a just-started dev route, a network blip) so the first
  // load self-recovers instead of leaving an empty list that needs a manual
  // refresh. The gen-guard keeps a retry from clobbering a newer load.
  const load = useCallback(
    (f: Filters) => {
      filtersRef.current = f;
      const token = guardRef.current.begin(); // one token for this load + its retries
      setStatus("loading");
      const run = async (attempt: number): Promise<void> => {
        if (!guardRef.current.isCurrent(token)) return; // a newer load superseded this one
        try {
          const res = await fetch(`/api/transactions?${buildTxQuery(f, 0)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!guardRef.current.isCurrent(token)) return;
          setTxs(data.rows ?? []);
          setTotalCount(data.count ?? data.rows?.length ?? 0);
          setNetTotal(data.net ?? 0);
          setVendorName(typeof data.vendorName === "string" ? data.vendorName : null);
          setCategoryShared(data.categoryShared !== false);
          setStatus("ready");
        } catch {
          // Transient failure (cold dev route / blip) → retry, so the first load
          // self-recovers instead of leaving an empty list that needs a refresh.
          if (!guardRef.current.isCurrent(token)) return;
          if (attempt < 2) setTimeout(() => run(attempt + 1), 500);
          else setStatus("error");
        }
      };
      void run(0);
    },
    [buildTxQuery]
  );

  // Append the next page. Guarded (ref) so overlapping scroll triggers can't
  // double-fetch, and tied to the current load generation so a page that resolves
  // after a filter change is dropped rather than appended under the new filter.
  const loadMore = useCallback(async () => {
    const f = filtersRef.current;
    if (!f || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const token = guardRef.current.current(); // ride the current result set
    try {
      // getJson throws on a failed reply, so the catch below says so; a raw
      // fetch read the error body and quietly appended nothing.
      const data = await getJson<{ rows?: Tx[] }>(`/api/transactions?${buildTxQuery(f, loadedCountRef.current)}`);
      if (!guardRef.current.isCurrent(token)) return; // filters changed mid-flight — discard
      setTxs((prev) => [...prev, ...(data.rows ?? [])]);
    } catch {
      if (guardRef.current.isCurrent(token)) toast("Couldn't load more — please try again", "error");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [buildTxQuery, toast]);

  useEffect(() => {
    // Retry a transient first-load failure (a just-started dev route / network
    // blip) so the page self-recovers instead of needing a manual refresh; give
    // up gracefully after a few tries so the rest of the page still works.
    let cancelled = false;
    let tries = 0;
    const go = () => {
      loadStatic().catch(() => {
        if (cancelled) return;
        if (tries++ < 2) setTimeout(go, 500);
        else setReady(true);
      });
    };
    go();
    return () => {
      cancelled = true;
    };
  }, [loadStatic]);

  // Defer the review-queue widgets until the browser is idle after first paint,
  // so the list renders first and the queues' fetches (esp. the merge scan)
  // don't contend on load.
  useEffect(() => {
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const reveal = () => setShowQueues(true);
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(reveal);
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(reveal, 200);
    return () => clearTimeout(id);
  }, []);

  // Fetch the next page when the bottom sentinel scrolls into view.
  const hasMore = txs.length < totalCount;
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "600px" } // start loading before it's actually visible
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  // Debounced reload whenever any filter (or a forced refresh) changes.
  // Wait until the deep-link has been read. Fetching before that used the
  // empty month (every charge) and, once the month was set, painted that
  // all-time net under "September" until the real request returned. The
  // header figure is that net, so the mismatch would be the loudest thing
  // on the page.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(
      () =>
        load({
          month,
          cat: catFilter,
          q,
          vendor,
          type,
          account,
          minAmount,
          maxAmount,
          recurring,
          sort,
          dir,
        }),
      200
    );
    return () => clearTimeout(t);
  }, [ready, month, catFilter, q, vendor, type, account, minAmount, maxAmount, recurring, sort, dir, refreshKey, load]);

  // Keep the browser URL in sync with the live filters, so clearing a filter
  // (e.g. the Uncategorized deep-link) actually sticks across reloads and a
  // plain /transactions nav starts clean. Replace (not push) to avoid history
  // spam. sort/dir stay out — they're view prefs, not deep-linkable filters.
  useEffect(() => {
    if (!ready) return;
    const p = new URLSearchParams();
    if (month) p.set("month", month);
    if (catFilter) p.set("category", catFilter);
    if (q) p.set("q", q);
    if (vendor) p.set("vendor", vendor);
    if (type) p.set("type", type);
    if (account) p.set("account", account);
    if (minAmount) p.set("minAmount", minAmount);
    if (maxAmount) p.set("maxAmount", maxAmount);
    if (recurring) p.set("recurring", recurring);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [ready, month, catFilter, q, vendor, type, account, minAmount, maxAmount, recurring]);

  // Handlers are stabilized with useCallback so the memoized TxRow only
  // re-renders when its own data/flags change — not on every keystroke or
  // optimistic edit elsewhere in the list. (setTxs/setRefreshKey
  // and toast are stable; cats is the only mutable dep, and it changes rarely.)
  const setCategory = useCallback(
    async (id: number, categoryId: number | null) => {
      setTxs((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                categoryId,
                categoryName: cats.find((c) => c.id === categoryId)?.name ?? null,
                categoryColor: cats.find((c) => c.id === categoryId)?.color ?? null,
                categoryIcon: cats.find((c) => c.id === categoryId)?.icon ?? null,
              }
            : t
        )
      );
      // The optimistic update is the instant feedback; the page then re-reads
      // and reconciles — under a category filter the row leaves because it
      // no longer matches, the "N shown" count follows, and the queues above
      // re-read with the same counter. (On failure the re-read restores the
      // row's real category.)
      await mutate(
        () => patchJson(`/api/transactions/${id}`, { categoryId }),
        { error: "Couldn't save category — please try again" },
        { refresh: "always" }
      );
    },
    [cats, mutate]
  );

  // A row opens the charge's own shelf, which carries every overlay a charge
  // can take; the vendor is one link up from there.
  const onOpenRow = useCallback(
    (t: Tx) => openCharge(t.id, { onChange: () => setRefreshKey((k) => k + 1) }),
    [openCharge]
  );

  // Group the list under day headers when it's in date order (the rows are
  // already date-sorted by the server, so consecutive runs share a day). Other
  // sorts (amount, merchant) stay a flat list — a date header would be nonsense.
  // Grouping operates on the loaded pages; the header's net/count come from the
  // server (netTotal/totalCount) and span the full filtered set.
  const grouping = sort === "date";
  const grouped = useMemo(() => {
    if (!grouping) return [{ key: "__all", label: "", total: 0, rows: txs }];
    const out: { key: string; label: string; total: number; rows: Tx[] }[] = [];
    for (const t of txs) {
      const day = t.effectiveDate ?? t.date;
      let g = out[out.length - 1];
      if (!g || g.key !== day) {
        g = { key: day, label: dayLabel(day), total: 0, rows: [] };
        out.push(g);
      }
      g.rows.push(t);
      if (!(t.excluded || t.categoryExcluded)) g.total += t.amount;
    }
    return out;
  }, [txs, grouping]);

  // Statement mode: when the vendor filter is active, every row is the same
  // vendor — and usually the same category/account. Collapse that constant
  // identity into one header and let the rows read like a statement (date ·
  // amount), surfacing category/account only on the charges that break the
  // pattern. The heading is the vendor's name, not the newest charge's plan.
  // `modal` holds the vendor's most-common values (null = normal mode).
  const modal = useMemo(() => {
    if (vendor === "" || txs.length === 0) return null;
    const catCount = new Map<string, number>();
    const acctCount = new Map<string, number>();
    for (const t of txs) {
      const ck = String(t.categoryId ?? "none");
      catCount.set(ck, (catCount.get(ck) ?? 0) + 1);
      acctCount.set(t.account, (acctCount.get(t.account) ?? 0) + 1);
    }
    const topCat = [...catCount].sort((a, b) => b[1] - a[1])[0]?.[0];
    const topAcct = [...acctCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const rep = txs.find((t) => String(t.categoryId ?? "none") === topCat) ?? txs[0];
    const counted = txs.filter((t) => !(t.excluded || t.categoryExcluded));
    return {
      displayName: vendorName ?? txs[0].displayName,
      categoryId: rep.categoryId,
      categoryName: rep.categoryName,
      categoryColor: rep.categoryColor,
      categoryIcon: rep.categoryIcon,
      categoryShared,
      account: topAcct,
      // Only what counts: the same rule as the page's net and the day totals.
      // Summing every row put an excluded duplicate into the header, so one
      // screen read "net −$1,200.00" above "−$1,300.00 total".
      count: counted.length,
      notCounted: txs.length - counted.length,
      total: counted.reduce((a, t) => a + t.amount, 0),
    };
  }, [vendor, vendorName, categoryShared, txs]);

  // Linear-style filters: a filter shows as a chip only when active (has a
  // value) or explicitly added from the "+ Filter" menu. The menu lists the rest.
  const FILTERS = [
    { id: "category", label: "Category" },
    { id: "type", label: "Type" },
    { id: "account", label: "Account" },
    { id: "amount", label: "Amount" },
    { id: "recurring", label: "Recurring" },
  ];
  const isActive = (id: string) =>
    id === "category"
      ? catFilter !== ""
      : id === "type"
      ? type !== ""
      : id === "account"
      ? account !== ""
      : id === "amount"
      ? minAmount !== "" || maxAmount !== ""
      : id === "recurring"
      ? recurring !== ""
      : false;
  const shown = (id: string) => isActive(id) || added.includes(id);
  function removeFilter(id: string) {
    setAdded((a) => a.filter((x) => x !== id));
    if (id === "category") setCatFilter("");
    if (id === "type") setType("");
    if (id === "account") setAccount("");
    if (id === "amount") {
      setMinAmount("");
      setMaxAmount("");
    }
    if (id === "recurring") setRecurring("");
  }
  const chipSelect =
    "max-w-40 cursor-pointer appearance-none select-caret bg-transparent pr-4 text-xs focus:outline-none";

  return (
    <Shell
      title="Transactions"
      figure={
        // Hide the net until a result has landed. The first fetch used to be
        // every charge, and that number would sit in the header — now at the
        // summary size — until the month's own total replaced it.
        status === "ready" || totalCount > 0
          ? {
              value: usd(netTotal, { sign: true, cents: false }),
              // The period joins the count ("9 shown · Oct 1–4"): the net's
              // line is this header's one line.
              caption: `${totalCount} shown${period ? ` · ${period}` : ""}`,
            }
          : undefined
      }
      month={<MonthPicker months={months} value={month} onChange={setMonth} allowAll />}
      actions={
        <HeaderMenu>
          <ImportButton onDone={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />
        </HeaderMenu>
      }
    >
      {showQueues && (
        <>
          <CategorizeQueue
            version={refreshKey}
            onChange={() => loadStatic().then(() => setRefreshKey((k) => k + 1))}
            // The queue counts vendors across all time; the list is scoped to
            // a month, so widen it too or a caught-up month shows nothing.
            onShowUncategorized={() => {
              setCatFilter("none");
              setMonth("");
            }}
          />

          <NameCleanupQueue version={refreshKey} onChange={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />

          <MergeQueue version={refreshKey} onChange={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />

          <PlanMatchQueue version={refreshKey} onChange={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />
        </>
      )}

      <Toolbar className="mb-4">
        {/* On mobile, search owns the row and sort+filter collapse into one
            trailing icon (sm:contents dissolves this wrapper on desktop, where
            the inline +Filter and sort controls return). */}
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:contents">
          <SearchBox value={q} onChange={search} placeholder="Search merchant or amount…" className="min-w-0 flex-1 sm:w-60 sm:flex-none" />
          <MobileSortFilter
            sort={sort}
            dir={dir}
            onSort={(s, d) => {
              setSort(s);
              setDir(d);
            }}
            available={FILTERS.filter((f) => !shown(f.id))}
            filtersActive={FILTERS.some((f) => shown(f.id))}
            onAddFilter={(id) => setAdded((a) => [...a, id])}
          />
        </div>

        {vendor && (
          <Chip onRemove={() => setVendor("")}>
            <span className="max-w-40 truncate text-xs">
              Vendor: <span className="font-medium">{vendor}</span>
            </span>
          </Chip>
        )}
        {shown("category") && (
          <Chip onRemove={() => removeFilter("category")}>
            <select
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
              className={chipSelect}
            >
              <option value="">Category…</option>
              <option value="none">Uncategorized</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
            </select>
          </Chip>
        )}
        {shown("type") && (
          <Chip onRemove={() => removeFilter("type")}>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={chipSelect}
            >
              <option value="">Type…</option>
              <option value="expense">Expenses</option>
              <option value="income">Income</option>
            </select>
          </Chip>
        )}
        {shown("account") && (
          <Chip onRemove={() => removeFilter("account")}>
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className={chipSelect}
            >
              <option value="">Account…</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Chip>
        )}
        {shown("amount") && (
          <Chip onRemove={() => removeFilter("amount")}>
            <input
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
              placeholder="min $"
              inputMode="decimal"
              className="w-14 bg-transparent text-xs focus:outline-none"
            />
            <span className="text-[var(--muted)]">–</span>
            <input
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              placeholder="max $"
              inputMode="decimal"
              className="w-14 bg-transparent text-xs focus:outline-none"
            />
          </Chip>
        )}
        {shown("recurring") && (
          <Chip onRemove={() => removeFilter("recurring")}>
            <select
              value={recurring}
              onChange={(e) => setRecurring(e.target.value)}
              className={chipSelect}
            >
              <option value="">Recurring…</option>
              <option value="yes">Recurring</option>
              <option value="no">One-time</option>
            </select>
          </Chip>
        )}

        {FILTERS.some((f) => !shown(f.id)) && (
          <div className="relative hidden sm:block">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              + Filter
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute left-0 z-20 mt-1 w-40 rounded-lg border border-[var(--border)] bg-card p-1 shadow-[0_4px_16px_rgba(16,24,40,0.12)]">
                  {FILTERS.filter((f) => !shown(f.id)).map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        setAdded((a) => [...a, f.id]);
                        setMenuOpen(false);
                      }}
                      className="block w-full rounded-lg px-3 py-2 text-left text-[13px] hover:bg-[var(--hover)]"
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <select
          suppressHydrationWarning // iOS Chrome's autofill tag; see SearchBox
          value={`${sort}-${dir}`}
          onChange={(e) => {
            const [s, d] = e.target.value.split("-");
            setSort(s);
            setDir(d);
          }}
          className="btn-ghost select-caret hidden cursor-pointer appearance-none pr-8 text-[13px] sm:ml-auto sm:block"
        >
          <option value="date-desc">Newest</option>
          <option value="date-asc">Oldest</option>
          <option value="amount-desc">Largest amount</option>
          <option value="amount-asc">Smallest amount</option>
          <option value="merchant-asc">Merchant A–Z</option>
        </select>
      </Toolbar>

      {/* overflow-clip, not hidden: hidden would make the card its own scroll
          container and the day headers would stick to it instead of the page. */}
      <div className="card overflow-clip">
        {txs.length === 0 && status === "loading" ? (
          <div className="p-4">
            <LoadingRows />
          </div>
        ) : txs.length === 0 && status === "error" ? (
          <div className="p-4">
            <LoadError what="transactions" onRetry={() => setRefreshKey((k) => k + 1)} />
          </div>
        ) : txs.length === 0 ? (
          <p className="p-8 text-center text-[13px] text-[var(--muted)]">
            No transactions match.
          </p>
        ) : (
          <>
            {modal && (
              <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--background)] px-4 py-3">
                <CategoryBadge
                  icon={modal.categoryShared ? modal.categoryIcon : null}
                  color={modal.categoryShared ? modal.categoryColor : null}
                  size="md"
                  fallback={modal.displayName}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold">{modal.displayName}</div>
                  <div className="truncate text-xs text-[var(--muted)]">
                    {modal.count} transaction{modal.count === 1 ? "" : "s"}
                    {modal.notCounted > 0 ? ` · ${modal.notCounted} not counted` : ""}
                    {modal.categoryShared ? ` · ${modal.categoryName ?? "Uncategorized"}` : ""}
                    {modal.account ? ` · ${modal.account}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div data-vendor-total className="text-[13px] font-semibold tabular-nums">
                    {usd(modal.total, { sign: true })}
                  </div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                    total
                  </div>
                </div>
              </div>
            )}
            <ul className="divide-y divide-[var(--border)]/60">
            {grouped.map((g) => {
              // Only group under a day header when the day actually has more than
              // one transaction — otherwise the header + its subtotal just echo the
              // single row below it. Solo-charge days show the date inline instead.
              const headed = grouping && g.rows.length > 1;
              return (
              <Fragment key={g.key}>
                {headed && (
                  <li
                    data-day-header
                    // A running header in a continuous list (DESIGN.md §2): a band
                    // in the page grey so a day boundary reads as a boundary, not
                    // as one more row divider; sticky, so a long month keeps its
                    // date in view. The total sits on the row's amount column at
                    // the row size, muted — a sum, not a fifth amount.
                    className="sticky top-[var(--page-header,0px)] z-10 flex items-center justify-between bg-[var(--background)] px-4 py-2"
                  >
                    <span className="stat-label">{g.label}</span>
                    <span data-day-total className="w-24 text-right text-[13px] font-medium tabular-nums text-[var(--muted)]">
                      {usd(g.total, { sign: true })}
                    </span>
                  </li>
                )}
                {g.rows.map((t) => (
                  <TxRow
                    key={t.id}
                    t={t}
                    modal={modal}
                    headed={headed}
                    isCatActive={activeCatSelect === t.id}
                    isShelfActive={shelfActive.isCharge(t.id)}
                    cats={cats}
                    onOpen={onOpenRow}
                    setActiveCatSelect={setActiveCatSelect}
                    onSetCategory={setCategory}
                  />
                ))}
              </Fragment>
              );
            })}
          </ul>
          {hasMore && (
            // Sentinel: scrolling near here auto-loads the next page. The button
            // is the keyboard/no-IntersectionObserver fallback and a clear count.
            <div
              ref={sentinelRef}
              className="flex items-center justify-center border-t border-[var(--border)] p-3"
            >
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="tap text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] hover:underline disabled:opacity-50"
              >
                {loadingMore
                  ? "Loading…"
                  : `Show more · ${totalCount - txs.length} of ${totalCount} remaining`}
              </button>
            </div>
          )}
          </>
        )}
      </div>
    </Shell>
  );
}


// Mobile-only: search owns its row, so sort + add-filter collapse behind one
// "adjustments" icon (the iOS convention for refining a list). An accent dot
// signals when a non-default sort or any filter is active, so the hidden state
// stays legible. Desktop keeps the inline +Filter button and sort <select>.
const SORT_OPTIONS: [string, string][] = [
  ["date-desc", "Newest"],
  ["date-asc", "Oldest"],
  ["amount-desc", "Largest amount"],
  ["amount-asc", "Smallest amount"],
  ["merchant-asc", "Merchant A–Z"],
];

function MobileSortFilter({
  sort,
  dir,
  onSort,
  available,
  filtersActive,
  onAddFilter,
}: {
  sort: string;
  dir: string;
  onSort: (sort: string, dir: string) => void;
  available: { id: string; label: string }[];
  filtersActive: boolean;
  onAddFilter: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const value = `${sort}-${dir}`;
  const refined = value !== "date-desc" || filtersActive;
  return (
    <div className="relative shrink-0 sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Sort and filter"
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0 1.5 1.5 0 0 1 3 0Zm-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0 1.5 1.5 0 0 1 3 0Zm-9.75 0h9.75" />
        </svg>
        {refined && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-[var(--background)] bg-[var(--accent)]" />
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-[var(--border)] bg-card p-1 shadow-[0_4px_16px_rgba(16,24,40,0.12)]">
            <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              Sort
            </div>
            {SORT_OPTIONS.map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  const [s, d] = v.split("-");
                  onSort(s, d);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] hover:bg-[var(--hover)]"
              >
                {label}
                {value === v && <span className="text-[var(--accent)]">✓</span>}
              </button>
            ))}
            {available.length > 0 && (
              <>
                <div className="my-1 border-t border-[var(--border)]" />
                <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                  Add filter
                </div>
                {available.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => {
                      onAddFilter(f.id);
                      setOpen(false);
                    }}
                    className="block w-full rounded-lg px-3 py-2 text-left text-[13px] hover:bg-[var(--hover)]"
                  >
                    {f.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// The per-transaction category control. Two responsive variants of the same
// <select>:
//   - "pill"  → desktop right-side pill (hidden on mobile)
//   - "chip"  → compact chip in the row subtitle (mobile only), so the category
//               shares a line instead of taking a full-width row → denser list.
// Resting state shows the category NAME ONLY — the row's round badge already
// carries the icon + color, so repeating the icon here is redundant. The OPEN
// dropdown keeps icons (they speed up scanning ~27 categories). Lazy options
// (full list mounted only once active) preserved.
// One transaction row, memoized so an edit or keystroke elsewhere in the list
// doesn't re-render every row. Receives per-row flags (computed by the parent
// from a single piece of state, e.g. isEditingDate) and stable
// callbacks, so React.memo's shallow compare actually skips unaffected rows.
const TxRow = memo(function TxRow({
  t,
  modal,
  headed,
  isCatActive,
  isShelfActive,
  cats,
  onOpen,
  setActiveCatSelect,
  onSetCategory,
}: {
  t: Tx;
  modal: { categoryId: number | null; categoryShared: boolean; account: string } | null;
  headed: boolean;
  isCatActive: boolean;
  isShelfActive: boolean;
  cats: Cat[];
  onOpen: (t: Tx) => void;
  setActiveCatSelect: Dispatch<SetStateAction<number | null>>;
  onSetCategory: (id: number, categoryId: number | null) => void;
}) {
  const sameCat =
    modal && modal.categoryShared && String(t.categoryId ?? "none") === String(modal.categoryId ?? "none");
  const sameAcct = modal && t.account === modal.account;
  const recState = recurringState(t);
  const setCategory = onSetCategory;
  // "•" is the app's placeholder for a category with no real emoji (see core.ts),
  // so it's not null — treat it (and empty) as no icon and use the merchant's
  // initial instead, which reads intentional rather than like a broken image.
  return (
              <li
                data-drawer-row
                {...rowButtonProps(() => onOpen(t))}
                // content-visibility lets the browser skip layout + paint for rows
                // scrolled off-screen — virtualizing the render without unmounting
                // (so Cmd-F, scroll position, and a11y still work). The intrinsic
                // size is an estimate that keeps the scrollbar stable.
                style={{ contentVisibility: "auto", containIntrinsicSize: "auto 52px" }}
                className={`group flex cursor-pointer flex-wrap items-start gap-x-2 gap-y-2 py-2 pl-4 pr-4 text-[13px] sm:flex-nowrap sm:items-center sm:gap-3 ${ROW_FOCUS} ${
                  isShelfActive
                    ? "bg-[var(--accent)]/10"
                    : "hover:bg-[var(--hover)]"
                } ${t.excluded ? "opacity-55" : ""}`}
              >
                {!modal && (
                  <CategoryBadge icon={t.categoryIcon} color={t.categoryColor} fallback={t.displayName} className="self-center" />
                )}
                <div className="min-w-0 flex-1">
                  {modal ? (
                    <>
                      <div className="flex items-center gap-2 leading-5">
                        <span className="whitespace-nowrap text-[13px] font-medium">{longDate(t.effectiveDate ?? t.date)}</span>
                        {t.splitParts > 0 ? (
                          <span className="pill shrink-0 bg-[var(--background)] text-[11px] text-[var(--muted)]">
                            split · {t.splitParts} parts
                          </span>
                        ) : t.excluded ? (
                          <span className="pill shrink-0 bg-[var(--background)] text-[11px] text-[var(--muted)]">
                            not counted
                          </span>
                        ) : t.splitMissed ? (
                          <span data-split-drift-tag className="pill shrink-0 bg-[var(--warn)]/15 text-[11px] text-[var(--warn)]">
                            not split
                          </span>
                        ) : null}
                      </div>
                      {/* Mobile: the category chip belongs in the subtitle here too —
                          the desktop pill is hidden on small screens, and suppressed
                          when the row matches the vendor's category. */}
                      <div className="flex flex-wrap items-center gap-x-2 text-xs leading-4 text-[var(--muted)]">
                        <CategoryProperty
                          categoryId={t.categoryId}
                          categoryName={t.categoryName}
                          categoryIcon={t.categoryIcon}
                          cats={cats}
                          active={isCatActive}
                          onActivate={() => setActiveCatSelect(t.id)}
                          onDeactivate={() => setActiveCatSelect((cur) => (cur === t.id ? null : cur))}
                          onChange={(id) => setCategory(t.id, id)}
                          className="-ml-2 sm:hidden"
                        />
                          {!sameAcct && <span className="whitespace-nowrap">{t.account}</span>}
                          {t.effectiveDate && t.effectiveDate !== t.date && (
                            <span className="text-[var(--warn)]">
                              {!sameAcct ? "· " : ""}posted {shortDate(t.date)}
                            </span>
                          )}
                        </div>
                    </>
                  ) : (
                    <>
                  <div className="flex items-center gap-2 leading-5">
                    <span className="truncate text-[13px] font-medium">{t.displayName}</span>
                    {/* Passive recurring marker — glanceable state; the toggle
                        lives in the charge's shelf. */}
                    {recState !== "none" && (
                      <Tooltip label={RECURRING_LABEL[recState]} onlyIfTruncated={false} className="shrink-0">
                        <RecurringGlyph state={recState} className="text-xs" />
                      </Tooltip>
                    )}
                    {t.splitParts > 0 ? (
                      <span className="pill shrink-0 bg-[var(--background)] text-[11px] text-[var(--muted)]">
                        split · {t.splitParts} parts
                      </span>
                    ) : t.excluded ? (
                      <span className="pill shrink-0 bg-[var(--background)] text-[11px] text-[var(--muted)]">
                        not counted
                      </span>
                    ) : t.splitMissed ? (
                      <span data-split-drift-tag className="pill shrink-0 bg-[var(--warn)]/15 text-[11px] text-[var(--warn)]">
                        not split
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs leading-4 text-[var(--muted)]">
                    {/* Mobile: the category as a compact chip inline in the
                        subtitle (denser than a full-width pill row). Desktop uses
                        the right-side pill above. Name only: the row's glyph is
                        this category's icon, a few pixels to the left. */}
                    <CategoryProperty
                      hideIcon
                      categoryId={t.categoryId}
                      categoryName={t.categoryName}
                      categoryIcon={t.categoryIcon}
                      cats={cats}
                      active={isCatActive}
                      onActivate={() => setActiveCatSelect(t.id)}
                      onDeactivate={() => setActiveCatSelect((cur) => (cur === t.id ? null : cur))}
                      onChange={(id) => setCategory(t.id, id)}
                      className="-ml-2 sm:hidden"
                    />
                    {headed ? (
                      <>
                        {/* Account dropped on mobile (it's tertiary — in the bottom
                            sheet); the date is already in the day-group header. */}
                        <span className="hidden whitespace-nowrap sm:inline">{t.account}</span>
                        {t.effectiveDate && t.effectiveDate !== t.date && (
                          <span className="text-[var(--warn)]">
                            · posted {shortDate(t.date)}
                          </span>
                        )}                      </>
                    ) : (
                      <>
                        <span className="whitespace-nowrap">{longDate(t.effectiveDate ?? t.date)}</span>
                        {t.effectiveDate && t.effectiveDate !== t.date && (
                          <span className="text-[var(--warn)]">
                            · posted {shortDate(t.date)}
                          </span>
                        )}
                        {/* Account dropped on mobile (tertiary; lives in the sheet).
                            The date stays here — this sort isn't day-grouped. */}
                        <span className="hidden whitespace-nowrap sm:inline">· {t.account}</span>
                      </>
                    )}
                  </div>
                    </>
                  )}
                  {/* A set note takes its own line below (edited in the charge's
                      shelf). Outside the mode ternary so statement view has it too. */}
                  {t.note && (
                    <div className="mt-1 flex max-w-full items-baseline gap-1 text-xs italic text-[var(--muted)]">
                      <span className="shrink-0 not-italic opacity-70">✎</span>
                      <span className="truncate">{t.note}</span>
                    </div>
                  )}
                </div>
                {/* Desktop: the category as a quiet property in its own column
                    (hidden on a phone, where it sits in the meta line instead). */}
                {(!modal || !sameCat) && (
                  <span className="hidden w-44 shrink-0 justify-end sm:flex">
                    <CategoryProperty
                      categoryId={t.categoryId}
                      categoryName={t.categoryName}
                      categoryIcon={t.categoryIcon}
                      cats={cats}
                      active={isCatActive}
                      onActivate={() => setActiveCatSelect(t.id)}
                      onDeactivate={() => setActiveCatSelect((cur) => (cur === t.id ? null : cur))}
                      onChange={(id) => setCategory(t.id, id)}
                    />
                  </span>
                )}
                {/* Every amount here is settled, so the settled-vs-provisional
                    weight contrast has no job; medium keeps the name first.
                    A charge that posted for another amount than it showed
                    pending says so under it ("+$2.80 tip"). */}
                <AmountCell value={t.amount} note={pendingNote(t.amount, t.pendingAmount)} excluded={!!t.excluded || !!t.categoryExcluded} quiet className="w-24 shrink-0" />
              </li>
  );
});


// Day-group header label, e.g. "Saturday, June 6". UTC to match the stored dates.
function dayLabel(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Active-filter chip: an inline control + a remove (✕). Shown only for applied
// filters, so the toolbar stays calm until you opt into complexity (Linear-style).
function Chip({
  children,
  onRemove,
}: {
  children: ReactNode;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-card py-1 pl-3 pr-1 text-xs">
      {children}
      <button
        onClick={onRemove}
        className="tap rounded-lg px-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
        aria-label="Remove filter"
      >
        ✕
      </button>
    </span>
  );
}
