"use client";

import { useState } from "react";
import { CategoryName } from "@/components/CategoryIdentity";
import { PropertyCard } from "@/components/shelf/parts";
import { CommitInput } from "@/components/InlineEdit";
import { AmountCell } from "@/components/RowCells";
import { accountKind } from "@/components/accountLabels";
import { usd, shortDate } from "@/lib/format";
import type { AccountDetail, OwnerValue, TermField } from "@/lib/accounts";

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
  onSetTerms,
  onSetSecuredBy,
  onSetPaidBy,
  onDelete,
  confirmingDelete,
}: {
  data: AccountDetail;
  onSetValue: (v: OwnerValue) => void;
  onRemoveValue: (asOf: string) => void;
  onSetCounted: (counted: boolean) => void;
  onSetTerms: (patch: Partial<Record<TermField, number | string | null>>) => void;
  onSetSecuredBy: (assetId: number | null) => void;
  onSetPaidBy: (vendor: string | null) => void;
  onDelete: () => void;
  confirmingDelete: boolean;
}) {
  const manual = data.origin === "manual";
  const latest = data.history[0];
  const owed = data.side === "liability";
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <PropertyCard
          label={owed ? "owed" : manual ? "value" : "balance"}
          detail={latest?.source === "estimate" ? (owed ? "estimated from payments" : "an estimate") : manual ? "set by you" : "from the bank"}
        >
          <div className="text-[15px] font-semibold tabular-nums">{latest ? usd(latest.amount, { cents: false }) : "—"}</div>
        </PropertyCard>
        <PropertyCard label="as of">
          <div className="text-[15px] font-semibold tabular-nums">{latest ? shortDate(latest.asOf) : "—"}</div>
        </PropertyCard>
      </div>
      <p className="-mt-2 text-[11px] text-[var(--muted)]" data-account-caption>
        {data.counted ? (owed ? "Counted in what's owed" : "Counted in what's owned") : "Not counted in net worth"}
        {data.equity != null && (
          <>
            {" · "}
            <span data-equity>
              equity {usd(data.equity, { cents: false })}, after {data.loans.map((l) => `${usd(l.amount, { cents: false })} owed on ${l.name}`).join(" and ")}
            </span>
          </>
        )}
      </p>

      {data.terms && (data.kind === "loan" || data.kind === "mortgage") && (
        <LoanTermsPanel data={data} onSetTerms={onSetTerms} onSetSecuredBy={onSetSecuredBy} onSetPaidBy={onSetPaidBy} />
      )}

      {manual && (
        <ValueForm
          key={latest?.asOf ?? "new"}
          estimate={!owed && latest?.source === "estimate"}
          estimateOption={!owed}
          title={owed ? "New balance (from a statement)" : "New value"}
          onSave={onSetValue}
        />
      )}

      <div>
        <div className="stat-label mb-2">History</div>
        <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list>
          {data.history.map((h) => (
            <li key={h.asOf} className="flex items-center gap-2 py-2 text-xs" data-account-value>
              <span className="w-14 shrink-0 tabular-nums text-[var(--muted)]">{shortDate(h.asOf)}</span>
              <span className="flex-1 text-[11px] text-[var(--muted)]">
                {h.source === "estimate" ? (owed ? "after a payment" : "estimate") : h.source === "owner" ? "set by you" : ""}
              </span>
              {/* A loan's payment estimates are computed, not removable; the owner's figures are. */}
              {manual && data.history.filter((x) => !(owed && x.source === "estimate")).length > 1 && !(owed && h.source === "estimate") && (
                <button type="button" className="btn-link tap text-[11px]" onClick={() => onRemoveValue(h.asOf)} aria-label={`Remove the ${shortDate(h.asOf)} value`}>
                  Remove
                </button>
              )}
              <AmountCell value={h.amount} sign={false} excluded quiet cents={false} className="w-24 shrink-0" />
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
  estimateOption = true,
  title = "New value",
}: {
  estimate: boolean;
  onSave: (v: OwnerValue) => void;
  submitLabel?: string;
  estimateOption?: boolean; // a loan's figure is a statement's: no estimate box
  title?: string;
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
      <div className="stat-label">{title}</div>
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
        {estimateOption ? (
          <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <input type="checkbox" className="tap" checked={estimate} onChange={(e) => setEstimate(e.target.checked)} />
            An estimate (what it would sell for)
          </label>
        ) : (
          <span />
        )}
        <button type="submit" disabled={!valid} className="btn-ghost text-xs disabled:opacity-50">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

// A loan's terms, each its own editor. The bank fills what it reports (a
// mortgage's rate and payment), marked auto; what the owner sets is marked
// edited and the bank leaves it alone. Clearing a field returns it to the
// bank's, or to unknown. Then the asset the loan is against, for equity.
function LoanTermsPanel({
  data,
  onSetTerms,
  onSetSecuredBy,
  onSetPaidBy,
}: {
  data: AccountDetail;
  onSetTerms: (patch: Partial<Record<TermField, number | string | null>>) => void;
  onSetSecuredBy: (assetId: number | null) => void;
  onSetPaidBy: (vendor: string | null) => void;
}) {
  const payers = data.paidBy && !data.payers.includes(data.paidBy) ? [data.paidBy, ...data.payers] : data.payers;
  const t = data.terms!;
  const tag = (f: TermField) => (t.edited.includes(f) ? true : t[f] != null ? false : undefined);
  const num = (f: TermField) => (raw: string) => {
    const clean = raw.replace(/[$,%\s]/g, "");
    const next = clean === "" ? null : Number(clean);
    if (next !== null && !Number.isFinite(next)) return;
    if (next !== t[f]) onSetTerms({ [f]: next });
  };
  const field = "min-w-0 w-full bg-transparent text-[15px] font-semibold tabular-nums outline-none placeholder:font-normal placeholder:text-[var(--muted)]";
  const date = (f: "maturity" | "opened") => (
    <input
      type="date"
      aria-label={f === "maturity" ? "Payoff date" : "Opened"}
      defaultValue={t[f] ?? ""}
      key={`${f}-${t[f]}`}
      onBlur={(e) => e.target.value !== (t[f] ?? "") && onSetTerms({ [f]: e.target.value || null })}
      className={`tap-native ${field}`}
    />
  );
  return (
    <div className="flex flex-col gap-2" data-loan-terms>
      <div className="stat-label">Terms</div>
      <div className="grid grid-cols-2 gap-2">
        <PropertyCard label="rate" edited={tag("rate")}>
          <div className="flex items-baseline">
            <CommitInput key={`rate-${t.rate}`} aria-label="Rate" inputMode="decimal" placeholder="Add" defaultValue={t.rate == null ? "" : String(t.rate)} onCommit={num("rate")} className={field} />
            {t.rate != null && <span className="text-xs text-[var(--muted)]">%</span>}
          </div>
        </PropertyCard>
        <PropertyCard label="payment" edited={tag("payment")} detail={t.payment != null ? "a month" : undefined}>
          <CommitInput key={`pay-${t.payment}`} aria-label="Monthly payment" inputMode="decimal" placeholder="Add" defaultValue={t.payment == null ? "" : usd(t.payment)} onCommit={num("payment")} className={field} />
        </PropertyCard>
        <PropertyCard label="paid off" edited={tag("maturity")}>{date("maturity")}</PropertyCard>
        <PropertyCard label="borrowed" edited={tag("original") ?? tag("opened")} detail={date("opened")}>
          <CommitInput key={`orig-${t.original}`} aria-label="Amount borrowed" inputMode="decimal" placeholder="Add" defaultValue={t.original == null ? "" : usd(t.original, { cents: false })} onCommit={num("original")} className={field} />
        </PropertyCard>
      </div>
      <label className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
        <span>Against</span>
        <select
          aria-label="What this loan is against"
          value={data.securedBy?.id ?? ""}
          onChange={(e) => onSetSecuredBy(e.target.value ? Number(e.target.value) : null)}
          className="select-caret tap-native cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-2 pl-3 pr-8 text-[13px] text-[var(--foreground)]"
        >
          <option value="">Nothing</option>
          {data.assets.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
      {/* A loan the bank link can't see: its payments, seen leaving a linked
          account, lower its balance between statements. */}
      {data.origin === "manual" && (
        <div className="flex flex-col gap-1">
          <label className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
            <span>Paid by</span>
            <select
              aria-label="Payments to this loan"
              value={data.paidBy ?? ""}
              onChange={(e) => onSetPaidBy(e.target.value || null)}
              className="select-caret tap-native cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-2 pl-3 pr-8 text-[13px] text-[var(--foreground)]"
            >
              <option value="">Nothing</option>
              {payers.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <p className="text-[11px] text-[var(--muted)]" data-paid-by-caption>
            {data.paidBy
              ? t.rate == null
                ? "Add the rate, and each payment will lower the balance."
                : `Each payment to ${data.paidBy} lowers the balance, with interest at the rate. A statement balance you enter resets it.`
              : payers.length
                ? "Pick the charge that pays this loan, and each payment will lower the balance."
                : t.payment == null
                  ? "Add the payment to find the charge that pays this loan."
                  : "No charge near the payment in the last six months."}
          </p>
        </div>
      )}
    </div>
  );
}
