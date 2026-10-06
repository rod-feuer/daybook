import { NextRequest, NextResponse } from "next/server";
import { deleteVendorRule } from "@/lib/vendorMoves";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Remove a vendor rule: the charges it moved go back to their bank name's
// vendor (or another rule's).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteVendorRule(Number(id));
  detectRecurrings();
  return NextResponse.json({ ok: true });
}
