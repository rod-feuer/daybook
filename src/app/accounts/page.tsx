"use client";

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { AmountCell } from "@/components/RowCells";
import { SummaryCard } from "@/components/SummaryCard";
import { LoadError, LoadingRows } from "@/components/LoadState";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { getJson } from "@/lib/http";
import { usd, shortDate } from "@/lib/format";
import type { NetWorth } from "@/lib/accounts";

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

  const load = useCallback(async () => {
    try {
      setData(await getJson<Data>("/api/net-worth"));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);
  useSyncedRefresh(() => void load());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The day the figures are as of: the newest balance. An account that hasn't
  // reported since says its own date on its row.
  const latest = data?.accounts.reduce((m, a) => (a.asOf > m ? a.asOf : m), "") || null;
  // A mortgage counts but its home has no value yet: net worth would read as
  // the debt alone, so it waits, and says why (Honest: withhold, don't overstate).
  const waitsForHomes =
    !!data && data.accounts.some((a) => a.kind === "mortgage") && !data.accounts.some((a) => a.kind === "property");

  return (
    <Shell title="Accounts" subtitle={latest ? `As of ${shortDate(latest)}` : undefined}>
      {status === "loading" ? (
        <LoadingRows />
      ) : status === "error" ? (
        <LoadError what="accounts" onRetry={() => { setStatus("loading"); void load(); }} />
      ) : !data || data.accounts.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-[13px] text-[var(--muted)]">
            No balances yet. Daybook records each account&apos;s balance every time it syncs with your bank.
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
            const rows = data.accounts.filter((a) => s.kinds.includes(a.kind));
            return rows.length === 0 ? null : (
              <section key={s.title} className="flex flex-col gap-2" data-account-section>
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{s.title}</h3>
                <div className="card divide-y divide-[var(--border)] overflow-hidden">
                  {rows.map((a) => (
                    <AccountRow key={a.id} a={a} stale={a.asOf !== latest} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

// Plaid's subtypes are lower case; a few are initialisms.
const SUBTYPE: Record<string, string> = { ira: "IRA", roth: "Roth IRA", "401k": "401(k)", "403b": "403(b)", "457b": "457(b)", hsa: "HSA", "529": "529 plan", cd: "CD" };
function subtypeLabel(s: string | null): string | null {
  return s ? (SUBTYPE[s] ?? s.charAt(0).toUpperCase() + s.slice(1)) : null;
}

function AccountRow({ a, stale }: { a: Account; stale: boolean }) {
  const kind = subtypeLabel(a.subtype);
  const meta = [kind && a.mask ? `${kind} ··${a.mask}` : kind, stale ? `as of ${shortDate(a.asOf)}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:py-2" data-account-row>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{a.name}</div>
        {meta && <div className="truncate text-xs text-[var(--muted)]">{meta}</div>}
      </div>
      {/* Every balance here is the bank's, settled; a card's or loan's is what's owed. */}
      <AmountCell value={a.amount} sign={false} excluded quiet className="w-28 shrink-0" />
    </div>
  );
}
