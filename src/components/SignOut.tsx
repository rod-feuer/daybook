// Sign out: a native form POST to /api/logout, which clears the session cookie
// and 303-redirects to /login — the same no-JS flow the login page uses, so it
// works the same on a phone. Rendered only when the password gate is on; the
// layout decides that server-side, this component never sees the password.
// Two placements, one action: the desktop sidebar footer and the mobile tab bar.
export default function SignOut({ variant }: { variant: "sidebar" | "tab" }) {
  const icon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
  if (variant === "tab")
    return (
      // iOS Chrome tags forms, not only fields, for autofill (__gcruniqueid)
      // before React starts; see SearchBox. A narrow cell past the hairline:
      // labelled, so it says what it does, but not a fifth page tab.
      <form suppressHydrationWarning method="post" action="/api/logout" className="flex">
        <button
          suppressHydrationWarning
          type="submit"
          aria-label="Sign out"
          className="tap flex w-12 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
        >
          {icon}
          <span aria-hidden>Sign out</span>
        </button>
      </form>
    );
  return (
    <form suppressHydrationWarning method="post" action="/api/logout">
      <button suppressHydrationWarning type="submit" className="nav-link w-full">
        {icon}
        Sign out
      </button>
    </form>
  );
}
