"use client";

import { useState, useSyncExternalStore } from "react";
import { useToast } from "@/components/Toast";
import { combinedLine } from "@/lib/format";

// A phone: below the sm breakpoint, where the header holds the title and the
// picker on one row. Rendered as not-a-phone on the server, then corrected.
const PHONE = "(max-width: 639px)";
function usePhone() {
  return useSyncExternalStore(
    (on) => {
      const q = window.matchMedia(PHONE);
      q.addEventListener("change", on);
      return () => q.removeEventListener("change", on);
    },
    () => window.matchMedia(PHONE).matches,
    () => false
  );
}

export function MonthPicker({
  months,
  value,
  onChange,
  allowAll = false,
}: {
  months: string[];
  value: string;
  onChange: (m: string) => void;
  allowAll?: boolean;
}) {
  // On a phone the month is short ("Oct 2026"): a select is as wide as its
  // longest option ("September 2026"), and at 375px that cut the page title.
  const phone = usePhone();
  if (months.length === 0) return null;
  // The month is the page's frame (the summary card no longer repeats it), so
  // it reads in full and steps with ‹ ›: the norm for a month you move through
  // one at a time. The select stays for jumping far. `months` is newest first;
  // "All months" (Transactions) has no neighbours, so the arrows rest.
  const i = months.indexOf(value);
  const older = i >= 0 ? months[i + 1] : undefined;
  const newer = i > 0 ? months[i - 1] : undefined;
  const step = "btn-ghost tap px-2 disabled:opacity-60";
  return (
    <div className="inline-flex items-center gap-1" data-month-picker>
      <button type="button" className={step} aria-label="Previous month" disabled={!older} onClick={() => older && onChange(older)}>
        ‹
      </button>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Month"
        className="btn-ghost select-caret tap-native cursor-pointer appearance-none py-2 pr-6"
      >
        {allowAll && <option value="">All months</option>}
        {months.map((m) => (
          <option key={m} value={m}>
            {new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", {
              month: phone ? "short" : "long",
              year: "numeric",
              timeZone: "UTC",
            })}
          </option>
        ))}
      </select>
      <button type="button" className={step} aria-label="Next month" disabled={!newer} onClick={() => newer && onChange(newer)}>
        ›
      </button>
    </div>
  );
}

export function SyncBankButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/plaid/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast(`Bank sync failed: ${data.error}`, "error");
      } else {
        const combined = combinedLine(data.combined);
        toast(
          `Synced ${data.inserted} new · ${data.updated} updated${combined ? ` · ${combined}` : ""}`,
          "success"
        );
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="btn-ghost" disabled={busy} onClick={run}>
      {busy ? "Syncing…" : "Sync from bank"}
    </button>
  );
}
