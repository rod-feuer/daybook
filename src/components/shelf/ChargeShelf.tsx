"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { CommitInput } from "@/components/InlineEdit";
import { AmountCell } from "@/components/RowCells";
import { usd, shortDate, monthDayYear } from "@/lib/format";
import { useNewCategory } from "@/components/NewCategoryOption";
import { useMutation } from "@/components/useMutation";
import { postJson } from "@/lib/http";
import type { ChargeDetail } from "@/lib/queries";
import type { Cat } from "@/components/shelf/types";
import {
  ByYear,
  CategoryCaption,
  DateField,
  MembershipPill,
  PropertyCard,
  ShelfRow,
} from "@/components/shelf/parts";

export function ChargeHeader({ data, onOpenVendor }: { data: ChargeDetail | null; onOpenVendor: () => void }) {
  if (!data) return <div className="truncate text-[15px] font-semibold">…</div>;
  return (
    <>
      {/* The name is the way up: the vendor's shelf holds its history by year,
          its plan, rename and Combine. A quiet link under the list was the only
          route, and it read "All 62 charges →", which is not what it opened. */}
      <button
        onClick={onOpenVendor}
        data-open-vendor
        aria-label={`Open vendor: ${data.displayName}`}
        className="group/v flex max-w-full items-center gap-1 rounded-lg text-left text-[15px] font-semibold hover:text-[var(--accent)]"
      >
        <span className="truncate">{data.displayName}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4 shrink-0 text-[var(--muted)] opacity-60 transition-all group-hover/v:translate-x-0.5 group-hover/v:opacity-100">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {data.displayName !== data.merchant && (
        <div className="truncate text-[11px] text-[var(--muted)]">{data.merchant}</div>
      )}
      {/* The bank's own words, when they say more than the names above:
          "Commissary" was Plaid's guess; "GP001 - CAPITOL COMMINDIANAPOLIS
          IN" is where the charge was. */}
      {data.bankText && ![data.displayName, data.merchant].some((n) => n.toLowerCase() === data.bankText!.toLowerCase()) && (
        <div className="truncate text-[11px] text-[var(--muted)]" data-bank-text title={data.bankText}>
          Bank: {data.bankText}
        </div>
      )}
      <div className="text-xs text-[var(--muted)]">
        posted {monthDayYear(data.date)} · {data.account}
        {data.pending ? " · pending" : ""}
      </div>
    </>
  );
}

