import { NextRequest, NextResponse } from "next/server";
import { setAccountOrder } from "@/lib/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A section's accounts in the order the owner dragged them into.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  if (!ids.length || ids.some((n: number) => !Number.isInteger(n))) return NextResponse.json({ error: "ids must be account ids" }, { status: 400 });
  setAccountOrder(ids);
  return NextResponse.json({ ok: true });
}
