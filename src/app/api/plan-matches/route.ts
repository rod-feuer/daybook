import { NextRequest, NextResponse } from "next/server";
import { confirmPlan, setTransactionRecurringIncluded } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { setChargeVendor } from "@/lib/vendorMoves";
import { detectRecurrings } from "@/lib/core";
import { dismissPlanMatch, planMatchSuggestions } from "@/lib/planMatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Charges that look like another vendor's plan, not certain enough to join on
// their own: the review queue's "Belongs to …?".
export async function GET() {
  return NextResponse.json(planMatchSuggestions());
}

// accept: the owner's word that the charge is that plan's vendor's (Change
// vendor, "edited") and in that plan (In plan). dismiss: don't ask about
// this charge again.
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.action === "accept") {
    const id = Number(body.id);
    const plan = String(body.plan ?? "");
    if (!Number.isInteger(id) || !plan) return NextResponse.json({ error: "id and plan required" }, { status: 400 });
    const t = getDb().prepare("SELECT hash FROM transactions WHERE id = ?").get(id) as { hash: string } | undefined;
    const p = getDb().prepare("SELECT vendor FROM plans WHERE key = ?").get(plan) as { vendor: string } | undefined;
    if (t && p) setChargeVendor(t.hash, p.vendor, "user");
    setTransactionRecurringIncluded(id, plan);
    detectRecurrings();
    confirmPlan(plan);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "dismiss") {
    const hash = String(body.hash ?? "");
    if (!hash) return NextResponse.json({ error: "hash required" }, { status: 400 });
    dismissPlanMatch(hash);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
