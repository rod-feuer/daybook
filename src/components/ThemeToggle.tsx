"use client";

import { useEffect, useState } from "react";

// Toggles light/dark by setting data-theme on <html> and persisting to
// localStorage. The initial theme is applied pre-paint by an inline script in
// the layout (no flash); this just keeps the button label in sync and flips it.
export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    // Sync the label to the theme applied pre-paint by the layout script.
    // (Reading during render would cause an SSR/client hydration mismatch.)
    const current =
      (document.documentElement.dataset.theme as "light" | "dark") || "light";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
    setTheme(next);
  }

  const label = theme === "dark" ? "Light mode" : "Dark mode";
  if (compact) {
    return (
      // A tab-bar utility in a narrow cell past the hairline, icon only: with
      // five page tabs, the word "Theme" crowded their labels together. Named
      // for screen readers (aria-label) and on hover (title).
      <button type="button" onClick={toggle} title={label} className="tap flex w-9 items-center justify-center py-2 text-[var(--muted)] transition-colors hover:text-[var(--foreground)]" aria-label={label}>
        <span aria-hidden className="text-[15px] leading-none">{theme === "dark" ? "☀️" : "🌙"}</span>
      </button>
    );
  }
  return (
    <button onClick={toggle} className="nav-link w-full" aria-label="Toggle theme">
      <span className="text-[15px]">{theme === "dark" ? "☀️" : "🌙"}</span>
      <span>{label}</span>
    </button>
  );
}
