"use client";

import type { ReactNode } from "react";
import { RecurringGlyph, RECURRING_LABEL, type RecurringState } from "@/components/RecurringGlyph";
import { AmountCell, CategoryOptions, categoryChange } from "@/components/RowCells";
import { rowButtonProps, ROW_FOCUS } from "@/components/rowButton";
import { Tooltip } from "@/components/Tooltip";
import { usd, shortDate, shortDatePad } from "@/lib/format";
import type { Cat } from "@/components/shelf/types";

export function StateTag({ edited }: { edited?: boolean }) {
  return edited ? (
    <span className="rounded-full bg-[var(--accent)]/15 px-2 text-[11px] font-medium text-[var(--accent)]">
      edited
    </span>
  ) : (
    <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">auto</span>
  );
}

export function MembershipPill({
  kind,
  inPlan,
  edited,
  onToggle,
}: {
  kind: "charge" | "vendor";
  inPlan: boolean;
  edited: boolean;
  onToggle: () => void;
}) {
  const text = kind === "charge" ? (inPlan ? "In plan" : "Not in plan") : inPlan ? "Recurring" : "Not recurring";
  const action =
    kind === "charge"
      ? inPlan ? "Take this charge out of the plan" : "Put this charge in the plan"
      : inPlan ? "Mark vendor not recurring" : "Mark vendor recurring";
  const tone = inPlan
    ? "border border-[var(--border)] text-[var(--muted)] opacity-60 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
    : edited && kind === "charge"
      ? "bg-[var(--warn)]/15 text-[var(--warn)] hover:bg-[var(--warn)]/25"
      : "bg-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]";
  return (
    <span className="flex shrink-0 items-center gap-1">
      {edited && <StateTag edited />}
      <button
        type="button"
        data-membership={inPlan ? "in" : "out"}
        data-edited={edited ? "1" : undefined}
        aria-label={action}
        title={action}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={`shrink-0 rounded-full px-2 py-px text-[11px] font-medium transition-colors ${tone}`}
      >
        {text}
      </button>
    </span>
  );
}

// Spend by calendar year as bars. Shared by the vendor's shelf and the
// charge's, which shows the same figures as read-only evidence.
export function ByYear({ rows, title }: { rows: { year: string; spent: number }[]; title: string }) {
  if (rows.length < 2) return null;
  const max = Math.max(...rows.map((y) => y.spent), 1);
  return (
    <div data-by-year>
      <div className="stat-label mb-2">{title}</div>
      <div className="flex flex-col gap-2">
        {rows.map((y) => (
          <div key={y.year} className="flex items-center gap-2 text-xs">
            {/* A partial year says so — the honesty rule for figures mid-flight. */}
            <span className="w-[4.6rem] shrink-0 text-[var(--muted)]">
              {y.year}
              {y.year === String(new Date().getUTCFullYear()) ? " so far" : ""}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--background)]">
              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${(y.spent / max) * 100}%` }} />
            </div>
            <span className="w-14 shrink-0 text-right tabular-nums">{usd(y.spent, { cents: false })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


export type Membership = { kind: "charge" | "vendor"; onToggle: () => void; edited?: boolean };
export function ShelfRow({
  date,
  name,
  meta,
  pill,
  amount,
  sign,
  muted,
  excluded,
  recurring = "none",
  onClick,
  membership,
  flush = false,
  showGlyph = false,
  unsignedDebits = false,
  note,
  active = false,
}: {
  date: string;
  name?: string; // omitted when every row in the list would say the same thing
  // What varies between one vendor's charges (the bank's name for each, or
  // its category): a caption, not a name, so it never reads as another vendor.
  meta?: string;
  pill?: string; // the day a plan bills, when a vendor carries several
  amount: number;
  sign?: boolean;
  muted?: boolean;
  excluded?: boolean; // doesn't count toward totals → an inflow is not green
  recurring?: RecurringState;
  onClick?: () => void;
  membership?: Membership;
  flush?: boolean; // no horizontal padding: the list sits on the panel's edges
  showGlyph?: boolean; // keep the ↻ gutter on a flush list (a category's vendors)
  unsignedDebits?: boolean; // a plan's charges are debits by definition — no minus on every row
  note?: string; // quiet text in the pill's slot when there is no control (e.g. "not counted")
  active?: boolean; // the row the shelf is about (a charge in its own vendor history)
}) {
  return (
    <li>
      <div
        {...(onClick ? rowButtonProps(onClick) : {})}
        data-active={active ? "1" : undefined}
        // A flush list sits on the panel's edges, so its wash and highlight run
        // 8px past the text on each side (negative margin, matching padding);
        // the dates and amounts keep their edge and the tint doesn't hug them.
        className={`group flex items-center gap-2 py-2 text-xs ${flush ? "-mx-2 px-2" : "w-full px-3"} ${
          onClick ? `cursor-pointer hover:bg-[var(--hover)] ${ROW_FOCUS}` : ""
        } ${active ? "rounded-lg bg-[var(--accent)]/10" : ""}`}
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* The glyph gutter belongs to lists without a membership pill. A flush
              charge list omits it; a category's flush list keeps it (showGlyph). */}
          {membership || (flush && !showGlyph) ? null : recurring !== "none" ? (
            <Tooltip label={RECURRING_LABEL[recurring]} onlyIfTruncated={false} className="w-3.5 shrink-0">
              <RecurringGlyph state={recurring} className="block w-full text-center" />
            </Tooltip>
          ) : (
            <span className="w-3.5 shrink-0" aria-hidden />
          )}
          <span className="w-11 shrink-0 tabular-nums text-[var(--muted)]">{shortDatePad(date)}</span>
          {pill && (
            <span
              data-plan-day
              className={`shrink-0 rounded-full border border-[var(--border)] px-2 py-px text-[11px] font-medium tabular-nums ${muted ? "text-[var(--muted)]" : ""}`}
            >
              {pill}
            </span>
          )}
          {name && (
            <Tooltip
              label={name}
              className={`truncate font-medium ${muted ? "text-[var(--muted)]" : ""}`}
            >
              {name}
            </Tooltip>
          )}
          {meta && (
            <Tooltip label={meta} className="truncate text-[var(--muted)]">
              {meta}
            </Tooltip>
          )}
        </span>
        {!membership && note && <span className="shrink-0 text-[11px] text-[var(--muted)]">{note}</span>}
        {membership && (
          <MembershipPill
            kind={membership.kind}
            inPlan={recurring === "in"}
            edited={!!membership.edited}
            onToggle={membership.onToggle}
          />
        )}
        {/* A fixed amount column, so a pill beside it lands on one edge in every row. */}
        <AmountCell
          value={amount}
          unsigned={unsignedDebits && amount < 0}
          sign={!!sign || (unsignedDebits && amount > 0)}
          excluded={excluded}
          state={muted ? "provisional" : "settled"}
          className="w-20 shrink-0"
        />
      </div>
    </li>
  );
}

export function CaptionSelect({ label, tag, className = "", children, ...select }: { label: string; tag?: ReactNode; className?: string; children: ReactNode } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex max-w-[11rem] items-center gap-1 rounded-lg py-1 pl-1 pr-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--hover)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]/40 ${className}`.trim()}>
      <span className="truncate">{label}</span>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--muted)]" aria-hidden>
        <path d="M6 9l6 6 6-6" />
      </svg>
      {tag && <span className="ml-1 shrink-0">{tag}</span>}
      <select {...select} className="absolute inset-0 w-full cursor-pointer opacity-0">
        {children}
      </select>
    </span>
  );
}

