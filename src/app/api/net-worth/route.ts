import { NextResponse } from "next/server";
import { netWorth, netWorthTrend, needsALook } from "@/lib/accounts";
import { localToday } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The household's position today: each counted account's latest balance.
// Dated the way the sync dates a balance, so today's sync counts as today.
export async function GET() {
  const today = localToday();
  const nw = netWorth(today);
  return NextResponse.json({ today, ...nw, trend: netWorthTrend(today), look: needsALook(nw.accounts, today) });
}
