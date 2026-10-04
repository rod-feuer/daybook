"use client";

import { useState } from "react";
import { CategoryName } from "@/components/CategoryIdentity";
import { PropertyCard } from "@/components/shelf/parts";
import { AmountCell } from "@/components/RowCells";
import { accountKind } from "@/components/accountLabels";
import { usd, shortDate } from "@/lib/format";
import type { AccountDetail, OwnerValue } from "@/lib/accounts";

// The account shelf (layer 1): one account, its value and where it came
// from, its history, and the verbs it takes. A linked account's balance is
// the bank's, so it can be renamed and counted or not, never valued or
// deleted; one kept by hand takes all four.
export function AccountHeader({ data, onRename }: { data: AccountDetail | null; onRename: (name: string) => void }) {
  if (!data) return <div className="truncate text-[15px] font-semibold">…</div>;
  const latest = data.history[0];
  return (
    <div data-account-identity>
      <CategoryName name={data.name} onRename={onRename} textClassName="text-[15px] font-semibold" />
      <div className="text-xs text-[var(--muted)]">
        {[latest && accountKind({ ...data, source: latest.source, asOf: latest.asOf }), data.origin === "plaid" ? "from the bank" : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </div>
  );
}

export function AccountBody({
  data,
  onSetValue,
  onRemoveValue,
  onSetCounted,
  onDelete,
  confirmingDelete,
}: {
  data: AccountDetail;
  onSetValue: (v: OwnerValue) => void;
  onRemoveValue: (asOf: string) => void;
  onSetCounted: (counted: boolean) => void;
  onDelete: () => void;
  confirmingDelete: boolean;
}) {
  const manual = data.origin === "manual";
  const latest = data.history[0];
  const owed = data.side === "liability";
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <PropertyCard label={owed ? "owed" : manual ? "value" : "balance"} detail={latest?.source === "estimate" ? "an estimate" : manual ? "set by you" : "from the bank"}>
          <div className="text-[15px] font-semibold tabular-nums">{latest ? usd(latest.amount) : "—"}</div>
        </PropertyCard>
        <PropertyCard label="as of">
          <div className="text-[15px] font-semibold tabular-nums">{latest ? shortDate(latest.asOf) : "—"}</div>
        </PropertyCard>
      </div>
      <p className="-mt-2 text-[11px] text-[var(--muted)]" data-account-caption>
        {data.counted ? (owed ? "Counted in what's owed" : "Counted in what's owned") : "Not counted in net worth"}
      </p>

      {manual && <ValueForm key={latest?.asOf ?? "new"} estimate={latest?.source === "estimate"} onSave={onSetValue} />}

      <div>
        <div className="stat-label mb-2">History</div>
        <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list>
          {data.history.map((h) => (
            <li key={h.asOf} className="flex items-center gap-2 py-2 text-xs" data-account-value>
              <span className="w-14 shrink-0 tabular-nums text-[var(--muted)]">{shortDate(h.asOf)}</span>
              <span className="flex-1 text-[11px] text-[var(--muted)]">{h.source === "estimate" ? "estimate" : h.source === "owner" ? "set by you" : ""}</span>
              {manual && data.history.length > 1 && (
                <button type="button" className="btn-link tap text-[11px]" onClick={() => onRemoveValue(h.asOf)} aria-label={`Remove the ${shortDate(h.asOf)} value`}>
                  Remove
                </button>
              )}
              <AmountCell value={h.amount} sign={false} excluded quiet className="w-24 shrink-0" />
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={() => onSetCounted(!data.counted)} className="btn-ghost flex-1 text-xs">
          {data.counted ? "Leave out of net worth" : "Count in net worth"}
        </button>
        {manual && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${data.name}`}
            className={`btn-ghost flex-1 text-xs text-[var(--bad)] ${confirmingDelete ? "font-semibold" : ""}`}
          >
            {confirmingDelete ? "Confirm delete?" : "Delete account"}
          </button>
        )}
      </div>
    </div>
  );
}

// A new dated value: the amount, the day it's as of (today unless changed),
// and whether it's an estimate (a home's worth) or a figure read off a
// statement. A value on a day that already has one replaces it.
export function ValueForm({
  estimate: est,
  onSave,
  submitLabel = "Save value",
  ready = true,
}: {
  estimate: boolean;
  onSave: (v: OwnerValue) => void;
  submitLabel?: string;
  ready?: boolean; // the rest of the form around it is filled in (Add account's name)
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState(today);
  const [estimate, setEstimate] = useState(est);
  const n = Number(amount.replace(/[$,\s]/g, ""));
  const valid = ready && amount.trim() !== "" && Number.isFinite(n) && n >= 0 && asOf <= today;
  return (
    <form
      className="flex flex-col gap-2"
      data-value-form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSave({ amount: n, asOf, estimate });
        setAmount("");
      }}
    >
      <div className="stat-label">New value</div>
      <div className="flex gap-2">
        <label className="flex min-w-0 flex-1 items-center rounded-lg border border-[var(--border)] bg-card px-3 focus-within:ring-2 focus-within:ring-[var(--accent)]/30">
          <span className="text-[13px] text-[var(--muted)]">$</span>
          <input
            inputMode="decimal"
            aria-label="Value"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="tap-native min-w-0 flex-1 bg-transparent py-2 pl-1 text-[13px] tabular-nums outline-none"
          />
        </label>
        <input
          type="date"
          aria-label="As of"
          value={asOf}
          max={today}
          onChange={(e) => setAsOf(e.target.value)}
          className="tap-native rounded-lg border border-[var(--border)] bg-card px-2 py-2 text-[13px] tabular-nums"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <input type="checkbox" className="tap" checked={estimate} onChange={(e) => setEstimate(e.target.checked)} />
          An estimate (what it would sell for)
        </label>
        <button type="submit" disabled={!valid} className="btn-ghost text-xs disabled:opacity-50">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
