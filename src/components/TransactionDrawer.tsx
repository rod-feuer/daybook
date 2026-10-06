"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation } from "@/components/useMutation";
import { getJson, postJson, patchJson, deleteJson } from "@/lib/http";
import { usd } from "@/lib/format";
import { LoadError } from "@/components/LoadState";
import type { ChargeDetail } from "@/lib/queries";
import type { Cat, CatSummary, SettingsPatch, Summary, Vendor } from "@/components/shelf/types";
import { CategoryBody, CategoryHeader } from "@/components/shelf/CategoryShelf";
import { ChargeBody, ChargeHeader, SplitDialog } from "@/components/shelf/ChargeShelf";
import { MerchantBody, MerchantHeader } from "@/components/shelf/MerchantShelf";
import { AccountBody, AccountHeader } from "@/components/shelf/AccountShelf";
import type { AccountDetail, OwnerValue } from "@/lib/accounts";

type OpenOpts = { onChange?: () => void; amountHint?: number | null; series?: string }; // series: one plan of a multi-plan vendor
type Target =
  | { kind: "merchant"; merchant: string; series?: string }
  | { kind: "category"; categoryId: number; month: string }
  | { kind: "charge"; id: number }
  | { kind: "account"; id: number };

type Shelf = {
  openMerchant: (merchant: string, opts?: OpenOpts) => void;
  openCategory: (categoryId: number, month: string, opts?: OpenOpts) => void;
  openCharge: (id: number, opts?: OpenOpts) => void;
  openAccount: (id: number, opts?: OpenOpts) => void;
  active: Target | null; // what the shelf is currently showing, for active-state styling
};
const Ctx = createContext<Shelf>({
  openMerchant: () => {},
  openCategory: () => {},
  openCharge: () => {},
  openAccount: () => {},
  active: null,
});
export const useTxDrawer = () => useContext(Ctx).openMerchant;
export const useCategoryShelf = () => useContext(Ctx).openCategory;
export const useChargeShelf = () => useContext(Ctx).openCharge;
export const useAccountShelf = () => useContext(Ctx).openAccount;

// Whether a given trigger is the one the shelf is currently showing — so a row or
// bar can render a "selected" state while its detail is open (and make the
// click-again-to-close gesture discoverable).
export const useShelfActive = () => {
  const { active } = useContext(Ctx);
  return {
    isMerchant: (m: string, series?: string) =>
      active?.kind === "merchant" && active.merchant === m && (active.series ?? null) === (series ?? null),
    isCategory: (id: number, month: string) =>
      active?.kind === "category" && active.categoryId === id && active.month === month,
    isCharge: (id: number) => active?.kind === "charge" && active.id === id,
    isAccount: (id: number) => active?.kind === "account" && active.id === id,
  };
};

