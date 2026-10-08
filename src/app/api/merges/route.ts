import { NextRequest, NextResponse } from "next/server";
import { allMergeSuggestions, approveMerge, dismissMerge } from "@/lib/merges";
import { detectRecurrings } from "@/lib/core";
import { judgeVendorPairs } from "@/lib/vendorJudge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The "possible duplicate vendors" review queue (location-suffix variants,
// behaviour-based recurring matches, and the model's matches already asked).
export async function GET() {
  return NextResponse.json(allMergeSuggestions());
}

// Approve folds the variants into one vendor (then re-detects so recurrings
// regroup); dismiss remembers the rejection so the suggestion never reappears.
export async function POST(req: NextRequest) {
  const body = await req.json();

  // Ask the model about close-named vendors nobody has asked about; the queue
  // calls this on its own when it loads, then reads again.
  if (body.action === "judge") {
    return NextResponse.json(await judgeVendorPairs());
  }

  if (body.action === "dismiss") {
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
    if (!keys.length) return NextResponse.json({ error: "keys required" }, { status: 400 });
    for (const k of keys) dismissMerge(k);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "approve") {
    const canonical = String(body.canonical ?? "").trim();
    const variants = Array.isArray(body.variants) ? body.variants.map(String) : [];
    if (!canonical || variants.length < 2) {
      return NextResponse.json({ error: "canonical and variants required" }, { status: 400 });
    }
    const categoryId = typeof body.categoryId === "number" ? body.categoryId : undefined;
    approveMerge(canonical, variants, categoryId);
    detectRecurrings();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