// The charge's shelf, in the shelf anatomy: two property cards — the date
// (its editor: an effective date moves the charge to another month) and the
// amount (bank data, read-only) — then the caption line with the category and
// the plan membership, the note, and the charge's verbs. "Open vendor" drills
// up to the vendor's shelf, with Back.
export function ChargeBody({
  data,
  cats,
  onAddCategory,
  onSetCategory,
  onSetDate,
  onSetNote,
  onSetExcluded,
  onSetMembership,
  onStartPlan,
  onSplit,
  onUndoSplit,
  onSplitAsBefore,
  onOpenVendor,
  onMakeRecurring,
  onOpenCharge,
}: {
  data: ChargeDetail;
  cats: Cat[];
  onAddCategory: (c: Cat) => void;
  onSetCategory: (categoryId: number | null) => void;
  onSetDate: (effectiveDate: string | null) => void;
  onSetNote: (note: string | null) => void;
  onSetExcluded: (excluded: boolean) => void;
  onSetMembership: (put: "in" | "out") => void;
  onStartPlan: () => void;
  onSplit: () => void;
  onUndoSplit: () => void;
  onSplitAsBefore: () => void; // the vendor's split rule missed this charge by a price change
  onOpenVendor: () => void;
  onOpenCharge: (id: number) => void; // step to another of the vendor's charges
  onMakeRecurring: () => void; // the vendor has no plan: make it one (a vendor verb, reachable here)
}) {
  const newCat = useNewCategory<null>((cat) => {
    onAddCategory(cat);
    onSetCategory(cat.id);
  });
  const dateEdited = !!data.effectiveDate && data.effectiveDate !== data.date;
  const isParent = data.splitParts > 0;
  const excluded = data.excluded === 1;
  const canSplit = data.amount < 0 && !data.pending && !isParent;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <PropertyCard label="date" edited={dateEdited}>
          <DateField
            label="Effective date"
            value={data.effectiveDate ?? data.date}
            onPick={(v) => {
              const eff = !v || v === data.date ? null : v;
              if (eff !== (data.effectiveDate ?? null)) onSetDate(eff);
            }}
          />
        </PropertyCard>
        <PropertyCard label="amount">
          <AmountCell value={data.amount} excluded={excluded || !!data.categoryExcluded} className="text-[15px]" />
        </PropertyCard>
      </div>
      <div className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
        {dateEdited && <span className="whitespace-nowrap">posted {shortDate(data.date)}</span>}
        <CategoryCaption data={data} cats={cats} onChange={onSetCategory} onNew={(anchor) => newCat.open(anchor, null, `New category for ${data.displayName}`)} />
        {newCat.popover}
        {/* Plan membership, when the vendor has a plan to be in. A charge
            excluded from totals can't join one. */}
        {data.planKey && !excluded && (
          <span className="flex items-center gap-1">
            <MembershipPill
              kind="charge"
              inPlan={data.recurringId != null}
              edited={data.recurringExcluded === 1 || data.recurringIncluded === 1}
              onToggle={() => onSetMembership(data.recurringId != null ? "out" : "in")}
            />
            <span className="truncate">{data.planName}</span>
            {/* The detector found this plan; it counts once the user adds it
                (In plan here, or Add on the vendor's shelf or the queue). */}
            {!data.planConfirmed && <span className="whitespace-nowrap">· suggested, not counted yet</span>}
          </span>
        )}
        {/* No plan to be in: the vendor's own pill, "Not recurring", makes
            it one — the same control the category shelf's rows carry, so a
            charge is never a dead end for "this should be recurring". */}
        {!data.planKey && !excluded && (
          <MembershipPill kind="vendor" inPlan={false} edited={false} onToggle={onMakeRecurring} />
        )}
        {/* A subscription the detector can't see (two amounts on one day, too
            few charges yet): the user's word makes the plan, from this charge's
            amount; the vendor's other charges at that amount join it. */}
        {!excluded && !isParent && data.recurringId == null && (!data.planKey || data.planConfirmed) && (
          <button onClick={onStartPlan} className="btn-link" data-start-plan>
            Start a plan →
          </button>
        )}
        {excluded && <span>not counted in totals</span>}
        {isParent && <span>split · {data.splitParts} parts</span>}
      </div>

      <div>
        <div className="stat-label mb-2">Note</div>
        <CommitInput
          key={data.note ?? ""}
          defaultValue={data.note ?? ""}
          placeholder="What was this for?"
          aria-label="Note"
          onCommit={(v) => {
            const note = v.trim() || null;
            if (note !== (data.note ?? null)) onSetNote(note);
          }}
          className="w-full rounded-lg border border-[var(--border)] bg-card px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
        />
      </div>

      {/* A split rule matches its amount to the cent, so a price change makes
          it miss without a word. Say so on the charge it missed, with the
          same parts scaled to the new total one tap away. */}
      {data.splitDrift && (
        <div data-split-drift className="flex flex-col gap-2 rounded-lg bg-[var(--warn)]/10 px-3 py-2 text-xs text-[var(--warn)]">
          <span>
            {`Your split for this vendor is set for ${usd(data.splitDrift.ruleAmount)}, so this ${usd(Math.abs(data.amount))} charge wasn’t split.`}
          </span>
          <span className="text-[var(--foreground)]">
            {data.splitDrift.parts.map((p) => `${p.label} ${usd(p.amount)}`).join("  ·  ")}
          </span>
          <button onClick={onSplitAsBefore} className="btn-ghost self-start text-xs">
            Split it the same way
          </button>
        </div>
      )}

      {/* The charge's verbs. A split parent is excluded because its parts
          count instead, so its totals toggle is hidden. */}
      <div className="flex gap-2">
        {!isParent && (
          <button
            onClick={() => onSetExcluded(!excluded)}
            title="Leaves this charge out of your income and expense totals — a transfer, a card payment, a reimbursed cost."
            className={`btn-ghost flex-1 text-xs ${excluded ? "text-[var(--warn)]" : ""}`}
          >
            {excluded ? "Count in totals" : "Exclude from totals"}
          </button>
        )}
        {isParent ? (
          <button onClick={onUndoSplit} className="btn-ghost flex-1 text-xs">
            Undo split ({data.splitParts} parts)
          </button>
        ) : (
          canSplit && (
            <button onClick={onSplit} className="btn-ghost flex-1 text-xs">
              Split…
            </button>
          )
        )}
      </div>

      {/* Evidence for "is this the usual amount?". One plan: the vendor's
          charges. Several plans: this plan only — the other plan would read
          as this one. The vendor shelf still has both, and the one-offs. */}
      <div>
        <div className="stat-label mb-2">
          {data.scopedToPlan ? "Recent in this plan" : "Recent from this vendor"}
          {data.vendorCount > data.recent.length ? ` · ${data.recent.length} of ${data.vendorCount}` : ""}
        </div>
        <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list data-charge-recent>
          {data.recent.map((r) => (
            <ShelfRow
              key={r.id}
              date={r.date}
              amount={r.amount}
              sign
              muted={r.excluded === 1}
              excluded={r.excluded === 1 || !!data.categoryExcluded}
              active={r.id === data.id}
              onClick={r.id === data.id ? undefined : () => onOpenCharge(r.id)}
              flush
            />
          ))}
        </ul>
        {/* One label, whatever the count: it opens the vendor, so it says so. */}
        <button onClick={onOpenVendor} className="btn-link mt-2">
          Open vendor →
        </button>
      </div>

      {/* What this vendor costs a year — the question a row most often raises.
          Evidence only: the vendor's controls stay on the vendor's shelf, where
          "category" means every charge and not this one. */}
      <ByYear rows={data.byYear} title="This vendor by year" />
    </div>
  );
}

