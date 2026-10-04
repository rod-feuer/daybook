"use client";

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { AmountCell } from "@/components/RowCells";
import { SummaryCard } from "@/components/SummaryCard";
import { LoadError, LoadingRows } from "@/components/LoadState";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { useAccountShelf, useShelfActive } from "@/components/TransactionDrawer";
import { ValueForm } from "@/components/shelf/AccountShelf";
import { KIND_LABEL, accountKind, accountWhen } from "@/components/accountLabels";
import { rowButtonProps, ROW_FOCUS } from "@/components/rowButton";
import { useMutation } from "@/components/useMutation";
import { getJson, postJson } from "@/lib/http";
import { usd, shortDate } from "@/lib/format";
import type { NetWorth } from "@/lib/accounts";
import { MANUAL_KINDS, type ManualKind } from "@/lib/accountKinds";

type Data = NetWorth & { today: string };
type Account = NetWorth["accounts"][number];

// Assets first, then what's owed, the order net worth subtracts in.
const SECTIONS: { title: string; kinds: Account["kind"][] }[] = [
  { title: "Cash", kinds: ["cash"] },
  { title: "Investments", kinds: ["investment"] },
  { title: "Homes & vehicles", kinds: ["property", "vehicle"] },
  { title: "Other", kinds: ["other"] },
  { title: "Cards", kinds: ["card"] },
  { title: "Loans", kinds: ["mortgage", "loan"] },
];

// Accounts (POSITIONING §12, layer 1): where the household stands, not where
// the month is heading. A position, so the header says the day it's as of in
// place of a month picker, and the card has figures but no bar.
export default function AccountsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [adding, setAdding] = useState(false);
  const openAccount = useAccountShelf();
  const shelf = useShelfActive();

  const load = useCallback(async () => {
    try {
      setData(await getJson<Data>("/api/net-worth"));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);
  useSyncedRefresh(() => void load());
  const mutate = useMutation(load);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The day the figures are as of: the newest balance. An account that hasn't
  // reported since says its own date on its row.
  const latest = data?.accounts.reduce((m, a) => (a.asOf > m ? a.asOf : m), "") || null;
  const today = data?.today ?? new Date().toISOString().slice(0, 10);
  const counted = data?.accounts.filter((a) => a.counted) ?? [];
  const uncounted = data?.accounts.filter((a) => !a.counted) ?? [];
  // A mortgage counts but its home has no value yet: net worth would read as
  // the debt alone, so it waits, and says why (Honest: withhold, don't overstate).
  const waitsForHomes =
    counted.some((a) => a.kind === "mortgage") && !counted.some((a) => a.kind === "property");
  const row = (a: Account) => (
    <AccountRow
      key={a.id}
      a={a}
      when={accountWhen(a, latest, today)}
      active={shelf.isAccount(a.id)}
      onOpen={() => openAccount(a.id, { onChange: () => void load() })}
    />
  );

  return (
    <Shell
      title="Accounts"
      subtitle={latest ? `As of ${shortDate(latest)}` : undefined}
      actions={<button type="button" onClick={() => setAdding((v) => !v)} className="btn-ghost">Add account</button>}
    >
      {adding && (
        <AddAccount
          onClose={() => setAdding(false)}
          onAdd={async (body) => {
            if (await mutate(() => postJson("/api/net-worth/accounts", body), { error: "Couldn't add the account — please try again" })) setAdding(false);
          }}
        />
      )}
      {status === "loading" ? (
        <LoadingRows />
      ) : status === "error" ? (
        <LoadError what="accounts" onRetry={() => { setStatus("loading"); void load(); }} />
      ) : !data || data.accounts.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-[13px] text-[var(--muted)]">
            No balances yet. Daybook records each account&apos;s balance every time it syncs with your bank; add a home
            or anything else it can&apos;t see with Add account.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <SummaryCard
            primary={{ value: waitsForHomes ? "—" : usd(data.net, { cents: false }), label: "Net worth" }}
            secondary={[
              { value: usd(data.owned, { cents: false }), label: "Owned" },
              { value: usd(data.owed, { cents: false }), label: "Owed" },
            ]}
            status={waitsForHomes ? "Waiting for home values" : undefined}
            statusDetail={waitsForHomes ? <span className="text-[var(--muted)]">the mortgages count; the homes don&apos;t yet</span> : undefined}
          />
          {SECTIONS.map((s) => {
            const rows = counted.filter((a) => s.kinds.includes(a.kind));
            return rows.length === 0 ? null : (
              <section key={s.title} className="flex flex-col gap-2" data-account-section>
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{s.title}</h3>
                <div className="card divide-y divide-[var(--border)] overflow-hidden">{rows.map(row)}</div>
              </section>
            );
          })}
          {/* Left out of net worth, but here, so it can be counted again. */}
          {uncounted.length > 0 && (
            <section className="flex flex-col gap-2" data-account-section="uncounted">
              <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Not counted</h3>
              <div className="card divide-y divide-[var(--border)] overflow-hidden">{uncounted.map(row)}</div>
            </section>
          )}
        </div>
      )}
    </Shell>
  );
}

function AccountRow({ a, when, active, onOpen }: { a: Account; when: string | null; active: boolean; onOpen: () => void }) {
  const meta = [accountKind(a), when].filter(Boolean).join(" · ");
  return (
    <div
      data-drawer-row
      data-account-row
      {...rowButtonProps(onOpen)}
      className={`flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-[var(--hover)] sm:py-2 ${ROW_FOCUS} ${active ? "bg-[var(--accent)]/10" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{a.name}</div>
        {meta && <div className="truncate text-xs text-[var(--muted)]">{meta}</div>}
      </div>
      {/* A card's or loan's balance is what's owed; none of these is an inflow. */}
      <AmountCell value={a.amount} sign={false} excluded quiet className="w-28 shrink-0" />
    </div>
  );
}

// Add an account Daybook can't see from the bank: a home, a vehicle, an
// unlinked account. Inline, like New category; its first value is required,
// since an account with none would have nothing to show.
function AddAccount({ onAdd, onClose }: { onAdd: (body: { name: string; kind: ManualKind; amount: number; asOf: string; estimate: boolean }) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ManualKind>("property");
  return (
    <div className="card mb-6 flex flex-col gap-3 p-4" data-add-account>
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold">Add account</h3>
        <button type="button" onClick={onClose} className="tap rounded-lg px-2 py-1 text-[var(--muted)] hover:bg-[var(--hover)]" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="flex gap-2">
        <input
          autoFocus
          aria-label="Name"
          placeholder="Name (e.g. Lake house)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="tap-native min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-card px-3 py-2 text-[13px]"
        />
        <select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ManualKind)}
          className="select-caret tap-native cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-2 pl-3 pr-8 text-[13px]"
        >
          {MANUAL_KINDS.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>
      {/* A home's or a vehicle's worth is an estimate; a balance off a statement isn't. */}
      <ValueForm
        key={kind}
        estimate={kind === "property" || kind === "vehicle"}
        submitLabel="Add"
        ready={!!name.trim()}
        onSave={(v) => onAdd({ name: name.trim(), kind, ...v })}
      />
    </div>
  );
}
