import { NextRequest, NextResponse } from "next/server";
import { createManualAccount } from "@/lib/accounts";
import { cleanKind, cleanName, cleanValue, isError } from "./validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Add an account the owner keeps by hand (a home, a vehicle, an unlinked
// account), with its first value.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const name = cleanName(body.name);
  const kind = cleanKind(body.kind);
  const value = cleanValue(body);
  if (isError(name)) return NextResponse.json(name, { status: 400 });
  if (isError(kind)) return NextResponse.json(kind, { status: 400 });
  if (isError(value)) return NextResponse.json(value, { status: 400 });
  const id = createManualAccount(name, kind, value);
  return NextResponse.json({ ok: true, id });
}
