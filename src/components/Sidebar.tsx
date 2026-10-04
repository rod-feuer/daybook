"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SVGProps } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import SignOut from "@/components/SignOut";

// Inline line-icons (Feather/Lucide style) — recognizable nav glyphs without a
// dependency. `currentColor` stroke so each inherits the nav-link color, including
// the active accent state.
function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
      {...props}
    />
  );
}

// Dashboard — a layout/grid of panels.
const DashboardIcon = () => (
  <Icon>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Icon>
);

// Transactions — money flowing in and out (two opposed arrows).
const TransactionsIcon = () => (
  <Icon>
    <path d="M7 21V5" />
    <path d="M3 9l4-4 4 4" />
    <path d="M17 3v16" />
    <path d="M21 15l-4 4-4-4" />
  </Icon>
);

// Categories — a tag.
const CategoriesIcon = () => (
  <Icon>
    <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" />
    <circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);

// Recurrings — a repeat cycle.
const RecurringsIcon = () => (
  <Icon>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </Icon>
);

// Accounts — a bank's columns under a pediment.
const AccountsIcon = () => (
  <Icon>
    <path d="M3 10l9-6 9 6" />
    <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" />
    <path d="M3 21h18" />
  </Icon>
);

// Shared by the desktop sidebar and the mobile bottom-tab bar (BottomNav).
export const NAV = [
  { href: "/", label: "Dashboard", Icon: DashboardIcon },
  { href: "/transactions", label: "Transactions", Icon: TransactionsIcon },
  { href: "/categories", label: "Categories", Icon: CategoriesIcon },
  { href: "/recurrings", label: "Recurrings", Icon: RecurringsIcon },
  { href: "/accounts", label: "Accounts", Icon: AccountsIcon },
];

// `signOut`: the layout passes whether the password gate is on (server-side check).
export default function Sidebar({ signOut = false }: { signOut?: boolean }) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-card px-3 py-4 sm:flex">
      <div className="mb-6 flex items-center gap-2 px-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-[13px] font-bold text-white">
          D
        </div>
        <div className="text-[15px] font-semibold tracking-tight">Daybook</div>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`nav-link ${active ? "nav-link-active" : ""}`}
            >
              <n.Icon />
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-1 pt-4">
        <ThemeToggle />
        {signOut && <SignOut variant="sidebar" />}
        <div className="px-3 pt-1 text-[11px] leading-relaxed text-[var(--muted)]">
          Local prototype · data stays on your Mac
        </div>
      </div>
    </aside>
  );
}
