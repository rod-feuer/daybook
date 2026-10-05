import os from "node:os";
import type { NextConfig } from "next";

// Every name this machine answers to on the local network, read when the dev
// server starts: its current IPv4 addresses, and any Bonjour (.local) name. The list used
// to be written by hand, with one address in it — and the router handed out a
// different one (192.168.68.61 became 192.168.20.154), so the phone got the
// page shell and no data: Next blocked the scripts and nothing said why. If the
// address changes while the server is running, restart it.
const lanOrigins = [
  ...Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address),
  "*.local", // the Bonjour name (Rods-MacBook-Pro.local); os.hostname() can be the router's name for us instead
  // Over Tailscale the phone uses the machine's bare name ("rods-macbook-pro",
  // MagicDNS) or its full one (*.ts.net); unlisted, Next blocked the dev
  // resources and the phone got the page shell with gray placeholders. The
  // Tailscale address (100.x) is an interface above, once Tailscale is up
  // before the server starts.
  os.hostname().replace(/\.local$/i, "").toLowerCase(),
  "*.ts.net",
];

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundler and let
  // Node require it directly at runtime.
  serverExternalPackages: ["better-sqlite3"],
  // Dev only: Next 16 blocks /_next/* dev resources for hosts it considers
  // cross-origin, which breaks client JS (no hydration, blank pages) when the app
  // is opened from a phone over the LAN by hostname/IP instead of localhost. Allow
  // this machine's own LAN names. (No effect on a production build.)
  allowedDevOrigins: lanOrigins,
  // Dev only: hide Next's round "N" badge. On a phone it sat on top of the
  // bottom nav's Dashboard tab, and touching it made Safari throw inside Next's
  // own dev tools ("NotFoundError … releasePointerCapture"), which the badge
  // then reported as "1 issue" in the app. Build and runtime errors still
  // surface without it (per the Next docs).
  devIndicators: false,
  // The browser suite builds into its own folder, so it can run while the dev
  // server is up (two `next dev` can't share one: the folder is locked).
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
