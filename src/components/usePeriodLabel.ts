"use client";

import { useEffect, useState } from "react";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";

// The period a page's figures cover, said once, in the header beside the
// month picker: "Oct 1–4" while the month runs, "Sep 1–30" once it's done,
// so no figure, card or row has to say "so far" (DESIGN.md §2).
export function usePeriodLabel(month: string, version: unknown = 0): string | undefined {
  const [through, setThrough] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useSyncedRefresh(() => setTick((t) => t + 1));
  useEffect(() => {
    if (!month) return;
    let live = true;
    fetch(`/api/period?month=${month}`)
      .then((r) => r.json())
      .then((d) => live && setThrough(typeof d.through === "number" ? d.through : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [month, version, tick]);
  if (!month || through == null) return undefined;
  const name = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  if (through === 0) return `${name} · nothing yet`;
  return through === 1 ? `${name} 1` : `${name} 1–${through}`;
}