// Split a single charge into category parts. Records a split rule keyed on the
// charge's merchant + amount and applies it immediately (see the split route);
// the parts must reconcile to the charge total before it can be saved.
// Portaled + centered so it sits above the shelf.
export function SplitDialog({
  tx,
  cats,
  onClose,
  onDone,
}: {
  tx: ChargeDetail;
  cats: Cat[];
  onClose: () => void;
  onDone: () => void;
}) {
  const total = Math.abs(tx.amount);
  const [parts, setParts] = useState<{ categoryId: string; amount: string; label: string }[]>(() => [
    { categoryId: tx.categoryId ? String(tx.categoryId) : "", amount: "", label: "" },
    { categoryId: "", amount: "", label: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const mutate = useMutation();
  const sum = parts.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const remaining = Number((total - sum).toFixed(2));
  const valid =
    parts.length >= 2 &&
    parts.every((p) => p.categoryId !== "" && Number(p.amount) > 0) &&
    Math.abs(remaining) <= 0.01;
  const update = (i: number, patch: Partial<(typeof parts)[number]>) =>
    setParts((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    const ok = await mutate(
      () =>
        postJson(`/api/transactions/${tx.id}/split`, {
          parts: parts.map((p) => ({
            categoryId: Number(p.categoryId),
            amount: Number(p.amount),
            label: p.label.trim() || cats.find((c) => c.id === Number(p.categoryId))?.name || "Part",
          })),
        }),
      { success: "Transaction split", error: "Couldn't split — please try again" },
      { refresh: "never" }
    );
    if (ok) onDone();
    else setSaving(false);
  }
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-label="Split transaction">
      <div className="card w-full max-w-md p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-[15px] font-semibold">Split transaction</div>
        <div className="mb-3 text-xs text-[var(--muted)]">
          {tx.displayName} · {usd(tx.amount, { sign: true })}
        </div>
        <div className="space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={p.categoryId}
                onChange={(e) => update(i, { categoryId: e.target.value })}
                className="select-caret min-w-0 flex-1 cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-2 pl-3 pr-8 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              >
                <option value="">Category…</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>
              <input
                value={p.amount}
                onChange={(e) => update(i, { amount: e.target.value })}
                placeholder="$"
                inputMode="decimal"
                className="w-20 rounded-lg border border-[var(--border)] bg-card px-2 py-2 text-right text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              />
              <input
                value={p.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder={cats.find((c) => c.id === Number(p.categoryId))?.name ?? "Label"}
                aria-label="Part label"
                className="w-24 rounded-lg border border-[var(--border)] bg-card px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              />
              {parts.length > 2 ? (
                <button onClick={() => setParts((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove part" className="tap rounded-lg px-1 text-[var(--muted)] hover:text-[var(--foreground)]">
                  ✕
                </button>
              ) : (
                <span className="w-5" />
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between text-xs">
          <button onClick={() => setParts((prev) => [...prev, { categoryId: "", amount: "", label: "" }])} className="font-medium text-[var(--muted)] hover:text-[var(--foreground)]">
            + Add part
          </button>
          <span className={Math.abs(remaining) > 0.01 ? "text-[var(--warn)] tabular-nums" : "text-[var(--muted)] tabular-nums"}>
            {remaining === 0 ? "balanced" : `${usd(remaining)} left`}
          </span>
        </div>
        <p className="mt-3 text-[11px] leading-snug text-[var(--muted)]">
          Splits this and any future {tx.displayName} charge of {usd(total)} into the parts above.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-xs">
            Cancel
          </button>
          <button onClick={submit} disabled={!valid || saving} className="btn-primary text-xs">
            {saving ? "Splitting…" : "Split"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
