import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { setChargeVendor, createVendorRule } from "@/lib/vendorMoves";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Change vendor: this charge belongs to another vendor than its bank name's
// (the bank sends Google One as "Google"). `vendor` is a bank name; null is
// Reset, back to a rule's vendor or the bank name's. With `rule`, every
// charge under this bank name at this amount moves, now and as they arrive.
// Re-runs detection so the charge joins its vendor's plans at once.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const tx = getDb().prepare("SELECT hash, merchant, amount FROM transactions WHERE id = ?").get(Number(id)) as
    | { hash: string; merchant: string; amount: number }
    | undefined;
  if (!tx) return NextResponse.json({ error: "not found" }, { status: 404 });
  const vendor = body.vendor == null ? null : String(body.vendor).trim();
  if (vendor === "") return NextResponse.json({ error: "vendor required" }, { status: 400 });
  let moved = 0;
  if (vendor != null && body.rule) {
    // The owner's new word on this charge: clear an earlier move of theirs so
    // the rule takes it with the rest.
    setChargeVendor(tx.hash, null, "user");
    createVendorRule(tx.merchant, tx.amount, vendor);
    moved = (getDb().prepare("SELECT COUNT(*) AS n FROM charge_vendors WHERE ruleId = (SELECT MAX(id) FROM vendor_rules)").get() as { n: number }).n;
  } else {
    setChargeVendor(tx.hash, vendor, "user");
    moved = 1;
  }
  detectRecurrings();
  return NextResponse.json({ ok: true, moved });
}
