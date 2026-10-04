import { NextRequest, NextResponse } from "next/server";
import { accountDetail, deleteManualAccount, updateAccount } from "@/lib/accounts";
import { cleanName, isError } from "../validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const a = accountDetail(Number((await params).id));
  return a ? NextResponse.json(a) : NextResponse.json({ error: "not found" }, { status: 404 });
}

// Rename, or count in net worth or not. Any account, linked or kept by hand.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  const body = await req.json();
  const patch: { name?: string; counted?: boolean } = {};
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (isError(name)) return NextResponse.json(name, { status: 400 });
    patch.name = name;
  }
  if (body.counted !== undefined) patch.counted = !!body.counted;
  return updateAccount(id, patch)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}

// Only an account kept by hand is deleted; a linked one is left out instead.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  return deleteManualAccount(Number((await params).id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "only an account you added can be deleted" }, { status: 400 });
}
