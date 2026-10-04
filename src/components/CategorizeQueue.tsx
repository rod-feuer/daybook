"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@/components/useMutation";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { postJson } from "@/lib/http";
import { CategoryProperty } from "@/components/RowCells";
import type { CategorySuggestion, DeferredToMerge } from "@/lib/categorizeSuggest";
import type { Category } from "@/lib/types";

// A proposal the user may have redirected: the category to apply is the
// row's current choice, and a redirected one says so.
type Proposal = CategorySuggestion & { edited?: boolean };

// "Suggested categories" — reviewable proposals for uncategorized vendors instead
// of a blind Auto-categorize button. Rules/history load free; the model's guesses
// are fetched on demand and badged "AI" so they get a look before they're
// committed (Rule 5). Apply learns the choice as a rule. Renders nothing when
// everything's categorized.
export function CategorizeQueue({
  onChange,
  onShowUncategorized,
  version = 0,
}: {
  onChange?: () => void;
  onShowUncategorized?: () => void; // filter the list below to the uncategorized charges
  version?: number; // the page's refresh counter: a charge categorized in the list below empties this queue too
}) {
  // What the server proposes, and the categories the user picked on rows not
  // yet applied (vendor -> category). Picks are kept apart so that a reload —
  // after another row's Apply, a Combine, a sync — can't wipe them: it
  // replaced the whole list, and every unapplied pick went back to the
  // proposal.
  const [loaded, setItems] = useState<Proposal[]>([]);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [cats, setCats] = useState<Category[]>([]);
  const [needsModel, setNeedsModel] = useState(0);
  // The model is asked without a press: a suggestion you have to click to see
  // is a suggestion you mostly don't see. "asking" while it runs; "failed" if
  // it could not be reached, said in place (not a toast on every page load).
  const [ask, setAsk] = useState<"idle" | "asking" | "failed">("idle");
  const askedFor = useRef<string>("");
  const [dismissedCount, setDismissedCount] = useState(0);
  const [deferred, setDeferred] = useState<DeferredToMerge[]>([]);
  const [modelEnabled, setModelEnabled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, cs] = await Promise.all([
      fetch("/api/category-suggestions").then((r) => r.json()),
      fetch("/api/categories").then((r) => r.json()),
    ]);
    setItems(d.suggestions);
    setCats(cs);
    setNeedsModel(d.needsModelCount);
    setDismissedCount(d.dismissedCount ?? 0);
    setDeferred(d.deferred ?? []);
    setModelEnabled(d.modelEnabled);
    return d as { needsModelCount: number; modelEnabled: boolean };
  }, []);
  // Ask about the vendors nobody has asked about yet, then read again: the
  // answers are remembered server-side, so the second read carries them. Once
  // per distinct count, so a failure or an unanswerable vendor can't loop.
  const askModel = useCallback(
    async (count: number) => {
      askedFor.current = String(count);
      setAsk("asking");
      try {
        const res = await fetch("/api/category-suggestions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "suggestAI" }) });
        if (!res.ok) throw new Error(String(res.status));
        await load();
        setAsk("idle");
      } catch {
        setAsk("failed");
      }
    },
    [load]
  );
  // Redirect a proposal: the row keeps the vendor, takes the chosen category,
  // and Apply (or Apply all) commits that choice. Uncategorized is not a
  // choice here — that is Dismiss.
  function redirect(merchant: string, categoryId: number | null) {
    if (!cats.some((x) => x.id === categoryId)) return;
    setPicks((p) => ({ ...p, [merchant]: categoryId! }));
  }
  const unpick = (merchants: string[]) =>
    setPicks((p) => Object.fromEntries(Object.entries(p).filter(([m]) => !merchants.includes(m))));
  // Each row as shown: the user's pick over the proposal, marked edited.
  const items = loaded.map((x) => {
    const c = picks[x.merchant] != null ? cats.find((k) => k.id === picks[x.merchant]) : undefined;
    return c ? { ...x, categoryId: c.id, categoryName: c.name, categoryIcon: c.icon, edited: true } : x;
  });
  const mutate = useMutation(load);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, version]); // `version`: re-read when the page behind this queue changes
  useSyncedRefresh(load);
  // Whenever a read leaves vendors nobody has asked about, ask.
  useEffect(() => {
    if (modelEnabled && needsModel > 0 && ask === "idle" && askedFor.current !== String(needsModel)) void askModel(needsModel);
  }, [modelEnabled, needsModel, ask, askModel]);

  async function apply(s: CategorySuggestion) {
    setBusy(s.merchant);
    setItems((a) => a.filter((x) => x.merchant !== s.merchant)); // optimistic
    unpick([s.merchant]);
    const ok = await mutate(
      () =>
        postJson("/api/category-suggestions", { action: "apply", merchant: s.merchant, categoryId: s.categoryId }),
      { error: "Couldn't categorize — please try again" }, // the row leaving is the confirmation
      { refresh: "error" } // restore the optimistic removal on failure
    );
    if (ok) onChange?.();
    setBusy(null);
  }

  async function dismiss(s: CategorySuggestion) {
    setItems((a) => a.filter((x) => x.merchant !== s.merchant)); // optimistic
    unpick([s.merchant]);
    await mutate(
      () => postJson("/api/category-suggestions", { action: "dismiss", merchant: s.merchant }),
      { error: "Couldn't dismiss — please try again" },
      { refresh: "error" }
    );
  }

  // Dismissed vendors come back into the queue; the count line says how
  // many are waiting, so a Dismiss is never a silent, permanent hide.
  async function undismissAll() {
    await mutate(
      () => postJson("/api/category-suggestions", { action: "undismissAll" }),
      { success: "Dismissed vendors are back in the queue", error: "Couldn't bring them back — please try again" },
      { refresh: "always" }
    );
  }

  // Apply all commits what is sure. A possible match or a guess is a question to
  // the user, so it waits for its own Apply — unless they already redirected
  // it, which is their answer.
  const sure = items.filter((s) => (!s.possible && !s.guess) || s.edited);
  async function applyAll() {
    setBusy("__all");
    const batch = sure.map((s) => ({ merchant: s.merchant, categoryId: s.categoryId }));
    const done = batch.map((b) => b.merchant);
    setItems((a) => a.filter((s) => !done.includes(s.merchant))); // optimistic
    unpick(done);
    const ok = await mutate(
      () => postJson("/api/category-suggestions", { action: "applyAll", items: batch }),
      {
        success: `Categorized ${batch.length} vendor${batch.length === 1 ? "" : "s"}`,
        error: "Couldn't categorize — please try again",
      },
      { refresh: "error" }
    );
    if (ok) onChange?.();
    setBusy(null);
  }

  if (items.length === 0 && needsModel === 0 && dismissedCount === 0 && deferred.length === 0) return null;

  return (
    <div className="card mb-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[15px] font-semibold">Suggested categories</span>
        {items.length > 0 && (
          <span className="rounded-full bg-[var(--muted)]/15 px-2 py-1 text-xs text-[var(--muted)]">
            {items.length}
          </span>
        )}
        {sure.length > 0 && (
          <button onClick={applyAll} disabled={busy != null} className="btn-ghost ml-auto text-xs disabled:opacity-50" data-apply-all>
            {busy === "__all" ? "Applying…" : sure.length === items.length ? "Apply all" : `Apply the ${sure.length} sure`}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Proposed categories for vendors with none yet. Apply the ones you want, or dismiss.
      </p>

      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((s) => (
            <li
              key={s.merchant}
              data-suggestion
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3"
            >
              {/* The proposed category is the quiet property, so it can be
                  changed in place before it is applied — not only taken or
                  left. A redirected proposal wears the edited tag. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <span className="truncate font-medium">{s.merchant}</span>
                <span className="text-[var(--muted)]">→</span>
                <CategoryProperty
                  categoryId={s.categoryId}
                  categoryName={s.categoryName}
                  categoryIcon={s.categoryIcon}
                  cats={cats}
                  likely={s.alternatives}
                  onChange={(id) => redirect(s.merchant, id)}
                  ariaLabel={`Category for ${s.merchant}`}
                  className="-ml-2"
                />
                <span className="shrink-0 text-xs text-[var(--muted)]">({s.count})</span>
                {s.edited ? (
                  <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-2 text-[11px] font-medium text-[var(--accent)]">edited</span>
                ) : s.possible || s.guess ? (
                  // The same tag the merge queue uses for a match it is not sure of;
                  // "a guess" when the model was mostly unsure. Shown either way: the
                  // words say how far to trust it.
                  <span data-possible={s.guess ? "guess" : "possible"} className="shrink-0 rounded-full bg-[var(--warn)]/15 px-2 py-1 text-[11px] font-medium text-[var(--warn)]">
                    {s.guess ? "a guess" : "possible match"}
                  </span>
                ) : (
                  <SourceTag source={s.source} />
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  disabled={busy === s.merchant}
                  onClick={() => apply(s)}
                  data-queue-accept
                  className="btn-ghost text-xs disabled:opacity-50"
                >
                  Apply
                </button>
                <button
                  disabled={busy === s.merchant}
                  onClick={() => dismiss(s)}
                  data-queue-dismiss
                  className="tap rounded-lg px-2 text-xs text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deferred.length > 0 && (
        // One decision per vendor: a duplicate candidate's category follows
        // from Combine (which sets it), so no proposal here — only the pointer.
        <ul className={`flex flex-col gap-1 text-xs text-[var(--muted)] ${items.length > 0 ? "mt-3" : ""}`}>
          {deferred.map((d) => (
            <li key={d.merchant} data-deferred={d.to}>
              <span className="font-medium text-[var(--foreground)]">{d.merchant}</span> ({d.count}) · possibly {d.to} — decide that first, in Possible duplicate vendors below. Combining sets its category.
            </li>
          ))}
        </ul>
      )}
      {(needsModel > 0 || dismissedCount > 0) && (
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)] ${items.length > 0 || deferred.length > 0 ? "mt-3" : ""}`}>
          {/* One line says where the rest stand. The model is asked without a
              press, so there is no "Suggest" button: only what it is doing, what
              it could not say, and the way to the hand-work. */}
          {needsModel > 0 && !modelEnabled && (
            <span data-needs-model>
              {needsModel} vendor{needsModel === 1 ? " needs" : "s need"} the model — set TYPESAFE_API_KEY or ANTHROPIC_API_KEY to get AI suggestions.
            </span>
          )}
          {needsModel > 0 && modelEnabled && ask === "asking" && (
            <span data-needs-model data-asking>
              Asking the model about {needsModel} vendor{needsModel === 1 ? "" : "s"}…
            </span>
          )}
          {needsModel > 0 && modelEnabled && ask === "failed" && (
            <>
              <span data-needs-model>
                Couldn&rsquo;t reach the model about {needsModel} vendor{needsModel === 1 ? "" : "s"}.
              </span>
              <button onClick={() => askModel(needsModel)} className="btn-ghost py-1 text-xs">
                Try again
              </button>
            </>
          )}
          {needsModel > 0 && modelEnabled && ask === "idle" && (
            <span data-needs-model>
              {needsModel} vendor{needsModel === 1 ? " needs" : "s need"} a closer look.
            </span>
          )}
          {/* The hand-work path: the list itself, filtered to what needs a category. */}
          {needsModel > 0 && onShowUncategorized && (
            <button onClick={onShowUncategorized} className="btn-link" data-show-uncategorized>
              Show all uncategorized →
            </button>
          )}
          {dismissedCount > 0 && (
            <span data-dismissed>
              {needsModel > 0 ? "· " : ""}
              {dismissedCount} dismissed{" "}
              <button onClick={undismissAll} className="btn-link">
                Bring them back →
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function SourceTag({ source }: { source: CategorySuggestion["source"] }) {
  if (source === "ai")
    return (
      <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-2 text-[11px] font-medium text-[var(--accent)]">
        AI
      </span>
    );
  return (
    <span className="shrink-0 text-[11px] uppercase tracking-wide text-[var(--muted)]">
      {source === "history" ? "history" : "rule"}
    </span>
  );
}
