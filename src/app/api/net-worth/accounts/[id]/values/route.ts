import { NextRequest, NextResponse } from "next/server";
import { removeValue, setValue } from "@/lib/accounts";
import { cleanValue, isError } from "../../validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// A dated value on an account kept by hand; a linked account's is the bank's.
export async function POST(req: NextRequest, { params }: Ctx) {
  const value = cleanValue(await req.json());
  if (isError(value)) return NextResponse.json(value, { status: 400 });
  return setValue(Number((await params).id), value)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "a linked account's balance comes from the bank" }, { status: 400 });
}

// Remove one dated value (?asOf=YYYY-MM-DD), keeping at least one.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const asOf = req.nextUrl.searchParams.get("asOf") ?? "";
  return removeValue(Number((await params).id), asOf)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "that value can't be removed (an account keeps at least one)" }, { status: 400 });
}
