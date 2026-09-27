"use client";

import { useLayoutEffect, useRef } from "react";

// The page anatomy (DESIGN.md §2, "The one page"): title with an optional
// one-line subtitle on the left; the month picker in ONE slot on every page,
// first in the right-hand cluster; page actions to its right. Search, filters
// and sort go in a <Toolbar>, which each page places between its summary
// card and the list the controls act on — never in the header, never above
// the summary (the summary is the month; the toolbar is the list).
export function Toolbar({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>{children}</div>;
}

export default function Shell({
  title,
  subtitle,
  figure,
  month,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  // Transactions only: the month's net at the summary size, with the count
  // as the caption. A second card above the statement would bury the list.
  figure?: { value: string; caption: string };
  month?: React.ReactNode; // the month picker, always in the same place
  actions?: React.ReactNode; // page actions (rare ones behind ⋯)
  children: React.ReactNode;
}) {
  // The header is sticky on desktop, so anything else that sticks (a day
  // band in a statement list) must sit under it: publish its height as
  // --page-header on the page, measured, so it follows a wrapped subtitle.
  const wrap = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const h = head.current;
    const w = wrap.current;
    if (!h || !w) return;
    const set = () => {
      const sticky = getComputedStyle(h).position === "sticky";
      w.style.setProperty("--page-header", sticky ? `${h.offsetHeight}px` : "0px");
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(h);
    window.addEventListener("resize", set);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", set);
    };
  }, []);
  return (
    <div ref={wrap} className="mx-auto max-w-5xl">
      {/* Non-sticky on mobile so the header scrolls away and gives the small
          viewport back to content; sticky on desktop where there's room. */}
      {/* Title + subtitle form one block on the left; the actions sit on the
          right, centered against that block. A summary figure (the transactions
          net) pins the actions to the title line, so the number sits under the
          title instead of beside the picker. */}
      <header ref={head} className={`z-30 flex flex-wrap justify-between gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--background)] px-4 py-3 sm:sticky sm:top-0 sm:px-8 sm:py-4 ${figure ? "items-start" : "items-center"}`}>
        {/* On a phone the title and the month picker hold one row on every
            page, and the subtitle takes its own line beneath both: beside the
            actions it pushed them under the title, to the left. A figure
            (the transactions net) does the same, under the title, so the
            picker stays on the title's row instead of centering on the number. */}
        <div className="contents sm:block">
          <h1 className="min-w-0 flex-1 text-lg font-semibold tracking-tight">{title}</h1>
          {figure && (
            <div className="order-last w-full sm:order-none" data-header-figure>
              <div className="text-2xl font-semibold tracking-tight">{figure.value}</div>
              <p className="text-xs text-[var(--muted)]" data-header-caption>{figure.caption}</p>
            </div>
          )}
          {subtitle && <p className="order-last w-full text-xs text-[var(--muted)] sm:order-none">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {month}
          {actions}
        </div>
      </header>
      <div className="px-4 pb-6 pt-4 sm:px-8 sm:py-6">{children}</div>
    </div>
  );
}
