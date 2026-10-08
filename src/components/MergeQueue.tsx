"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@/components/useMutation";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { postJson } from "@/lib/http";
import { usd, shortDate } from "@/lib/format";
import type { MergeSuggestion } from "@/lib/merges";

type PreviewTx = { date: string; amount: number; account: string };

// The "possible duplicate vendors" review queue: same vendor under different
// bank descriptors (a location suffix, a rename, or just punctuation). Combining
// folds the descriptors into one vendor so recurring detection, totals, and
// display line up. Self-contained — fetches /api/merges and handles approve /
// dismiss. `onChange` lets the host page refresh its own data after a combine
// (which can re-stamp recurringId and fill a category). Renders nothing when the
// queue is empty, so it's safe to drop into any page.
// The names a card folds in, and the vendor they fold into (when it has
// charges of its own under that name).
const strays = (g: MergeSuggestion) => g.variants.filter((v) => v.merchant !== g.canonical);
const target = (g: MergeSuggestion) => g.variants.find((v) => v.merchant === g.canonical);
// The model's card joins every name it paired, so one wrong name ("Apple
// Store" among Apple's bills) is left out on its own: its pairs on the card
// are dismissed, and the rest stay one Combine. Keys are "ai:<a>|<b>".
const pairKeysOf = (g: MergeSuggestion, merchant: string) =>
  g.dismissKeys.filter((k) => k.startsWith("ai:") && k.slice(3).split("|").includes(merchant));

