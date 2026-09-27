"use client";

import { useState } from "react";

// A "⋯" overflow for header actions too rare to sit beside the month picker
// (Sync, Import, Re-scan). One pattern, every width: on a phone they crowded
// the title, and on a desktop they outweighed the month.
export function HeaderMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
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
          <div
            onClick={() => setOpen(false)}
            className="absolute right-0 z-40 mt-1 flex flex-col items-stretch gap-1 rounded-lg border border-[var(--border)] bg-card p-1 shadow-lg"
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}
