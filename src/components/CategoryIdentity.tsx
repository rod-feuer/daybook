"use client";

import { useEffect, useRef, useState } from "react";
import { InlineEdit } from "@/components/InlineEdit";
import { CategoryBadge, categoryTint } from "@/components/CategoryBadge";
import { EmojiPicker } from "@/components/EmojiPicker";
import { PALETTE } from "@/components/NewCategoryForm";
import { Tooltip } from "@/components/Tooltip";

// A category's identity, editable where it's shown: the name, and the badge
// (icon, colour, type). Shared by the Categories row and the category shelf's
// header, so both edit it the same way.

// A searchable grid of curated category emojis. Picking one calls onPick. The
// search box also accepts a pasted emoji that isn't in the curated set — it's
// offered as a "use this" tile, so the escape hatch for any emoji survives.
// Inline-editable category name: click to rename in place (Enter/blur saves,
// Esc cancels), with a persistent faint ✎ cue — the same rename pattern as the
// shelf header and recurrings rows. Plain text when not renamable (no onRename,
// e.g. "Uncategorized").
export function CategoryName({
  name,
  onRename,
  textClassName = "text-[13px] font-medium",
}: {
  name: string;
  onRename?: (name: string) => void;
  textClassName?: string; // the row's 13px; the shelf header's 15px title
}) {
  if (!onRename) return <span className={`truncate ${textClassName}`}>{name}</span>;
  return (
    <InlineEdit
      value={name}
      textClassName={textClassName}
      onCommit={(raw) => {
        const v = raw.trim();
        if (v && v !== name) onRename(v);
      }}
    />
  );
}

// The category's round icon badge. When editable (onSave given), clicking it
// opens a small popover to pick an emoji and a color — the only place to set a
// category's appearance after creation. Read-only when onSave is absent.
export function EditableCategoryBadge({
  icon,
  color,
  kind,
  canEditKind,
  onSave,
}: {
  icon: string;
  color: string;
  kind?: "expense" | "income";
  canEditKind?: boolean;
  onSave?: (patch: { icon?: string; color?: string; kind?: "expense" | "income" }) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover when clicking anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!onSave) return <CategoryBadge icon={icon} color={color} className="mt-1" />;

  // The editable badge is the shared chip's shape and tint, as a button.
  const badgeClass =
    "mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px]";

  const badge = (
    <button
      data-category-badge
      onClick={() => setOpen((o) => !o)}
      className={`${badgeClass} group/badge relative cursor-pointer ring-[var(--border)] transition hover:ring-2`}
      style={{ background: categoryTint(color) }}
    >
    {icon}
    {/* Persistent (faint) corner cue so the badge reads as editable; darkens
        on hover. The card background + border keep it legible on any color. */}
    <span
      aria-hidden
      className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border)] bg-card text-[11px] leading-none text-[var(--muted)] transition-colors group-hover/badge:text-[var(--foreground)]"
    >
      <span className="inline-block -scale-x-100">✎</span>
    </span>
    </button>
  );

  return (
    // stopPropagation so editing the badge never opens the category shelf (the
    // row's click handler).
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      {/* The tip names the badge until it's open; open, it covered the
          picker's search box. */}
      {open ? badge : (
        <Tooltip label="Change icon & color" onlyIfTruncated={false}>
          {badge}
        </Tooltip>
      )}
      {open && (
        <div className="absolute left-0 top-11 z-20 w-64 rounded-lg border border-[var(--border)] bg-card p-3 shadow-lg">
          <EmojiPicker value={icon} onPick={(e) => onSave({ icon: e })} />
          <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
            {PALETTE.map((p) => (
              <button
                key={p}
                onClick={() => onSave({ color: p })}
                className={`h-6 w-6 rounded-full ${
                  color === p ? "ring-2 ring-offset-2 ring-[var(--foreground)]" : ""
                }`}
                style={{ background: p }}
                aria-label={`color ${p}`}
              />
            ))}
          </div>
          {/* Type (expense↔income) — a correction, e.g. a category that should
              count inflows. Re-buckets the category and flips how its rows sum. */}
          {canEditKind && kind && (
            <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-3">
              <span className="text-xs text-[var(--muted)]">Type</span>
              <div className="flex overflow-hidden rounded-lg border border-[var(--border)] text-xs">
                {(["expense", "income"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => k !== kind && onSave({ kind: k })}
                    className={`px-3 py-1 capitalize ${
                      kind === k
                        ? "bg-[var(--accent)] text-white"
                        : "text-[var(--muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
