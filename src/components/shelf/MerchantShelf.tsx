"use client";

import { useState, type ReactNode } from "react";
import { InlineEdit, CommitInput } from "@/components/InlineEdit";
import { recurringState } from "@/components/RecurringGlyph";
import { Tooltip } from "@/components/Tooltip";
import { InfoHint } from "@/components/InfoHint";
import { usd, monthDayYear, shortDate } from "@/lib/format";
import { merchantKey } from "@/lib/merchant";
import { useNewCategory } from "@/components/NewCategoryOption";
import { CADENCE_LABEL, cadenceLabel } from "@/lib/cadence";
import type { MatchRule } from "@/lib/queries";
import type { Cat, SettingsPatch, Summary, Vendor } from "@/components/shelf/types";
import {
  ByYear,
  CaptionSelect,
  CategoryCaption,
  DateField,
  PropertyCard,
  ShelfRow,
  StateTag,
} from "@/components/shelf/parts";

export function EditableName({
  value,
  underlying,
  currentAlias,
  onSave,
}: {
  value: string;
  underlying: string;
  currentAlias: string | null;
  onSave: (alias: string | null) => void;
}) {
  return (
    <InlineEdit
      value={value}
      textClassName="text-[15px] font-semibold"
      onCommit={(raw) => {
        const v = raw.trim();
        const next = v && v !== underlying ? v : null; // editing back to the bank name = clear
        if (next !== currentAlias) onSave(next);
      }}
    />
  );
}

