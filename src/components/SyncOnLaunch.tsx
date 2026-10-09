"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useToast } from "@/components/Toast";
import { combinedLine } from "@/lib/format";

// Fire a background Plaid sync when the app launches — at most once per window so
// reloads and new tabs don't spam it (client navigations don't remount the
// layout, so this only re-runs on a full load anyway). Quiet by design: a toast
// only when new data actually arrives, and silence on errors (e.g. the Plaid CLI
// isn't set up) so it never nags on launch. When charges or balances arrive it
// emits `copilot:synced` so any open page can refresh without a full reload.
const THROTTLE_MS = 15 * 60 * 1000; // 15 minutes

export function SyncOnLaunch() {
  const toast = useToast();
  // The login screen is not a launch. Syncing there got a 401 — and had already
  // stamped the 15-minute throttle, so signing in on a new device (a phone,
  // first visit) skipped the launch sync it was about to need.
  const onLogin = usePathname() === "/login";
  useEffect(() => {
    if (onLogin) return;
    const KEY = "copilot:lastAutoSync";
    let last = 0;
    try {
      last = Number(localStorage.getItem(KEY) ?? 0);
    } catch {
      // localStorage unavailable — proceed without throttling.
    }
    if (Date.now() - last < THROTTLE_MS) return;
    try {
      localStorage.setItem(KEY, String(Date.now())); // throttle before awaiting
    } catch {
      // ignore
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/plaid/sync", { method: "POST" });
        if (!res.ok || cancelled) return; // Plaid not configured / errored → stay quiet
        const data = await res.json();
        const changed = (data.inserted ?? 0) + (data.updated ?? 0);
        if (changed > 0) toast(`Synced ${data.inserted} new · ${data.updated} updated`, "success");
        // Combined on its own: off-screen, so it is said (Separate undoes it).
        const combined = combinedLine(data.combined);
        if (combined) toast(combined, "success");
        // New balances alone are new data too: on a day without new charges,
        // Accounts kept showing yesterday's balances until a reload.
        if (changed > 0 || combined || (data.balances ?? 0) > 0) window.dispatchEvent(new Event("copilot:synced"));
      } catch {
        // network or other — silent on launch
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, onLogin]);

  return null;
}

// Re-run `onSynced` whenever a background launch sync brings in new data, so a
// page can refresh its data in place rather than waiting for the next navigation.
export function useSyncedRefresh(onSynced: () => void) {
  const ref = useRef(onSynced);
  useEffect(() => {
    ref.current = onSynced;
  });
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener("copilot:synced", handler);
    return () => window.removeEventListener("copilot:synced", handler);
  }, []);
}
