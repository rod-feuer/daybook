// The ↻ glyph, with one meaning: this charge is in a plan.
//   "in"   — this charge is part of a plan (grey: a mark, not a signal; the
//            accent is never semantic, and on every row of a list it shouted)
//   "out"  — the vendor has a plan, but the user took this charge out. In a
//            row this renders nothing: a charge outside a plan is outside it,
//            whoever decided, and a struck ↻ read as a broken subscription
//            beside the iPhone purchase that showed no glyph at all. The
//            shelf's pill says "Not in plan · edited" for the record.
//   "none" — not recurring: renders nothing, unless a toggle is offered, then a
//            faint affordance (the shelf's row gutter)
// With `onToggle` it is a button acting on the whole vendor; without, a passive
// indicator. Every surface that shows the glyph uses this, so "out" reads the
// same on the dashboard, the transactions row, and the shelf — before, only the
// transactions row knew the state.
export type RecurringState = "in" | "out" | "none";

export function recurringState(t: { recurringId: number | null; recurringExcluded?: number | boolean | null }): RecurringState {
  return t.recurringId != null ? "in" : t.recurringExcluded ? "out" : "none";
}

export const RECURRING_LABEL: Record<RecurringState, string> = {
  in: "In a plan",
  out: "Taken out of its plan",
  none: "Not recurring",
};

export function RecurringGlyph({
  state,
  onToggle,
  className = "",
}: {
  state: RecurringState;
  onToggle?: () => void; // vendor-level force / mute
  className?: string;
}) {
  const tone = "text-[var(--muted)]";
  if (onToggle) {
    const rest = state === "none" ? "opacity-60 focus-visible:opacity-100 group-hover:opacity-100" : "opacity-100";
    return (
      <button
        type="button"
        data-recurring={state}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-label={state === "in" ? "Mark vendor not recurring" : "Mark vendor recurring"}
        className={`text-center transition-opacity hover:text-[var(--foreground)] ${tone} ${rest} ${className}`.trim()}
      >
        ↻
      </button>
    );
  }
  if (state !== "in") return null;
  return (
    <span data-recurring={state} role="img" aria-label={RECURRING_LABEL[state]} className={`${tone} ${className}`.trim()}>
      ↻
    </span>
  );
}
