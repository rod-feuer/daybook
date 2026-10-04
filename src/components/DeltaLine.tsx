import { usd } from "@/lib/format";

// Month-over-month change under a figure, as "▲ $abs (%)": dollars answer "how
// much", percent answers "how unusual". The percent is omitted when the base is
// zero or the sign flips (where a % would mislead), which only arises for net.
// Muted, since the verdict is the card's one colour signal (DESIGN.md §2); the
// arrow says the direction, and the basis is the header's.
export function DeltaLine({
  cur,
  prev,
  prevLabel,
}: {
  cur: number;
  prev: number | undefined;
  prevLabel: string | null | undefined;
}) {
  if (prev === undefined || !prevLabel) return null;
  const change = cur - prev;
  if (Math.round(change) === 0) {
    return (
      <div className="mt-1 text-xs font-medium text-[var(--muted)]">
        No change
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
    // The basis ("vs Sep 1–4") is the header's, said once for all three.
    <div className="mt-1 flex flex-wrap items-center gap-x-1 text-xs font-medium text-[var(--muted)]">
      <span className="whitespace-nowrap">
        {up ? "▲" : "▼"} {dollars}
        {pct}
      </span>
    </div>
  );
}
