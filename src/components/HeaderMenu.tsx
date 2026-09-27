"use client";

import { useEffect, useRef, useState } from "react";

// A "⋯" overflow for header actions too rare to sit beside the month picker
// (Sync, Import, Re-scan). One pattern, every width: on a phone they crowded
// the title, and on a desktop they outweighed the month.
export function HeaderMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // A real menu: its entries are menu items, the first takes focus on open,
  // ↑ ↓ move between them, and Escape closes it and returns to ⋯.
  useEffect(() => {
    if (!open || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>("button, a, label")];
    for (const el of items) el.setAttribute("role", "menuitem");
    items[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="relative">
      <button
        ref={trigger}
        onClick={() => setOpen((o) => !o)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-ghost"
      >
        {/* The larger glyph rides inside a row-size line, so the button is as
            tall as the month picker beside it (it was 4.5px shorter). */}
        <span className="block">
          <span className="align-middle text-[15px] leading-none">⋯</span>
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          {/* The actions arrive as buttons; in the menu they read as rows —
              full width, left aligned, no border — not stacked buttons. */}
          <div
            ref={panel}
            role="menu"
            aria-label="More actions"
            onClick={() => setOpen(false)}
            className="absolute right-0 z-40 mt-1 flex min-w-40 flex-col items-stretch rounded-lg border border-[var(--border)] bg-card p-1 shadow-lg [&_a]:w-full [&_a]:justify-start [&_a]:border-transparent [&_button]:w-full [&_button]:justify-start [&_button]:border-transparent [&_button]:text-left [&_label]:w-full [&_label]:justify-start [&_label]:border-transparent"
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}
