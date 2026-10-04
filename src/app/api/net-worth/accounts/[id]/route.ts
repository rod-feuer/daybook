import { NextRequest, NextResponse } from "next/server";
import { accountDetail, deleteManualAccount, setSecuredBy, setTerms, updateAccount } from "@/lib/accounts";
import { cleanName, cleanTerms, isError } from "../validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const a = accountDetail(Number((await params).id));
  return a ? NextResponse.json(a) : NextResponse.json({ error: "not found" }, { status: 404 });
}

// Rename, or count in net worth or not (any account); a loan's terms and the
// asset it's against (a loan only).
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
  if (!updateAccount(id, patch)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (body.terms !== undefined) {
    const terms = cleanTerms(body.terms);
    if (isError(terms)) return NextResponse.json(terms, { status: 400 });
    if (!setTerms(id, terms)) return NextResponse.json({ error: "only a loan has terms" }, { status: 400 });
  }
  if (body.securedBy !== undefined) {
    const asset = body.securedBy === null ? null : Number(body.securedBy);
    if (!setSecuredBy(id, asset)) return NextResponse.json({ error: "a loan can only be against something owned" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

// Only an account kept by hand is deleted; a linked one is left out instead.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  return deleteManualAccount(Number((await params).id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "only an account you added can be deleted" }, { status: 400 });
}
