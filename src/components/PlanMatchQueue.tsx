"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "@/components/useMutation";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { postJson } from "@/lib/http";
import { usd, shortDate } from "@/lib/format";
import { dayLabel } from "@/lib/series";
import type { PlanMatch } from "@/lib/planMatch";

// Charges that look like another vendor's bill: the bank named them after a
// different vendor of the household's ("Google" for a Google One charge), but
// the amount and day are that bill's. The confident ones join on their own;
// these are the ones to confirm. One decision per row: "In plan" puts the
// charge in that bill, Dismiss stops asking. Renders nothing when empty.
export function PlanMatchQueue({ onChange, version = 0 }: { onChange?: () => void; version?: number }) {
  const [items, setItems] = useState<PlanMatch[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    setItems(await fetch("/api/plan-matches").then((r) => r.json()));
  }, []);
  const mutate = useMutation(load);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, version]);
  useSyncedRefresh(load);

  async function resolve(m: PlanMatch, action: "accept" | "dismiss") {
    setBusy(m.hash);
    setItems((xs) => xs.filter((x) => x.hash !== m.hash)); // the row leaves: that's the feedback
    const ok = await mutate(
      () => postJson("/api/plan-matches", { action, id: m.id, plan: m.plan, hash: m.hash }),
      { error: "Couldn't update — please try again" },
      { refresh: "error" }
    );
    if (ok && action === "accept") onChange?.();
    setBusy(null);
  }

  if (!items.length) return null;
  return (
    <div className="card mb-4 p-4" data-plan-match-queue>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[15px] font-semibold">Charges that look like another bill</span>
        <span className="rounded-full bg-[var(--muted)]/15 px-2 py-1 text-xs text-[var(--muted)]">{items.length}</span>
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">
        The bank named these after another of your vendors, but each matches a bill&apos;s amount and day.
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((m) => (
          <li key={m.hash} className="flex items-start justify-between gap-3 rounded-lg border border-[var(--border)] p-3" data-plan-match>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                {m.merchant} · {usd(-m.amount)} · {shortDate(m.date)}
              </div>
              <div className="mt-1 text-xs text-[var(--muted)]">
                Belongs to <span className="font-medium text-[var(--foreground)]">{m.vendor}</span> ({usd(-m.planAmount)} monthly, the {dayLabel(m.day)})?
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" className="btn-ghost text-xs disabled:opacity-50" disabled={busy === m.hash} onClick={() => resolve(m, "accept")}>
                In plan
              </button>
              <button
                type="button"
                className="tap rounded-lg px-2 text-xs text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                disabled={busy === m.hash}
                onClick={() => resolve(m, "dismiss")}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
