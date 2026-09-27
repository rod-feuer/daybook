"use client";

import { useRef, useState } from "react";
import { useToast } from "@/components/Toast";

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
              month: "long",
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

export function ImportButton({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function handle(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      const res = await fetch("/api/import", { method: "POST", body: text });
      const data = await res.json();
      if (!res.ok) {
        toast(`Import failed: ${data.error}`, "error");
      } else {
        toast(
          `Imported ${data.inserted} new · ${data.duplicates} duplicates skipped · ${data.errors} errored`,
          "success"
        );
        onDone();
      }
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  return (
    <>
      <input
        suppressHydrationWarning // iOS Chrome's autofill tag; see SearchBox
        ref={ref}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handle(e.target.files[0])}
      />
      <button className="btn-ghost" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? "Importing…" : "Import CSV"}
      </button>
    </>
  );
}

export function SeedButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await fetch("/api/seed", { method: "POST" });
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="btn-primary" disabled={busy} onClick={run}>
      {busy ? "Loading…" : "Load sample data"}
    </button>
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
        toast(
          `Synced ${data.inserted} new · ${data.updated} updated`,
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
