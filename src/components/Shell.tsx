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
  // Transactions only: the month's net, with the count as its caption, on the
  // title's line at the card-title size. A second card above the statement
  // would bury the list; at the summary size the header was a line taller
  // than every other page's, and jumped when switching tabs.
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
          right, centered against that block. */}
      <header ref={head} className="z-30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--background)] px-4 py-3 sm:sticky sm:top-0 sm:px-8 sm:py-4">
        {/* On a phone the title and the month picker hold one row on every
            page, and the subtitle takes its own line beneath both: beside the
            actions it pushed them under the title, to the left. A figure
            (the transactions net) does the same, under the title, so the
            picker stays on the title's row instead of centering on the number. */}
        {/* On a desktop the subtitle (the period, "Oct 1–4") sits on the
            title's line, as the transactions net does, so every header is one
            line and one height; on a phone it takes its own line beneath. */}
        <div className={figure || subtitle ? "contents sm:flex sm:items-baseline sm:gap-3" : "contents sm:block"}>
          <h1 className="min-w-0 flex-1 text-lg font-semibold tracking-tight sm:flex-none">{title}</h1>
          {figure && (
            <p className="order-last w-full sm:order-none sm:w-auto" data-header-figure>
              <span data-header-net className="text-[15px] font-semibold tabular-nums">{figure.value}</span>{" "}
              <span className="text-xs text-[var(--muted)]" data-header-caption>{figure.caption}</span>
            </p>
          )}
          {subtitle && <p className="order-last w-full text-xs text-[var(--muted)] sm:order-none sm:w-auto">{subtitle}</p>}
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
