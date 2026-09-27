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
      // before React starts; see SearchBox. Icon only: a "Sign out" label
      // read as a fifth tab beside the four pages.
      <form suppressHydrationWarning method="post" action="/api/logout" className="flex">
        <button
          suppressHydrationWarning
          type="submit"
          aria-label="Sign out"
          className="btn-ghost tap"
        >
          {icon}
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