// The category on a shelf's caption line: the quiet picker with "+ New
// category…". The vendor (twice: with a plan, without) and the charge use it.
export function CategoryCaption({
  data,
  cats,
  onChange,
  onNew,
  edited = false,
  mixed = false,
}: {
  data: { categoryId: number | null; categoryName: string | null; categoryIcon: string | null };
  cats: Cat[];
  onChange: (categoryId: number | null) => void;
  onNew: (anchor: HTMLSelectElement) => void;
  edited?: boolean; // a plan's own category, which its next charges take
  mixed?: boolean; // its charges sit in more than one category: say so, and any pick moves them all
}) {
  return (
    <CaptionSelect
      tag={edited ? <StateTag edited /> : undefined}
      label={mixed ? "Mixed" : data.categoryId != null ? `${data.categoryIcon ?? ""} ${data.categoryName ?? ""}`.trim() : "Uncategorized"}
      value={mixed ? "__mixed" : (data.categoryId ?? "")}
      aria-label="Category"
      onChange={categoryChange(onChange, onNew)}
    >
      {mixed && (
        <option value="__mixed" disabled hidden>
          Mixed
        </option>
      )}
      <CategoryOptions cats={cats} withNew />
    </CaptionSelect>
  );
}

// A date inside a property card. The app writes dates as "Sep 18"; the native
// picker (its own locale format) is laid transparently over that and opens on
// click. The plan's next-due and the charge's effective date use it.
export function DateField({ label, value, onPick }: { label: string; value: string; onPick: (iso: string) => void }) {
  return (
    <span className="relative flex items-center justify-between">
      <span className="text-[15px] font-semibold tabular-nums">{shortDate(value)}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--muted)]" aria-hidden>
        <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
      <input
        type="date"
        aria-label={label}
        value={value}
        onClick={(e) => (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.()}
        onChange={(e) => onPick(e.target.value)}
        className="absolute inset-0 w-full cursor-pointer opacity-0"
      />
    </span>
  );
}

// A stat that is its own editor: the value on top, the label and its
// auto/edited state beneath, in the same box the read-only metrics use.
export function PropertyCard({ label, edited, detail, children }: { label: string; edited?: boolean; detail?: ReactNode; children: ReactNode }) {
  return (
    <div data-property-card className="rounded-lg bg-[var(--background)] px-3 py-2 focus-within:ring-2 focus-within:ring-[var(--accent)]/30">
      {children}
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</span>
        {/* Only properties with a detected value carry an auto/edited state. */}
        {edited !== undefined && <StateTag edited={edited} />}
      </div>
      {/* What the figure is measured against, under its label. */}
      {detail && <div className="mt-1 text-xs text-[var(--muted)]">{detail}</div>}
    </div>
  );
}
