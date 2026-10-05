"use client";

import type { ChangeEvent } from "react";
import { usd } from "@/lib/format";
import { Money } from "@/components/Money";
import { NEW_CATEGORY, NewCategoryOption } from "@/components/NewCategoryOption";
import type { Category } from "@/lib/types";

// The cells every list row shares (DESIGN.md §2, "Row anatomy"). Three rows
// carry them — the Transactions row, the Recurrings row, the shelf row — and
// they differ in what leads (a glyph where the vendor is the subject, a date
// where time is) and in their editors, so the anatomy is shared as cells,
// not as one wrapper that would have to know every editor.

// A category picker's options and its change handler, shared by every native
// category <select> that offers "+ New category…": the row's property below
// and the shelf's caption picker. Four copies had the same three lines of
// "is it the new-category sentinel, else a number or null".
export function CategoryOptions({ cats, withNew = false, likely }: { cats: Category[]; withNew?: boolean; likely?: number[] }) {
  const option = (c: Category) => (
    <option key={c.id} value={c.id}>
      {c.icon} {c.name}
    </option>
  );
  // A model's most probable categories lead the list (its top three held the
  // right one 76% of the time), so redirecting a wrong guess is usually one of
  // the first three rows and not a scroll through all of them.
  const first = (likely ?? []).map((id) => cats.find((c) => c.id === id)).filter((c): c is Category => !!c);
  return (
    <>
      <option value="">Uncategorized</option>
      {first.length > 1 ? (
        <>
          <optgroup label="Most likely">{first.map(option)}</optgroup>
          <optgroup label="All categories">{cats.map(option)}</optgroup>
        </>
      ) : (
        cats.map(option)
      )}
      {withNew && <NewCategoryOption />}
    </>
  );
}
export const categoryChange =
  (onChange: (categoryId: number | null) => void, onNewCategory?: (anchor: HTMLSelectElement) => void) =>
  (e: ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === NEW_CATEGORY) onNewCategory?.(e.currentTarget);
    else onChange(e.target.value ? Number(e.target.value) : null);
  };

// The category as a quiet property: icon + name in the muted text colour, a
// chevron beside it (a visible affordance), and the real native <select> laid
// transparently over the label — still native, still keyboard. No tint: the
// row's badge already carries the category's colour where there is one.
// Before, Transactions drew the same control as a tinted pill on desktop and
// a chip on a phone, and the category shelf as a ⋯ menu.
export function CategoryProperty({
  categoryId,
  categoryName,
  categoryIcon,
  cats,
  onChange,
  onNewCategory,
  active = true,
  onActivate,
  onDeactivate,
  ariaLabel = "Category",
  className = "",
  likely,
  hideIcon = false,
}: {
  categoryId: number | null;
  categoryName: string | null;
  categoryIcon: string | null;
  cats: Category[];
  onChange: (categoryId: number | null) => void;
  onNewCategory?: (anchor: HTMLSelectElement) => void; // "+ New category…" in the list
  // Long lists mount the full option list only while the control is in use.
  active?: boolean;
  onActivate?: () => void;
  onDeactivate?: () => void;
  ariaLabel?: string;
  className?: string;
  likely?: number[]; // a model's most probable categories, to lead the list
  hideIcon?: boolean; // the row's glyph already shows this icon right beside it
}) {
  const set = categoryId != null;
  const label = set ? `${hideIcon ? "" : (categoryIcon ?? "")} ${categoryName ?? ""}`.trim() : "Uncategorized";
  return (
    <span
      data-category-property
      className={`group/cat relative inline-flex max-w-full items-center gap-1 rounded-lg py-1 pl-2 pr-1 text-xs text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]/40 ${className}`}
    >
      <span className={`truncate ${set ? "" : "italic"}`}>{label}</span>
      <svg
        data-category-caret
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
      <select
        value={categoryId ?? ""}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={onActivate}
        onFocus={onActivate}
        onBlur={onDeactivate}
        onChange={categoryChange(onChange, onNewCategory)}
        aria-label={ariaLabel}
        className="tap-native absolute inset-0 w-full cursor-pointer opacity-0"
      >
        {active ? (
          <CategoryOptions cats={cats} withNew={!!onNewCategory} likely={likely} />
        ) : set ? (
          <option value={categoryId as number}>{label}</option>
        ) : (
          <option value="">Uncategorized</option>
        )}
      </select>
    </span>
  );
}

// The amount says what kind of number it is: settled (a posted charge: 600,
// foreground — green only for an inflow that counts), provisional (an expected
// one: 500, muted — the app's qualifier colour), overdue (600, warn). A paid
// row that differed from its expected shows the difference — the one fact a
// paid row can tell you that you didn't already know.
export type AmountState = "settled" | "provisional" | "overdue";
export function AmountCell({
  value,
  state = "settled",
  excluded = false,
  delta = null,
  note = null,
  unsigned = false,
  sign = true,
  quiet = false,
  cents = true,
  className = "",
}: {
  value: number;
  state?: AmountState;
  excluded?: boolean; // doesn't count toward totals → an inflow is not green
  delta?: number | null; // paid − expected, when it differs
  note?: string | null; // what the amount is made of ("2 × $369.65"), in the difference's place when there is none
  unsigned?: boolean; // a bill's amount: magnitude only — no sign, and never green
  sign?: boolean;
  quiet?: boolean; // a list where every amount is settled: medium, not semibold
  cents?: boolean; // false: whole dollars (Accounts, where balances run to six and seven figures)
  className?: string;
}) {
  const shown = unsigned ? Math.abs(value) : value;
  const tone =
    state === "overdue"
      ? "font-semibold text-[var(--warn)]"
      : state === "provisional"
        ? "font-medium text-[var(--muted)]"
        : quiet
          ? "font-medium"
          : "font-semibold";
  return (
    // An amount never wraps: the line-breaker treats the minus and the dollar
    // sign as two prefixes and may break between them ("−" / "$12,748.12").
    // On a phone the difference sits under the amount (the column is 96px
    // there); from sm up, beside it. Stacked, the pair is set tight and gives
    // back its extra height, so a row with a difference is as tall as any other.
    <span data-amount-state={state} className={`inline-flex flex-col-reverse items-end whitespace-nowrap tabular-nums sm:flex-row sm:items-baseline sm:justify-end ${delta != null || note ? "max-sm:-my-2 max-sm:leading-4" : ""} ${tone} ${className}`}>
      {delta != null ? (
        <span className="text-[11px] font-medium text-[var(--muted)] max-sm:leading-3 sm:mr-2">
          {delta > 0 ? "+" : "−"}
          {usd(Math.abs(delta), { cents })}
        </span>
      ) : note ? (
        <span data-amount-note className="text-[11px] font-medium text-[var(--muted)] max-sm:leading-3 sm:mr-2">
          {note}
        </span>
      ) : null}
      {state === "settled" && !unsigned ? (
        <Money value={shown} sign={sign} cents={cents} excluded={excluded} />
      ) : (
        <span className={state === "settled" ? "text-[var(--foreground)]" : ""}>{usd(shown, { sign: sign && !unsigned, cents })}</span>
      )}
    </span>
  );
}
