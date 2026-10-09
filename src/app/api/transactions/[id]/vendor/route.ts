import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { setChargeVendor } from "@/lib/vendorMoves";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Change vendor: this charge belongs to another vendor than its bank name's
// (the bank sends Google One as "Google"). `vendor` is a bank name; null is
// Reset, back to the bank name's. Re-runs detection so the charge joins its vendor's plans at once.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const tx = getDb().prepare("SELECT hash, merchant, amount FROM transactions WHERE id = ?").get(Number(id)) as
    | { hash: string; merchant: string; amount: number }
    | undefined;
  if (!tx) return NextResponse.json({ error: "not found" }, { status: 404 });
  const vendor = body.vendor == null ? null : String(body.vendor).trim();
  if (vendor === "") return NextResponse.json({ error: "vendor required" }, { status: 400 });
  setChargeVendor(tx.hash, vendor, "user");
  detectRecurrings();
  return NextResponse.json({ ok: true, moved: 1 });
}
