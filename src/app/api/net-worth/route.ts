import { NextResponse } from "next/server";
import { netWorth, netWorthTrend } from "@/lib/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The household's position today: each counted account's latest balance.
// Dated the way the sync dates a balance, so today's sync counts as today.
export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  return NextResponse.json({ today, ...netWorth(today), trend: netWorthTrend(today) });
}