export function MergeQueue({ onChange, version = 0 }: { onChange?: () => void; version?: number }) {
  const [merges, setMerges] = useState<MergeSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // expanded card key
  const [previews, setPreviews] = useState<Record<string, Record<string, PreviewTx[]>>>({});

  const load = useCallback(async () => {
    const data = await fetch("/api/merges").then((r) => r.json());
    setMerges(data);
  }, []);
  const mutate = useMutation(load);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, version]); // `version`: re-read when the page behind this queue changes
  useSyncedRefresh(load);
  // The model is asked without a press, once per visit, about the close-named
  // vendors nobody has asked about; what it is sure of joins the queue. A
  // failure is quiet: the rules' cards stand, and the next visit asks again.
  const judged = useRef(false);
  useEffect(() => {
    if (judged.current) return;
    judged.current = true;
    postJson("/api/merges", { action: "judge" })
      .then((r) => {
        if ((r as { answered?: number }).answered) load();
      })
      .catch(() => {});
  }, [load]);

  async function resolve(g: MergeSuggestion, action: "approve" | "dismiss") {
    setBusy(g.key);
    setMerges((ms) => ms.filter((m) => m.key !== g.key)); // optimistic
    const ok = await mutate(
      () =>
        postJson("/api/merges", {
          action,
          keys: g.dismissKeys,
          canonical: g.canonical,
          variants: g.variants.map((v) => v.merchant),
          categoryId: g.categoryId,
        }),
      {
        success: action === "approve" ? `Combined into “${g.canonical}”` : undefined,
        error: "Couldn't update — please try again",
      },
      { refresh: "error" } // restore the optimistic removal on failure
    );
    if (ok && action === "approve") onChange?.();
    setBusy(null);
  }

  async function leaveOut(g: MergeSuggestion, merchant: string) {
    setBusy(g.key);
    await mutate(() => postJson("/api/merges", { action: "dismiss", keys: pairKeysOf(g, merchant) }), {
      error: "Couldn't update — please try again",
    });
    setBusy(null);
  }

  async function toggle(g: MergeSuggestion) {
    if (open === g.key) {
      setOpen(null);
      return;
    }
    setOpen(g.key);
    if (!previews[g.key]) {
      try {
        const data = (await postJson("/api/merges/preview", {
          merchants: g.variants.map((v) => v.merchant),
        })) as Record<string, PreviewTx[]>;
        setPreviews((p) => ({ ...p, [g.key]: data }));
      } catch {
        /* leave unexpanded preview empty; the row still shows */
      }
    }
  }

  if (merges.length === 0) return null;

  return (
    <div className="card mb-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[15px] font-semibold">Possible duplicate vendors</span>
        <span className="rounded-full bg-[var(--muted)]/15 px-2 py-1 text-xs text-[var(--muted)]">
          {merges.length}
        </span>
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Same vendor posting under different bank descriptors — a location suffix,
        a rename, or just punctuation. Combine to fix recurring detection and
        totals, or dismiss.
      </p>
      <ul className="flex flex-col gap-2">
        {merges.map((g) => (
          <li key={g.key} className="rounded-lg border border-[var(--border)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggle(g)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(g)}
                className="min-w-0 cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{g.canonical}</span>
                  {g.source === "model" && (
                    // The category queue's tag for a model's proposal; the note says its reason.
                    <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-2 text-[11px] font-medium text-[var(--accent)]" data-merge-source="model">
                      AI
                    </span>
                  )}
                  {g.lowConfidence && (
                    <span className="rounded-full bg-[var(--warn)]/15 px-2 py-1 text-[11px] font-medium text-[var(--warn)]">
                      possible match
                    </span>
                  )}
                </div>
                {/* The direction, said on the card: the title is the vendor
                    the others fold into, and listing it among them read as a
                    choice between equals. */}
                <div className="mt-1 text-xs text-[var(--muted)]" data-merge-direction>
                  Combine {strays(g).map((v) => `${v.merchant} (${v.count})`).join(" · ")} into{" "}
                  <span className="font-medium text-[var(--foreground)]">{g.canonical}</span>
                  {target(g) && ` (${target(g)!.count})`}
                </div>
                {g.note && (
                  <div
                    className={`mt-1 text-xs ${
                      g.lowConfidence ? "text-[var(--warn)]" : "text-[var(--accent)]"
                    }`}
                  >
                    {g.note}
                  </div>
                )}
                <div className="mt-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                  {open === g.key ? "▾ Hide transactions" : "▸ Inspect transactions"}
                </div>
              </div>
              {/* A queue is a list of the same decision many times, so its accept
                  can't be the page's primary (DESIGN.md: at most one per page) —
                  four cards put four filled buttons on the Transactions page.
                  Accept is secondary; Dismiss is quiet text, so the pair still
                  ranks. The three queues share this. */}
              <div className="flex shrink-0 items-center gap-2">
                <button
                  disabled={busy === g.key}
                  onClick={() => resolve(g, "approve")}
                  aria-label={`Combine ${strays(g).map((v) => v.merchant).join(", ")} into ${g.canonical}`}
                  data-queue-accept
                  className="btn-ghost text-xs disabled:opacity-50"
                >
                  Combine
                </button>
                <button
                  disabled={busy === g.key}
                  onClick={() => resolve(g, "dismiss")}
                  data-queue-dismiss
                  className="tap rounded-lg px-2 text-xs text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </div>

            {open === g.key && (
              <div className="mt-3 flex flex-col gap-3 border-t border-dashed border-[var(--border)] pt-3">
                {g.variants.map((v) => {
                  const txs = previews[g.key]?.[v.merchant];
                  return (
                    <div key={v.merchant}>
                      <div className="flex items-baseline justify-between gap-3 text-xs font-medium">
                        <span>
                          {v.merchant} <span className="text-[var(--muted)]">({v.count})</span>
                        </span>
                        {g.source === "model" && strays(g).length > 1 && v.merchant !== g.canonical && (
                          <button
                            disabled={busy === g.key}
                            onClick={() => leaveOut(g, v.merchant)}
                            aria-label={`Leave ${v.merchant} out of this combine`}
                            data-merge-leave-out={v.merchant}
                            className="tap shrink-0 font-normal text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                          >
                            Leave out
                          </button>
                        )}
                      </div>
                      {!previews[g.key] ? (
                        <div className="mt-1 text-xs text-[var(--muted)]">Loading…</div>
                      ) : txs && txs.length > 0 ? (
                        <div className="mt-1 flex flex-col gap-1">
                          {txs.map((t, i) => (
                            <div
                              key={i}
                              className="flex justify-between gap-3 text-xs tabular-nums text-[var(--muted)]"
                            >
                              <span className="truncate">
                                {shortDate(t.date)} · {t.account}
                              </span>
                              <span className="shrink-0">{usd(t.amount, { sign: true })}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs text-[var(--muted)]">No recent charges.</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