export function MerchantHeader({
  merchant,
  data,
  onUnlink,
  onRename,
}: {
  merchant: string;
  data: Summary | null;
  onUnlink: (alias: string) => void;
  onRename: (alias: string | null) => void;
}) {
  const [showNames, setShowNames] = useState(false);
  return (
    <>
      {data ? (
        <EditableName
          value={data.displayName}
          underlying={data.merchant}
          currentAlias={data.alias}
          onSave={onRename}
        />
      ) : (
        <div className="truncate text-[15px] font-semibold">{merchant}</div>
      )}
      {/* The descriptor only when a name makes it differ from the title; a
          plan says what a plan shelf needs to say — that the vendor has more. */}
      {data && data.alias != null && data.displayName !== data.merchant && (
        <div className="truncate text-[11px] text-[var(--muted)]">{data.merchant}</div>
      )}
      {data && data.series && data.plans > 1 && (
        <div className="truncate text-[11px] text-[var(--muted)]">One of {data.plans} plans under this vendor</div>
      )}
      {data && (
        <div className="text-xs text-[var(--muted)]">
          {data.count} transaction{data.count === 1 ? "" : "s"}
          {data.firstSeen
            ? ` · since ${new Date(data.firstSeen + "T00:00:00Z").toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              })}`
            : ""}
          {data.nameVariants > 1 ? (
            <>
              {" · "}
              <Tooltip label="The bank names grouped under this vendor" onlyIfTruncated={false}>
                <button
                  onClick={() => setShowNames((s) => !s)}
                  className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
                >
                  {data.nameVariants} names {showNames ? "▾" : "▸"}
                </button>
              </Tooltip>
            </>
          ) : null}
        </div>
      )}
      {data && showNames && data.names.length > 1 && (
        <ul className="mt-2 flex flex-col divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {data.names.map((n) => (
            <li key={n.name} className="flex items-center gap-2 px-3 py-2 text-xs">
              <Tooltip label={n.name} className="min-w-0 flex-1 truncate">
                {n.name}
              </Tooltip>
              <span className="shrink-0 tabular-nums text-[var(--muted)]">{n.count}</span>
              {n.canUnlink ? (
                <Tooltip
                  label="Separate this name back into its own vendor"
                  onlyIfTruncated={false}
                  className="inline-flex shrink-0"
                >
                  <button
                    onClick={() => onUnlink(n.name)}
                    className="tap rounded-lg px-1 text-[var(--muted)] hover:text-[var(--bad)]"
                  >
                    ✕
                  </button>
                </Tooltip>
              ) : (
                <span className="w-[18px] shrink-0" aria-hidden />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// One two-state pill: "In plan" / "Not in plan" for a charge, "Recurring" /
// "Not recurring" for a vendor. Clicking always flips the state; an "edited"
// tag says the user decided it. Quiet for the default (in) — every row would
// say it; a charge the user took out wears amber, the one state they chose

export function monthsSince(firstSeen: string | null): number {
  if (!firstSeen) return 12;
  const fs = new Date(firstSeen + "T00:00:00");
  const now = new Date();
  const span =
    (now.getFullYear() - fs.getFullYear()) * 12 + (now.getMonth() - fs.getMonth()) + 1;
  return Math.min(12, Math.max(1, span));
}

// Shared shelf row: a fixed-width date column, gap, then the name; amount
// right. Used by the Upcoming and Transactions lists so they line up. No row
// menu: recategorizing a single charge is the Transactions tab's job.
// The row's membership control: a labelled pill that says its state and
// toggles it. "charge": this charge in or out of its plan (the vendor shelf).

// Other vendors named like this one (Puccini's, Puccinis Smilcarmel In,
// Puccini'spizzapacarmel In: one restaurant, three bank spellings), to combine
// in one step instead of one Combine each. Nothing starts ticked: names that
// share a first word can be different places (Chatham Bars Inn, Chatham
// Crew), so each carries its count and category as the evidence, and Select
// all is one click when they are one place. Separate undoes any of them.
// Names that are different places but belong together (the Chatham shops,
// all Vacations) take one category without being combined: Set category.
function SimilarNames({
  similar,
  into,
  cats,
  onCombine,
  onCategorize,
}: {
  similar: Summary["similar"];
  into: string;
  cats: Cat[];
  onCombine: (merchants: string[]) => void;
  onCategorize: (merchants: string[], categoryId: number) => void;
}) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const all = ticked.size === similar.length;
  const toggle = (m: string) =>
    setTicked((t) => {
      const n = new Set(t);
      if (n.has(m)) n.delete(m);
      else n.add(m);
      return n;
    });
  return (
    <div data-similar-names>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="stat-label">Similar names</span>
        <button
          type="button"
          className="tap text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
          onClick={() => setTicked(all ? new Set() : new Set(similar.map((v) => v.merchant)))}
        >
          {all ? "Clear" : "Select all"}
        </button>
      </div>
      <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list>
        {similar.map((v) => (
          <li key={v.merchant}>
            <label className="tap flex cursor-pointer items-center gap-3 py-2 text-[13px]">
              <input
                type="checkbox"
                checked={ticked.has(v.merchant)}
                onChange={() => toggle(v.merchant)}
                className="tap-native size-4 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1 truncate font-medium">{v.displayName}</span>
              <span className="shrink-0 text-xs text-[var(--muted)]">
                {v.count} charge{v.count === 1 ? "" : "s"}
                {v.categoryName ? ` · ${v.categoryName}` : ""}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {ticked.size === 0 ? (
        <p className="mt-2 text-xs text-[var(--muted)]">
          Tick the ones that are {into} to combine them, or any to give them one category.
        </p>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => {
              onCombine([...ticked]);
              setTicked(new Set());
            }}
            className="btn-ghost flex-1 text-xs"
            data-combine-similar
          >
            Combine {ticked.size} into {into}
          </button>
          {/* A native select (DESIGN.md §2): choosing a category is the
              action, for the ticked names only; each stays its own vendor. */}
          <select
            value=""
            onChange={(e) => {
              const id = Number(e.target.value);
              if (!id) return;
              onCategorize([...ticked], id);
              setTicked(new Set());
            }}
            aria-label={`Set a category for the ${ticked.size} ticked`}
            className="btn-ghost select-caret min-w-0 flex-1 cursor-pointer appearance-none pr-8 text-left text-xs"
            data-categorize-similar
          >
            <option value="">Set category for {ticked.size}…</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// Merge this vendor with another. The only decision surfaced is the resulting
// NAME — which silently determines the survivor (canonical), so the user never
// reasons about "primary". Defaults to the cleaner name; a preview shows the
// combined charge count; and the merge is reversible (split via the header).
export type CombineVendor = {
  merchant: string;
  name: string;
  count: number;
  categoryId: number | null;
  categoryName: string | null;
};

export function CombineControl({
  current,
  cats,
  vendors,
  onCombine,
  onClose,
}: {
  current: CombineVendor;
  cats: Cat[];
  vendors: Vendor[];
  onCombine: (loser: string, primary: string, alias?: string, categoryId?: number | null) => void;
  onClose: () => void;
}) {
  const [pick, setPick] = useState("");
  const [other, setOther] = useState<CombineVendor | null>(null);
  const [choice, setChoice] = useState<"current" | "other" | "custom">("current");
  const [custom, setCustom] = useState("");
  const [showList, setShowList] = useState(false); // vendor-picker dropdown open
  // The category to apply to all the combined charges, or "asis" to leave them.
  const [unifyCat, setUnifyCat] = useState<number | "asis">("asis");

  const reset = () => {
    setPick("");
    setOther(null);
    setCustom("");
    setChoice("current");
    setUnifyCat("asis");
    setShowList(false);
    onClose();
  };

  // Live matches for the custom picker dropdown — one row per vendor, shown by
  // friendly display name (filters on the name or the raw descriptor).
  const q = pick.trim().toLowerCase();
  const matches = q
    ? vendors
        .filter(
          (v) =>
            v.merchant !== current.merchant &&
            (v.displayName.toLowerCase().includes(q) || v.merchant.toLowerCase().includes(q))
        )
        .slice(0, 50)
    : [];

  // Cleaner = fewer words, then shorter, with a digit penalty (bank descriptors
  // tend to be long, multi-word, and id-laden). Returns true if `a` is cleaner.
  const score = (s: string) => s.trim().split(/\s+/).length * 100 + s.length + (/\d/.test(s) ? 50 : 0);
  const currentCleaner = () => !other || score(current.name) <= score(other.name);
  // Categories differ → offer to unify them (a combined vendor shouldn't stay
  // split across categories).
  const categoriesDiffer = !!other && current.categoryId !== other.categoryId;

  async function chooseOther(merchant?: string) {
    // A clicked row passes its canonical merchant; Enter/Next takes the top match.
    const m = merchant ?? matches[0]?.merchant;
    if (!m || m === current.merchant || !vendors.some((v) => v.merchant === m)) return;
    setShowList(false);
    const o = await fetch(`/api/merchant?name=${encodeURIComponent(m)}`).then((r) => r.json());
    const next: CombineVendor = {
      merchant: m,
      name: o.displayName as string,
      count: o.count as number,
      categoryId: (o.categoryId ?? null) as number | null,
      categoryName: (o.categoryName ?? null) as string | null,
    };
    setOther(next);
    const curCleaner = score(current.name) <= score(next.name);
    setChoice(curCleaner ? "current" : "other");
    // Default the unify target to the survivor's category, else the other's.
    const survivor = curCleaner ? current.categoryId : next.categoryId;
    const fallback = curCleaner ? next.categoryId : current.categoryId;
    setUnifyCat(survivor ?? fallback ?? "asis");
  }

  function combine() {
    if (!other) return;
    const cat = categoriesDiffer && unifyCat !== "asis" ? unifyCat : undefined;
    if (choice === "current") onCombine(other.merchant, current.merchant, undefined, cat);
    else if (choice === "other") onCombine(current.merchant, other.merchant, undefined, cat);
    else {
      const name = custom.trim();
      if (!name) return;
      const primary = currentCleaner() ? current.merchant : other.merchant;
      const loser = primary === current.merchant ? other.merchant : current.merchant;
      onCombine(loser, primary, name, cat);
    }
    reset();
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs">
      {!other ? (
        <>
          <div className="relative">
            <input
              autoFocus
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setShowList(true);
              }}
              onFocus={() => setShowList(true)}
              onKeyDown={(e) => e.key === "Enter" && chooseOther()}
              onBlur={() => setTimeout(() => setShowList(false), 150)}
              placeholder="Find a vendor to combine…"
              className="w-full rounded-lg border border-[var(--border)] bg-card px-2 py-1"
            />
            {showList && matches.length > 0 && (
              <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-lg border border-[var(--border)] bg-card py-1 shadow-lg">
                {matches.map((v) => (
                  <li key={v.merchant}>
                    <button
                      // mousedown (not click) + preventDefault so selecting fires
                      // before the input's blur closes the list.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        chooseOther(v.merchant);
                      }}
                      className="block w-full px-2 py-2 text-left leading-snug hover:bg-[var(--hover)]"
                    >
                      {v.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => chooseOther()}
              className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-card"
            >
              Next
            </button>
            <button onClick={reset} className="text-[var(--muted)] hover:text-[var(--foreground)]">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="text-[var(--muted)]">Combine into one vendor — name it:</div>
          {[
            { key: "current" as const, label: current.name, cleaner: currentCleaner() },
            { key: "other" as const, label: other.name, cleaner: !currentCleaner() },
          ].map((opt) => (
            <label key={opt.key} className="flex items-center gap-2">
              <input
                type="radio"
                checked={choice === opt.key}
                onChange={() => setChoice(opt.key)}
              />
              <span className="min-w-0 truncate">{opt.label}</span>
              {opt.cleaner && <span className="shrink-0 text-[11px] text-[var(--accent)]">recommended</span>}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="radio" checked={choice === "custom"} onChange={() => setChoice("custom")} />
            <input
              value={custom}
              onFocus={() => setChoice("custom")}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Something else…"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-card px-2 py-1"
            />
          </label>
          {categoriesDiffer && (
            <div className="flex flex-col gap-1 border-t border-dashed border-[var(--border)] pt-2">
              <span className="text-[var(--muted)]">
                Different categories: {current.categoryName ?? "Uncategorized"} ·{" "}
                {other.categoryName ?? "Uncategorized"}
              </span>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[var(--muted)]">Set all charges to</span>
                <select
                  value={unifyCat === "asis" ? "asis" : String(unifyCat)}
                  onChange={(e) => setUnifyCat(e.target.value === "asis" ? "asis" : Number(e.target.value))}
                  className="select-caret min-w-0 flex-1 cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-1 pl-2 pr-8"
                >
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.name}
                    </option>
                  ))}
                  <option value="asis">Leave as-is</option>
                </select>
              </div>
            </div>
          )}
          <div className="text-[var(--muted)]">
            {current.count + other.count} charges combined · you can split them apart anytime
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={reset} className="rounded-lg px-2 py-1 text-[var(--muted)]">
              Cancel
            </button>
            <button
              onClick={combine}
              className="rounded-lg bg-[var(--accent)] px-3 py-1 font-medium text-white"
            >
              Combine
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Auto vs. edited legibility: shows whether a field holds the system's detected

// The vendor's split rules. A rule was invisible unless you found a charge it
// had split; here it can be read and removed. Remove means what "Undo split"
// means on a charge — the rule and everything it did — so it is a two-step
// button, like deleting a category: the first press arms it for three seconds.
export function SplitRules({ rules, onRemove }: { rules: Summary["splitRules"]; onRemove: (id: number, applied: number) => void }) {
  const [armed, setArmed] = useState<number | null>(null);
  return (
    <div data-split-rules>
      <div className="mb-2 flex items-center gap-2">
        <span className="stat-label">Splits</span>
        <InfoHint text="Every charge from this vendor of exactly this amount is divided into these parts, each with its own category. Removing a split restores the charges it divided." />
      </div>
      <ul className="flex flex-col gap-2">
        {rules.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-3 text-xs">
            <span className="min-w-0">
              <span className="font-medium tabular-nums">{usd(r.amount)}</span>
              <span className="text-[var(--muted)]"> into </span>
              {r.parts.map((p) => `${p.label} ${usd(p.amount)}`).join("  ·  ")}
              <span className="block text-[11px] text-[var(--muted)]">
                {r.applied === 0 ? "not applied yet" : `applied to ${r.applied} charge${r.applied === 1 ? "" : "s"}`}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Remove the ${usd(r.amount)} split`}
              onClick={() => {
                if (armed !== r.id) {
                  setArmed(r.id);
                  setTimeout(() => setArmed((cur) => (cur === r.id ? null : cur)), 3000);
                  return;
                }
                setArmed(null);
                onRemove(r.id, r.applied);
              }}
              className={`tap shrink-0 text-xs ${armed === r.id ? "font-semibold text-[var(--bad)]" : "text-[var(--muted)] hover:text-[var(--bad)]"}`}
            >
              {armed === r.id ? (r.applied ? `Restore ${r.applied} and remove?` : "Confirm remove?") : "Remove"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Match correction: how a charge is recognised as this bill. Auto = exact
// vendor, or the vendor's category + amount. "contains" widens it to any
// descriptor containing the text; the tolerance bounds the amount.
// A "contains" rule is incomplete until it has text (the route drops one without),
// so the mode is held locally and saved only once the rule is whole: Auto and
// "exact" save at once; "contains" saves when its text is entered. The parent
// remounts this on every server change (key), so local state never goes stale.
export function MatchCorrection({
  rule,
  onSave,
  trailing,
}: {
  rule: MatchRule | null;
  onSave: (rule: MatchRule | null) => void;
  trailing?: ReactNode; // e.g. "Reset all overrides", on the label line
}) {
  const [mode, setMode] = useState<string>(rule?.matchMode ?? "");
  const [text, setText] = useState(rule?.matchText ?? "");
  const [tol, setTol] = useState(rule ? (rule.amountTolerance == null ? "any" : String(rule.amountTolerance)) : "0.05");
  const complete = (m: string, t: string) => m === "exact" || (m === "contains" && t.trim() !== "");
  const save = (m: string, t: string, tl: string) => {
    if (!m) return onSave(null);
    if (!complete(m, t)) return; // wait for the text
    onSave({ matchMode: m as "exact" | "contains", matchText: m === "contains" ? t.trim() : null, amountTolerance: tl === "any" ? null : Number(tl) });
  };
  const sel = "btn-ghost select-caret cursor-pointer appearance-none pr-8 text-[13px]";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="stat-label">Match</label>
        <StateTag edited={rule != null} />
        <InfoHint text="How a charge is recognised as this bill. Auto: the vendor exactly, or the same vendor under a relabeled descriptor within 5% of the amount. A rule widens or narrows that." />
        {trailing && <span className="ml-auto">{trailing}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Match rule" value={mode} onChange={(e) => { setMode(e.target.value); save(e.target.value, text, tol); }} className={sel}>
          <option value="">vendor exactly, or relabeled within 5%</option>
          <option value="exact">vendor exactly</option>
          <option value="contains">descriptor contains…</option>
        </select>
        {mode === "contains" && (
          <input
            aria-label="Match text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => save(mode, text, tol)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="text in the description"
            className="btn-ghost min-w-0 flex-1 text-[13px]"
          />
        )}
        {mode && (
          <select aria-label="Amount tolerance" value={tol} onChange={(e) => { setTol(e.target.value); save(mode, text, e.target.value); }} className={sel}>
            <option value="0.05">±5%</option>
            <option value="0.1">±10%</option>
            <option value="0.25">±25%</option>
            <option value="any">any amount</option>
          </select>
        )}
      </div>
    </div>
  );
}

export function MerchantBody({
  data,
  cats,
  onOpenPlan,
  onAddCategory,
  onRecategorize,
  onTxSetMembership,
  onToggleRecurring,
  onAddPlan,
  onSaveSettings,
  amountHint,
  vendors,
  onCombine,
  onCombineMany,
  onCategorizeMany,
  onRemoveSplit,
}: {
  data: Summary;
  cats: Cat[];
  onAddCategory: (c: Cat) => void;
  onRecategorize: (categoryId: number | null) => void;
  onTxSetMembership: (txId: number, put: "in" | "out", plan: string | null) => void;
  onToggleRecurring: () => void;
  onAddPlan: () => void; // a plan the detector found, not yet counted
  onSaveSettings: (patch: SettingsPatch, success?: string) => void; // a success line only where the result spans every field ("Overrides reset")
  amountHint?: number | null;
  vendors: Vendor[];
  onCombine: (loser: string, primary: string, alias?: string, categoryId?: number | null) => void;
  onCombineMany: (losers: string[]) => void; // several similar names into this vendor
  onCategorizeMany: (merchants: string[], categoryId: number) => void; // one category for several similar names, kept apart
  onRemoveSplit: (id: number, applied: number) => void;
  onOpenPlan: (series: string) => void; // one of this vendor's plans, with Back
}) {
  // "+ New category…" in the Category field: create it here and apply it.
  const newCat = useNewCategory<null>((cat) => {
    onAddCategory(cat);
    onRecategorize(cat.id);
  });
  const [combining, setCombining] = useState(false);
  // On a vendor with several plans, "In plan" has to name which one. The pill
  // opens this picker instead of joining whichever plan charged last.
  const [assigning, setAssigning] = useState<number | null>(null);
  // A vendor with several plans is not a plan: its shelf lists them, with what
  // they add up to, and each opens its own shelf. The single-plan cards below
  // borrowed the most recently charged plan's figures, which for Apple's six
  // subscriptions read "$128 per year" on a vendor that costs $790.
  const multi = !data.series && data.planList.length > 1;
  // The vendor is not one category. The control that would rewrite every
  // charge stays off this shelf; a plan's shelf, or a charge, sets its own.
  const mixedVendor = !data.series && data.categoryMixed;
  const d = multi ? null : data.recurringDetail;
  const monthsActive = monthsSince(data.firstSeen);
  // Placeholder for the expected-amount editor. Priority: a caller-supplied hint
  // (the suggestion row's exact figure, so the two never disagree) → the detected
  // per-charge for a confirmed recurring → the most recent charge (current price).
  const detectedAmount =
    d?.perCharge ??
    amountHint ??
    (data.recent[0] ? Number(Math.abs(data.recent[0].amount).toFixed(2)) : null);
  // What varies across the Recent rows, if anything: the descriptor (shown as
  // the part after the names' shared prefix, so three "Healthy Paws Pet Ins…"
  // don't all truncate alike), else the category.
  // Descriptors count as different only when their vendor keys differ —
  // genuinely different labels, not one label with and without a trailing
  // "Payment". Shown whole; a trimmed tail read as junk. What varies is judged
  // per list, so Other charges doesn't inherit Recent's labels.
  function varyLabel(rows: { merchant: string; categoryName: string | null }[]) {
    const keys = new Set(rows.map((r) => merchantKey(r.merchant)));
    const categories = new Set(rows.map((r) => r.categoryName ?? "Uncategorized"));
    if (keys.size > 1) return (r: { merchant: string }) => r.merchant;
    if (categories.size > 1) return (r: { categoryName: string | null }) => r.categoryName ?? "Uncategorized";
    return () => undefined as string | undefined;
  }
  type ChargeRow = Summary["recent"][number];
  function rowName(rows: ChargeRow[], r: ChargeRow) {
    // A charge in a plan wears that plan's day pill, not a second copy of
    // the vendor's name. A charge in no plan still says what varies.
    if (multi && r.planDay) return undefined;
    return varyLabel(rows)(r);
  }
  function membershipFor(r: ChargeRow) {
    if (r.excluded === 1) return undefined;
    return {
      kind: "charge" as const,
      edited: r.recurringExcluded === 1 || r.recurringIncluded === 1,
      onToggle: () => {
        if (r.recurringId != null) {
          onTxSetMembership(r.id, "out", null);
          return;
        }
        // Several plans: don't guess. The pill asks which one.
        if (multi) {
          setAssigning(r.id);
          return;
        }
        onTxSetMembership(r.id, "in", data.planKey);
      },
    };
  }
  function planPicker(rows: ChargeRow[]) {
    if (assigning == null || !rows.some((r) => r.id === assigning)) return null;
    const live = data.planList.filter((p) => !p.ended);
    return (
      <div data-plan-picker className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted)]">Put in</span>
        {live.map((p) => (
          <button
            key={p.key}
            type="button"
            className="btn-ghost text-xs"
            onClick={() => {
              onTxSetMembership(assigning, "in", p.key);
              setAssigning(null);
            }}
          >
            {p.day}
          </button>
        ))}
        <button type="button" className="text-[var(--muted)] hover:text-[var(--foreground)]" onClick={() => setAssigning(null)}>
          Cancel
        </button>
      </div>
    );
  }
  function chargeList(rows: ChargeRow[]) {
    return (
      <>
        <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list>
          {rows.map((r) => (
            <ShelfRow
              key={r.id}
              date={r.date}
              name={rowName(rows, r)}
              pill={multi ? (r.planDay ?? undefined) : undefined}
              amount={r.amount}
              muted={r.excluded === 1}
              excluded={!!r.excluded || !!r.categoryExcluded}
              recurring={recurringState(r)}
              membership={membershipFor(r)}
              note={r.excluded === 1 ? "not counted" : undefined}
              flush
              unsignedDebits
            />
          ))}
        </ul>
        {planPicker(rows)}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {d ? (
        <>
          {/* The plan's properties, each a stat that IS its editor: one fact,
              one place. Per charge edits the expected amount; next due edits
              the date; the cadence select sits on the caption line with the
              per-year figure it drives. */}
          {/* Date on the left, amount on the right — the rows' order. */}
          <div className="grid grid-cols-2 gap-2">
            <PropertyCard label="Next due" edited={data.nextDate != null}>
              <DateField
                label="Next due"
                value={data.nextDate ?? d.nextDate}
                onPick={(v) => {
                  if (v === "" || v === d.nextDate) onSaveSettings({ nextDate: null });
                  else if (v !== data.nextDate) onSaveSettings({ nextDate: v });
                }}
              />
            </PropertyCard>
            <PropertyCard label="Per charge" edited={data.expectedAmount != null}>
              <div className="flex items-center">
                <span className="text-[15px] font-semibold text-[var(--muted)]">$</span>
                <CommitInput
                  key={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
                  defaultValue={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
                  placeholder={detectedAmount != null ? detectedAmount.toFixed(2) : "amount"}
                  inputMode="decimal"
                  aria-label="Expected amount"
                  onCommit={(v) => {
                    const t = v.trim();
                    if (t === "") {
                      if (data.expectedAmount != null) onSaveSettings({ expectedAmount: null });
                      return;
                    }
                    const n = Math.abs(Number(t));
                    if (!Number.isFinite(n)) return; // ignore non-numeric input
                    if (n !== (data.expectedAmount ?? null)) onSaveSettings({ expectedAmount: n });
                  }}
                  className="w-full min-w-0 bg-transparent text-[15px] font-semibold tabular-nums placeholder:font-semibold placeholder:text-[var(--foreground)] focus:outline-none"
                />
              </div>
            </PropertyCard>
          </div>
          {/* The plan's other properties on one line: category, cadence (the
              value first, its auto/edited state beside it, like the cards), and
              the per-year figure the cadence drives. */}
          <div className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
            {mixedVendor ? (
              <span>Charges use more than one category. Set one on a plan, or on a charge.</span>
            ) : (
              <CategoryCaption data={data} cats={cats} onChange={onRecategorize} onNew={(anchor) => newCat.open(anchor, null, `New category for ${data.displayName}`)} edited={data.categoryEdited} mixed={data.chargeCategoriesMixed} />
            )}
            {mixedVendor ? null : newCat.popover}
            {/* Items are separated by space, not dots: a wrap can then never
                strand a separator at either end of a line. */}
            <span className="inline-flex items-center whitespace-nowrap">
              <CaptionSelect
                label={(data.cadence ?? data.detectedCadence) ? cadenceLabel(data.cadence ?? data.detectedCadence ?? "") : "Auto"}
                tag={<StateTag edited={data.cadence != null} />}
                aria-label="Cadence"
                value={data.cadence ?? "__auto"}
                onChange={(e) => onSaveSettings({ cadence: e.target.value === "__auto" ? null : e.target.value })}
              >
                <option value="__auto">{data.detectedCadence ? `${cadenceLabel(data.detectedCadence)} (auto)` : "Auto"}</option>
                {Object.entries(CADENCE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </CaptionSelect>
            </span>
            <span className="whitespace-nowrap">{usd(d.annualized, { cents: false })} per year expected</span>
            {data.received > 0 && (
              <span className="whitespace-nowrap">{usd(data.received, { cents: false })} received all time</span>
            )}
          </div>
        </>
      ) : null}

      {multi && (
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <div className="stat-label">{data.planList.length} plans</div>
            <div className="text-xs tabular-nums text-[var(--muted)]">{usd(data.monthly, { cents: false })} per month</div>
          </div>
          <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list data-plan-list>
            {data.planList.map((p) => (
              <ShelfRow
                key={p.id}
                date={p.nextDate}
                pill={p.day}
                amount={-p.amount}
                muted={p.ended}
                note={p.ended ? "ended" : cadenceLabel(p.cadence)}
                onClick={() => onOpenPlan(p.key)}
                flush
                unsignedDebits
              />
            ))}
          </ul>
          <div className="mt-2 text-[11px] text-[var(--muted)]">Next due, the day it bills, amount. A plan&rsquo;s own shelf edits it.</div>
        </div>
      )}

      {!d && !multi && (
        // A vendor with no plan keeps the same anatomy: two cards — what it
        // cost over the last year, and the expected amount (its editor) —
        // then the caption line with the category and the per-month facts.
        <>
          <div className="grid grid-cols-2 gap-2">
          <PropertyCard label="last 12 months">
            <div className="text-[15px] font-semibold tabular-nums">{usd(data.trailing12, { cents: false })}</div>
          </PropertyCard>
          <PropertyCard label="Expected" edited={data.expectedAmount != null}>
            <div className="flex items-center">
              <span className="text-[15px] font-semibold text-[var(--muted)]">$</span>
              <CommitInput
                key={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
                defaultValue={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
                placeholder={detectedAmount != null ? detectedAmount.toFixed(2) : "amount"}
                inputMode="decimal"
                aria-label="Expected amount"
                onCommit={(v) => {
                  const t = v.trim();
                  if (t === "") {
                    if (data.expectedAmount != null) onSaveSettings({ expectedAmount: null });
                    return;
                  }
                  const n = Math.abs(Number(t));
                  if (!Number.isFinite(n)) return;
                  if (n !== (data.expectedAmount ?? null)) onSaveSettings({ expectedAmount: n });
                }}
                className="w-full min-w-0 bg-transparent text-[15px] font-semibold tabular-nums placeholder:font-semibold placeholder:text-[var(--foreground)] focus:outline-none"
              />
            </div>
          </PropertyCard>
          </div>
          <div className="-mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--muted)]">
            {mixedVendor ? (
              <span>Charges use more than one category. Set one on a charge.</span>
            ) : (
              <CategoryCaption data={data} cats={cats} onChange={onRecategorize} onNew={(anchor) => newCat.open(anchor, null, `New category for ${data.displayName}`)} edited={data.categoryEdited} mixed={data.chargeCategoriesMixed} />
            )}
            <span className="whitespace-nowrap">
              {usd(data.trailing12 / monthsActive, { cents: false })} per active month · {data.count12} charge{data.count12 === 1 ? "" : "s"} in 12 months
            </span>
            {data.received > 0 && (
              <span className="whitespace-nowrap">{usd(data.received, { cents: false })} received all time</span>
            )}
            {newCat.popover}
          </div>
        </>
      )}

      {data.priceChange && (
        <div className="rounded-lg bg-[var(--warn)]/10 px-3 py-2 text-xs text-[var(--warn)]">
          {data.priceChange.to > data.priceChange.from ? "↑" : "↓"} price changed{" "}
          {usd(data.priceChange.from)} → {usd(data.priceChange.to)} since{" "}
          {monthDayYear(data.priceChange.since)}
        </div>
      )}

      {/* Evidence before controls: the shelf exists to edit a vendor where its
          charges are on screen, so the charges come first. */}
      <div>
        <div className="stat-label mb-2">Recent</div>
        {/* Each charge carries one two-state pill — "In plan" / "Not in
            plan" — and clicking always flips it. An "edited" tag beside it
            says the user decided (took it out, or put in a charge the
            detector left out); no tag means the detector did (a device
            purchase under "Apple" is not the subscription). No menu:
            recategorizing a single charge is the Transactions tab's job.
            The text slot shows only what VARIES across these rows — the
            descriptor a charge posted under, else its category — and nothing
            when every row would say the same thing. */}
        {/* No box: the list sits on the panel's edges like the titles and the
            by-year figures, so dates and amounts share one edge all the way
            down. Only the property cards are boxes. */}
        {chargeList(data.recent)}
      </div>

      {multi && data.otherCharges.length > 0 && (
        <div>
          <div className="stat-label mb-2">Other charges</div>
          <p className="mb-2 text-[11px] text-[var(--muted)]">Not in a plan. Put one in a plan, or open the plan and pull it in there.</p>
          {chargeList(data.otherCharges)}
        </div>
      )}

      <ByYear rows={data.byYear} title="By year" />

      {/* A divider ranks the corrections a tier below the evidence — things
          you reach for occasionally, not every visit. */}
      <div className="border-t border-[var(--border)]" />

      <div className="flex flex-col gap-3">
        {/* One labelled row for the rare control, with Reset on its line. */}
        {data.recurring && !multi ? (
          <MatchCorrection
            key={JSON.stringify(data.matchRule)}
            rule={data.matchRule}
            trailing={
              data.hasSettings && (
                <button
                  type="button"
                  onClick={() => onSaveSettings({ clear: true }, "Overrides reset")}
                  className="text-xs text-[var(--muted)] hover:text-[var(--bad)]"
                >
                  Reset all overrides
                </button>
              )
            }
            onSave={(r) =>
              onSaveSettings(
                r
                  ? { matchMode: r.matchMode, matchText: r.matchText, amountTolerance: r.amountTolerance }
                  : { matchMode: null, matchText: null, amountTolerance: null }
              )
            }
          />
        ) : (
          !multi && data.hasSettings && (
            <button
              type="button"
              onClick={() => onSaveSettings({ clear: true }, "Overrides reset")}
              className="self-start text-xs text-[var(--muted)] hover:text-[var(--bad)]"
            >
              Reset all overrides
            </button>
          )
        )}

        {data.recurring && !multi && data.ended && (
          <Tooltip
            label="Marked ended — no longer counts as upcoming or expected"
            onlyIfTruncated={false}
            className="inline-flex self-start rounded-full bg-[var(--warn)]/15 px-2 py-1 text-[11px] font-medium text-[var(--warn)]"
          >
            Ended{data.endedDate ? ` ${shortDate(data.endedDate)}` : ""}
          </Tooltip>
        )}
        {data.splitRules.length > 0 && <SplitRules rules={data.splitRules} onRemove={onRemoveSplit} />}
        {/* A plan the detector found and nobody added doesn't count yet: its
            charges show no ↻, and Add is the one verb that changes that. */}
        {data.recurring && !multi && !data.planConfirmed && (
          <p data-suggested-plan className="text-xs text-[var(--muted)]">
            Suggested plan, not counted yet. Add it to count it as a bill; Not recurring dismisses it.
          </p>
        )}
        {data.similar.length > 0 && (
          <SimilarNames similar={data.similar} into={data.displayName} cats={cats} onCombine={onCombineMany} onCategorize={onCategorizeMany} />
        )}
        {/* One actions row, one style: the §2 verbs. Combine is a disclosure —
            its panel drops below the row only while in use. */}
        <div className="flex gap-2">
          <button onClick={onToggleRecurring} className="btn-ghost flex-1 text-xs">
            {data.recurring ? "Not recurring" : "Make recurring"}
          </button>
          {data.recurring && !multi && !data.planConfirmed && (
            <button onClick={onAddPlan} className="btn-ghost flex-1 text-xs" data-add-plan>
              Add
            </button>
          )}
          {data.recurring && !multi && data.planConfirmed &&
            (data.ended ? (
              <button
                onClick={() => onSaveSettings({ endedDate: null })}
                className="btn-ghost flex-1 text-xs"
              >
                Reactivate
              </button>
            ) : (
              <button
                onClick={() => onSaveSettings({ endedDate: new Date().toISOString().slice(0, 10) })}
                className="btn-ghost flex-1 text-xs"
              >
                Mark ended
              </button>
            ))}
          <button
            onClick={() => setCombining((v) => !v)}
            className={`btn-ghost flex-1 text-xs ${combining ? "text-[var(--accent)]" : ""}`}
          >
            Combine
          </button>
        </div>
        {combining && (
          <CombineControl
            current={{
              merchant: data.merchant,
              name: data.displayName,
              count: data.count,
              categoryId: data.categoryId,
              categoryName: data.categoryName,
            }}
            cats={cats}
            vendors={vendors}
            onCombine={onCombine}
            onClose={() => setCombining(false)}
          />
        )}
      </div>
    </div>
  );
}