export function TxDrawerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [mData, setMData] = useState<Summary | null>(null);
  const [cData, setCData] = useState<CatSummary | null>(null);
  const [xData, setXData] = useState<ChargeDetail | null>(null);
  const [aData, setAData] = useState<AccountDetail | null>(null);
  const [back, setBack] = useState<Target | null>(null);
  // An account drilled into from another (a home's mortgage): Back names it.
  const [backName, setBackName] = useState<string | null>(null);
  const [amountHint, setAmountHint] = useState<number | null>(null);
  const [cats, setCats] = useState<Cat[]>([]);
  // A category created from a shelf dropdown joins the pickers at once.
  const addCat = useCallback((c: Cat) => setCats((cs) => [...cs, c]), []);
  // Vendors (one per canonical merchant, with display name) for the Combine picker.
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const onChange = useRef<(() => void) | undefined>(undefined);
  const asideRef = useRef<HTMLElement>(null);
  // A bottom sheet is as tall as its content. Moving to another shelf empties
  // it to three placeholder bars until the read answers, and the sheet dropped
  // ~310px and rose again, flashing the page behind it. Hold the height it had
  // across the switch; the effect below lets go once the new content is in.
  const holdSheet = useCallback(() => {
    const el = asideRef.current;
    if (el && window.matchMedia("(max-width: 639px)").matches) el.style.minHeight = `${el.getBoundingClientRect().height}px`;
  }, []);
  // Each handler below re-reads its own target (the merchant or the category)
  // after a write, so the shared refresh policy is "never" and the refresh
  // happens on the returned success flag.
  const mutate = useMutation();

  // Not on the login screen: nobody is signed in there, so both reads came back
  // 401 — and the reply was stored as if it were the list ({ error } is not an
  // array). getJson throws on a non-OK reply, so a failed read leaves the lists
  // empty instead of corrupt.
  const onLogin = usePathname() === "/login";
  useEffect(() => {
    if (onLogin) return;
    getJson<Cat[]>("/api/categories").then(setCats).catch(() => {});
    getJson<Vendor[]>("/api/vendors").then(setVendors).catch(() => {});
  }, [onLogin]);

  // A failed shelf read shows an error with Retry instead of the skeleton —
  // `loading` below is derived from missing data, so without this flag a
  // failed fetch would pulse forever.
  const [loadError, setLoadError] = useState(false);
  // `keep`: a re-read after a write keeps the current panel on screen until
  // the new data lands — no skeleton, no scroll reset, no jump.
  // Only the latest read may land. The shelf shows one thing at a time, so one
  // counter covers all three loaders: an answer (or a failure) that arrives
  // after a newer read began is dropped. Without it, a slow read for vendor A
  // that landed after the shelf had moved to vendor B put A's name, amounts
  // and plan id under B's target — and a recategorize then sent B's vendor
  // with A's plan.
  const readSeq = useRef(0);
  const read = useCallback(<T,>(url: string, set: (d: T | null) => void, keep: boolean) => {
    const seq = ++readSeq.current;
    if (!keep) set(null);
    setLoadError(false);
    getJson<T>(url)
      .then((d) => {
        if (seq === readSeq.current) set(d);
      })
      .catch(() => {
        if (seq === readSeq.current) setLoadError(true);
      });
  }, []);
  const fetchMerchant = useCallback(
    (m: string, series?: string, keep = false) =>
      read<Summary>(`/api/merchant?name=${encodeURIComponent(m)}${series ? `&series=${encodeURIComponent(series)}` : ""}`, setMData, keep),
    [read]
  );
  const fetchCategory = useCallback(
    (id: number, month: string, keep = false) =>
      read<CatSummary>(`/api/category?id=${id}&month=${encodeURIComponent(month)}`, setCData, keep),
    [read]
  );
  const fetchCharge = useCallback(
    (id: number, keep = false) => read<ChargeDetail>(`/api/transactions/${id}`, setXData, keep),
    [read]
  );
  const fetchAccount = useCallback(
    (id: number, keep = false) => read<AccountDetail>(`/api/net-worth/accounts/${id}`, setAData, keep),
    [read]
  );

  const close = useCallback(() => {
    setTarget(null);
    setBack(null);
    setBackName(null);
    setAmountHint(null);
  }, []);

  const openMerchant = useCallback(
    (m: string, opts?: OpenOpts) => {
      // Re-clicking the row whose detail is already showing toggles the shelf
      // shut (matches the in-place, non-modal feel — the trigger stays in view).
      if (target?.kind === "merchant" && target.merchant === m && (target.series ?? null) === (opts?.series ?? null)) {
        close();
        return;
      }
      holdSheet();
      onChange.current = opts?.onChange;
      setAmountHint(opts?.amountHint ?? null);
      setBack(null);
      setBackName(null);
      setCData(null);
      setTarget({ kind: "merchant", merchant: m, series: opts?.series });
      fetchMerchant(m, opts?.series);
    },
    [target, close, fetchMerchant, holdSheet]
  );
  // One charge: its shelf carries the overlays a charge can take (category,
  // date, note, plan membership, exclude from totals, split), so the
  // Transactions row needs no menu. "Open vendor" drills up, with Back.
  const openCharge = useCallback(
    (id: number, opts?: OpenOpts) => {
      if (target?.kind === "charge" && target.id === id) {
        close();
        return;
      }
      holdSheet();
      onChange.current = opts?.onChange;
      setAmountHint(null);
      setBack(null);
      setBackName(null);
      setMData(null);
      setCData(null);
      setTarget({ kind: "charge", id });
      fetchCharge(id);
    },
    [target, close, fetchCharge, holdSheet]
  );
  const openCategory = useCallback(
    (categoryId: number, month: string, opts?: OpenOpts) => {
      if (
        target?.kind === "category" &&
        target.categoryId === categoryId &&
        target.month === month
      ) {
        close();
        return;
      }
      holdSheet();
      onChange.current = opts?.onChange;
      setAmountHint(null);
      setBack(null);
      setBackName(null);
      setMData(null);
      setTarget({ kind: "category", categoryId, month });
      fetchCategory(categoryId, month);
    },
    [target, close, fetchCategory, holdSheet]
  );

  // One account (the Accounts page): its value, history, and verbs.
  const openAccount = useCallback(
    (id: number, opts?: OpenOpts) => {
      if (target?.kind === "account" && target.id === id) {
        close();
        return;
      }
      holdSheet();
      onChange.current = opts?.onChange;
      setAmountHint(null);
      setBack(null);
      setBackName(null);
      setTarget({ kind: "account", id });
      fetchAccount(id);
    },
    [target, close, fetchAccount, holdSheet]
  );

  // Drill from a category's transaction into that vendor, remembering the
  // category so the panel can offer a "← Back".
  const drillToMerchant = (m: string, series?: string) => {
    holdSheet();
    setBack(target);
    setBackName(null);
    setAmountHint(null);
    setCData(null);
    setTarget({ kind: "merchant", merchant: m, series });
    fetchMerchant(m, series);
  };
  // From a home's shelf to the loan against it, with Back to the home.
  const drillToAccount = (id: number) => {
    holdSheet();
    setBack(target);
    setBackName(target?.kind === "account" ? (aData?.name ?? null) : null);
    setTarget({ kind: "account", id });
    fetchAccount(id);
  };
  const goBack = () => {
    const b = back;
    if (!b) return;
    holdSheet();
    setBack(null);
    setBackName(null);
    setTarget(b);
    if (b.kind === "category") fetchCategory(b.categoryId, b.month);
    else if (b.kind === "charge") fetchCharge(b.id);
    else if (b.kind === "account") fetchAccount(b.id);
    else fetchMerchant(b.merchant);
  };

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, close]);

  // Non-modal: close when clicking outside the panel — but not when clicking a
  // drawer row (`data-drawer-row`), so clicking another row updates the panel in
  // place instead of closing it.
  useEffect(() => {
    if (!target) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el) return;
      // An in-shelf control can remove the clicked element synchronously on
      // mousedown (e.g. the combine picker closes its dropdown when you pick a
      // vendor). By the time this bubbles to window the node is detached, so a
      // contains() check would wrongly read it as an outside click and close the
      // shelf. A disconnected target came from our own re-render — never close.
      if (!el.isConnected) return;
      if (asideRef.current?.contains(el)) return;
      if (el.closest("[data-drawer-row]")) return;
      // A popover opened from a shelf control (the New-category form) is
      // portaled to <body>, outside the panel — clicking into it is not leaving.
      if (el.closest("[role='dialog']")) return;
      close();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [target, close]);

  // Non-modal panel: close it when the route changes (e.g. switching tabs).
  const pathname = usePathname();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTarget(null);
  }, [pathname]);

  // Re-read whichever detail is open.
  const refreshTarget = () => {
    if (target?.kind === "category") fetchCategory(target.categoryId, target.month, true);
    else if (target?.kind === "merchant") fetchMerchant(target.merchant, target.series, true);
    else if (target?.kind === "charge") fetchCharge(target.id, true);
    else if (target?.kind === "account") fetchAccount(target.id, true);
  };
  // Every shelf write has one shape: do it, and on success re-read what the
  // shelf is showing and tell the page behind it. `after` replaces the re-read
  // where the target itself is gone (a combine, a category delete) and the
  // shelf closes instead. A success message only where the result can't be
  // seen on the object (DESIGN.md §2, "A toast is for what you can't see").
  async function write(fn: () => Promise<unknown>, messages: { success?: string; error: string }, after: () => void = refreshTarget) {
    if (!(await mutate(fn, messages, { refresh: "never" }))) return;
    after();
    onChange.current?.();
  }
  const UPDATE_ERROR = "Couldn't update — please try again";

  function recategorize(categoryId: number | null) {
    if (target?.kind !== "merchant") return;
    const merchant = target.merchant;
    // One plan of several recategorizes only its own charges. The vendor
    // shelf does not set a category when its charges already disagree.
    if (!mData?.seriesId && mData?.categoryMixed) return;
    return write(
      () => postJson("/api/recurrings/recategorize", { merchant, categoryId, recurringId: mData?.seriesId ?? undefined }),
      { error: "Couldn't recategorize — please try again" }
    );
  }
  // Save a per-merchant override (name and/or go-forward amount) edited right in
  // the shelf, where the recent charges that justify the value are on screen.
  // Overrides live under the plan's key when the shelf is on one plan.
  function saveMerchantSettings(patch: SettingsPatch, success?: string) {
    if (target?.kind !== "merchant") return;
    const merchant = mData?.settingsKey ?? target.merchant;
    return write(() => postJson("/api/recurrings/settings", { merchant, ...patch }), { success, error: "Couldn't save — please try again" });
  }
  // Merge two vendors into one. `loser` folds into `primary` (the survivor, which
  // becomes canonical); an optional `alias` sets the merged vendor's display name
  // (used when the user picks a custom name). The component resolves which is the
  // survivor from the name they chose, so "canonical" is never surfaced. Close the
  // shelf afterward — its target may now be the folded-away descriptor.
  function combineMerchant(loser: string, primary: string, alias?: string, categoryId?: number | null) {
    return write(
      async () => {
        await postJson("/api/recurrings/link", { alias: loser, primary });
        if (alias != null) await postJson("/api/recurrings/settings", { merchant: primary, alias });
        // Unify the category when the user chose to, so a combined vendor isn't
        // left split across categories. Recategorize covers all linked descriptors;
        // `force` because the user chose one category for both, plans and all.
        if (categoryId != null) await postJson("/api/recurrings/recategorize", { merchant: primary, categoryId, force: true });
      },
      { success: "Vendors combined", error: "Couldn't combine — please try again" },
      close
    );
  }
  // Several similar names into this vendor at once (the shelf's Similar
  // names), or this vendor and the rest into the ticked name the owner chose
  // to keep. Each is the same link a single Combine makes; the shelf stays
  // open on the survivor, now holding their charges.
  function combineMany(losers: string[], into?: string) {
    if (target?.kind !== "merchant" || !mData) return;
    const primary = into ?? mData.merchant;
    const aliases = into ? [mData.merchant, ...losers.filter((m) => m !== into)] : losers;
    const name = into ? (mData.similar.find((v) => v.merchant === into)?.displayName ?? into) : mData.displayName;
    return write(
      async () => {
        for (const alias of aliases) await postJson("/api/recurrings/link", { alias, primary });
      },
      { success: `Combined ${aliases.length} name${aliases.length === 1 ? "" : "s"} into ${name}`, error: "Couldn't combine — please try again" },
      into
        ? () => {
            setTarget({ kind: "merchant", merchant: primary });
            fetchMerchant(primary);
          }
        : undefined
    );
  }
  // One category for several similar names that stay separate vendors (the
  // shelf's Similar names): each vendor moves as a whole, as on its own shelf.
  function categorizeMany(merchants: string[], categoryId: number) {
    const name = cats.find((c) => c.id === categoryId)?.name ?? "the category";
    return write(
      async () => {
        for (const merchant of merchants) await postJson("/api/recurrings/recategorize", { merchant, categoryId });
      },
      { success: `Set ${merchants.length} vendor${merchants.length === 1 ? "" : "s"} to ${name}`, error: "Couldn't set the category — please try again" }
    );
  }
  function unlinkName(alias: string) {
    if (target?.kind !== "merchant") return;
    return write(
      () => postJson("/api/recurrings/link", { alias, unlink: true }),
      { success: `Separated “${alias}”`, error: "Couldn't separate — please try again" }
    );
  }
  // A vendor's (or one plan's) recurring status. "Not recurring" on one plan
  // mutes that plan, not the vendor: the shelf passes the plan's key.
  const setRecurring = (merchant: string, makeIt: boolean) =>
    write(() => postJson("/api/recurrings/override", { merchant, status: makeIt ? "force" : "mute" }), { error: UPDATE_ERROR });
  function toggleRecurring() {
    if (target?.kind !== "merchant" || !mData) return;
    return setRecurring(mData.settingsKey ?? target.merchant, !mData.recurring);
  }
  // Add a plan the detector found: it counts from now on. The shelf shows it.
  function addPlan() {
    if (!mData?.planKey) return;
    const key = mData.planKey;
    return write(() => postJson("/api/recurrings/confirm", { key }), { error: UPDATE_ERROR });
  }

  // The charge's own overlays. Each is one PATCH on the charge. No success
  // toast: the card, caption or button you touched shows the result.
  const chargePatch = (id: number, body: Record<string, unknown>, error: string) =>
    write(() => patchJson(`/api/transactions/${id}`, body), { error });
  const [splitting, setSplitting] = useState(false);
  const chargeUndoSplit = (id: number) =>
    write(() => deleteJson(`/api/transactions/${id}/split`), { success: "Split undone", error: "Couldn't undo the split — please try again" });
  const txSetMembership = (txId: number, put: "in" | "out", plan: string | null) =>
    chargePatch(txId, put === "out" ? { recurringExcluded: true } : { recurringIncluded: plan }, UPDATE_ERROR);
  // The category's own verbs, in its shelf (the row only opens the shelf).
  const categoryPatch = (id: number, patch: Record<string, unknown>, error: string) =>
    write(() => patchJson(`/api/categories/${id}`, patch), { error });
  const categorySetExcluded = (id: number, excludeFromTotals: boolean) =>
    write(() => patchJson(`/api/categories/${id}`, { excludeFromTotals }), { error: "Couldn't update category — please try again" });
  const categorySetBudget = (id: number, budget: number | null, period: "monthly" | "annual", month: string) =>
    write(() => patchJson(`/api/categories/${id}`, { budget, period, month }), { error: "Couldn't save budget — please try again" });
  const categorySetMonthBudget = (id: number, month: string, budget: number | null) =>
    write(() => patchJson(`/api/categories/${id}`, { budget, month, scope: "only" }), { error: "Couldn't save the month's budget — please try again" });
  // Two-step delete, no native confirm: the first click arms the button for
  // three seconds, the second deletes; the shelf closes on its category.
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  function categoryDelete(c: CatSummary) {
    if (confirmingDelete !== c.id) {
      setConfirmingDelete(c.id);
      setTimeout(() => setConfirmingDelete((cur) => (cur === c.id ? null : cur)), 3000);
      return;
    }
    setConfirmingDelete(null);
    return write(
      () => deleteJson(`/api/categories/${c.id}`),
      {
        success: `Deleted "${c.name}" · ${c.txCount} transaction${c.txCount === 1 ? "" : "s"} now uncategorized`,
        error: `Couldn't delete "${c.name}" — please try again`,
      },
      close
    );
  }

  const loading =
    target?.kind === "merchant" ? !mData : target?.kind === "category" ? !cData : target?.kind === "account" ? !aData : !xData;

  // Account writes. A rename or a value shows on the shelf and the row, so
  // they say nothing; a delete closes the shelf, so it says what happened.
  const [confirmingAccountDelete, setConfirmingAccountDelete] = useState<number | null>(null);
  const accountPatch = (id: number, patch: { name?: string; counted?: boolean; terms?: object; securedBy?: number | null; paidBy?: string | null }) =>
    write(() => patchJson(`/api/net-worth/accounts/${id}`, patch), { error: UPDATE_ERROR });
  const accountSetValue = (id: number, v: OwnerValue) =>
    write(() => postJson(`/api/net-worth/accounts/${id}/values`, v), { error: "Couldn't save the value — please try again" });
  const accountRemoveValue = (id: number, asOf: string) =>
    write(() => deleteJson(`/api/net-worth/accounts/${id}/values?asOf=${asOf}`), { error: "Couldn't remove the value — please try again" });
  function accountDelete(a: AccountDetail) {
    if (confirmingAccountDelete !== a.id) {
      setConfirmingAccountDelete(a.id);
      setTimeout(() => setConfirmingAccountDelete((cur) => (cur === a.id ? null : cur)), 3000);
      return;
    }
    setConfirmingAccountDelete(null);
    return write(() => deleteJson(`/api/net-worth/accounts/${a.id}`), { success: `Deleted "${a.name}"`, error: `Couldn't delete "${a.name}" — please try again` }, close);
  }
  useEffect(() => {
    if (!loading && asideRef.current) asideRef.current.style.minHeight = "";
  }, [loading, target]);

  // Swipe the bottom sheet down to close it. Touch only, and only where the
  // shelf is a sheet; a press on a control in the header stays a press.
  const sheetDrag = useRef<{ y: number; t: number } | null>(null);
  function sheetDragStart(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" || window.matchMedia("(min-width: 640px)").matches) return;
    if ((e.target as HTMLElement).closest("button, input, select, a")) return;
    sheetDrag.current = { y: e.clientY, t: e.timeStamp };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function sheetDragMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = asideRef.current;
    if (!sheetDrag.current || !el) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${Math.max(0, e.clientY - sheetDrag.current.y)}px)`;
  }
  function sheetDragEnd(e: React.PointerEvent<HTMLDivElement>) {
    const d = sheetDrag.current;
    const el = asideRef.current;
    sheetDrag.current = null;
    if (!d || !el) return;
    const dy = e.clientY - d.y;
    const flick = dy > 24 && dy / Math.max(1, e.timeStamp - d.t) > 0.5; // px per ms
    el.style.transition = "transform 150ms ease-out";
    el.style.transform = "";
    if (dy > 96 || flick) close();
  }

  return (
    <Ctx.Provider value={{ openMerchant, openCategory, openCharge, openAccount, active: target }}>
      {children}
      {target && (
        <>
          {/* Dim backdrop on mobile (this is a bottom sheet there); the desktop
              right-side panel has none, as before. */}
          <div
            className="fixed inset-0 z-40 bg-black/30 sm:hidden"
            onClick={close}
            aria-hidden
          />
          <aside
            data-shelf
            ref={asideRef}
            // Bottom sheet on mobile (slides up, capped height, round top corners);
            // right-side panel on desktop (sm:+) exactly as before.
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88vh] flex-col rounded-t-2xl border-t border-[var(--border)] bg-card shadow-2xl sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-auto sm:h-full sm:max-h-none sm:w-full sm:max-w-sm sm:rounded-none sm:border-t-0 sm:border-l"
          >
            {/* The handle keeps its promise: on a phone the sheet's top (handle
                and header) drags down with the finger, and letting go far enough
                or fast enough closes it. It was decoration before. */}
            <div
              data-sheet-drag
              className="shrink-0 touch-none sm:touch-auto"
              onPointerDown={sheetDragStart}
              onPointerMove={sheetDragMove}
              onPointerUp={sheetDragEnd}
              onPointerCancel={sheetDragEnd}
            >
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-[var(--border)] sm:hidden" aria-hidden />
          <header className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0">
              {back && (
                <button
                  onClick={goBack}
                  className="mb-1 text-xs text-[var(--accent)] hover:underline"
                >
                  {backName ? `← Back to ${backName}` : "← Back"}
                </button>
              )}
              {target.kind === "merchant" ? (
                <MerchantHeader
                  merchant={target.merchant}
                  data={mData}
                  onUnlink={unlinkName}
                  onRename={(alias) => saveMerchantSettings({ alias })}
                />
              ) : target.kind === "category" ? (
                <CategoryHeader
                  data={cData}
                  month={target.month}
                  onRename={(name) => cData && categoryPatch(cData.id, { name }, "Couldn't rename — please try again")}
                  onEditAppearance={(patch) => cData && categoryPatch(cData.id, patch, "Couldn't update category — please try again")}
                />
              ) : target.kind === "account" ? (
                <AccountHeader data={aData} onRename={(name) => aData && accountPatch(aData.id, { name })} />
              ) : (
                <ChargeHeader
                  data={xData}
                  onOpenVendor={() => xData && drillToMerchant(xData.vendor)}
                  onSeparate={() =>
                    xData &&
                    write(() => postJson("/api/recurrings/link", { alias: xData.merchant, unlink: true }), {
                      error: "Couldn't separate — please try again",
                    })
                  }
                />
              )}
            </div>
            <button
              onClick={close}
              className="tap shrink-0 rounded-lg px-2 py-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              ✕
            </button>
          </header>
            </div>

          <div className="flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-4">
            {loadError ? (
              <LoadError
                what={target.kind === "merchant" ? "this vendor" : target.kind === "category" ? "this category" : target.kind === "account" ? "this account" : "this charge"}
                onRetry={() =>
                  target.kind === "merchant"
                    ? fetchMerchant(target.merchant, target.series)
                    : target.kind === "category"
                      ? fetchCategory(target.categoryId, target.month)
                      : target.kind === "account"
                        ? fetchAccount(target.id)
                        : fetchCharge(target.id)
                }
              />
            ) : loading ? (
              <div className="space-y-2">
                <div className="h-16 animate-pulse rounded-lg bg-[var(--background)]" />
                <div className="h-9 animate-pulse rounded-lg bg-[var(--background)]" />
                <div className="h-40 animate-pulse rounded-lg bg-[var(--background)]" />
              </div>
            ) : target.kind === "merchant" && mData ? (
              <MerchantBody
                data={mData}
                cats={cats}
                onOpenPlan={(series) => drillToMerchant(target.merchant, series)}
                onAddCategory={addCat}
                onRecategorize={recategorize}
                onTxSetMembership={txSetMembership}
                onToggleRecurring={toggleRecurring}
                onAddPlan={addPlan}
                onSaveSettings={saveMerchantSettings}
                amountHint={amountHint}
                vendors={vendors}
                onCombine={combineMerchant}
                onCombineMany={combineMany}
                onCategorizeMany={categorizeMany}
                onRemoveSplit={(id, applied) =>
                  write(() => deleteJson(`/api/split-rules/${id}`), {
                    success: applied ? `Split removed · ${applied} charge${applied === 1 ? "" : "s"} restored` : "Split removed",
                    error: "Couldn't remove the split — please try again",
                  })
                }
                onRemoveVendorRule={(id) =>
                  write(() => deleteJson(`/api/vendor-rules/${id}`), { success: "Rule removed; its charges are back", error: "Couldn't remove the rule — please try again" })
                }
              />
            ) : target.kind === "category" && cData ? (
              <CategoryBody
                data={cData}
                onOpenMerchant={drillToMerchant}
                onSetExcluded={(exclude) => categorySetExcluded(cData.id, exclude)}
                onSetBudget={(amount, period) => categorySetBudget(cData.id, amount, period, cData.month)}
                onSetMonthBudget={(month, amount) => categorySetMonthBudget(cData.id, month, amount)}
                onDelete={() => categoryDelete(cData)}
                confirmingDelete={confirmingDelete === cData.id}
              />
            ) : target.kind === "account" && aData ? (
              <AccountBody
                data={aData}
                onSetValue={(v) => accountSetValue(aData.id, v)}
                onRemoveValue={(asOf) => accountRemoveValue(aData.id, asOf)}
                onSetCounted={(counted) => accountPatch(aData.id, { counted })}
                onSetTerms={(terms) => accountPatch(aData.id, { terms })}
                onSetSecuredBy={(securedBy) => accountPatch(aData.id, { securedBy })}
                onSetPaidBy={(paidBy) => accountPatch(aData.id, { paidBy })}
                onOpenAccount={drillToAccount}
                onDelete={() => accountDelete(aData)}
                confirmingDelete={confirmingAccountDelete === aData.id}
              />
            ) : target.kind === "charge" && xData ? (
              <ChargeBody
                data={xData}
                cats={cats}
                onAddCategory={addCat}
                onSetCategory={(categoryId) => chargePatch(xData.id, { categoryId }, "Couldn't recategorize — please try again")}
                onSetDate={(effectiveDate) => chargePatch(xData.id, { effectiveDate }, "Couldn't update date — please try again")}
                onSetNote={(note) => chargePatch(xData.id, { note }, "Couldn't save note — please try again")}
                onSetExcluded={(excluded) => chargePatch(xData.id, { excluded }, "Couldn't update — please try again")}
                onSetMembership={(put) => txSetMembership(xData.id, put, xData.planKey)}
                onStartPlan={() => chargePatch(xData.id, { startPlan: true }, "Couldn't start a plan — please try again")}
                onSplit={() => setSplitting(true)}
                onUndoSplit={() => chargeUndoSplit(xData.id)}
                onSplitAsBefore={() =>
                  xData.splitDrift &&
                  write(() => postJson(`/api/transactions/${xData.id}/split`, { parts: xData.splitDrift!.parts }), {
                    success: "Split applied",
                    error: "Couldn't split — please try again",
                  })
                }
                onOpenVendor={() => drillToMerchant(xData.vendor)}
                onMakeRecurring={() => setRecurring(xData.vendor, true)}
                vendors={vendors}
                onChangeVendor={(vendor, rule) =>
                  write(
                    () => postJson(`/api/transactions/${xData.id}/vendor`, { vendor, rule }),
                    // A rule moves charges off screen, so it says how many;
                    // one charge shows its new vendor on the shelf itself.
                    {
                      success: rule ? `“${xData.merchant}” charges of ${usd(Math.abs(xData.amount))} now go to ${vendors.find((v) => v.merchant === vendor)?.displayName ?? vendor}` : undefined,
                      error: "Couldn't change the vendor — please try again",
                    }
                  )
                }
                onRemoveVendorRule={(id) =>
                  write(() => deleteJson(`/api/vendor-rules/${id}`), { success: "Rule removed; its charges are back", error: "Couldn't remove the rule — please try again" })
                }
                onOpenCharge={(id) => {
                  setTarget({ kind: "charge", id });
                  fetchCharge(id);
                }}
              />
            ) : null}
            {splitting && xData && (
              <SplitDialog
                tx={xData}
                cats={cats}
                onClose={() => setSplitting(false)}
                onDone={() => {
                  setSplitting(false);
                  refreshTarget();
                  onChange.current?.();
                }}
              />
            )}
            {/* The way out follows the content, not the panel's edge: a
                link pinned to the foot sat across a gap on every short shelf. */}
            {(target.kind === "merchant" || target.kind === "category") && (target.kind === "merchant" ? mData : cData) && (
              <Link
                href={
                  target.kind === "merchant"
                    ? `/transactions?vendor=${encodeURIComponent(target.merchant)}`
                    : `/transactions?category=${target.categoryId}&month=${target.month}`
                }
                onClick={close}
                className="btn-link mt-4 w-full justify-center rounded-lg px-2 py-2 text-[13px] hover:bg-[var(--hover)] hover:no-underline"
              >
                {target.kind === "merchant"
                  ? mData?.series
                    ? "All this vendor's charges →"
                    : `View all ${mData?.count ?? 0} transactions →`
                  : "View all transactions →"}
              </Link>
            )}
          </div>
          </aside>
        </>
      )}
    </Ctx.Provider>
  );
}

