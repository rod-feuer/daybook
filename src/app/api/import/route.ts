import { NextRequest, NextResponse } from "next/server";
import { importCsv } from "@/lib/import";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixture-only: the browser test suite builds its database through this
// route. Charges arrive from the bank, so in the app it doesn't exist.
const fixtures = () => process.env.COPILOT_FIXTURES === "1";

export async function POST(req: NextRequest) {
  if (!fixtures()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const text = await req.text();
  if (!text.trim())
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  try {
    const result = importCsv(text);
    if (result.inserted > 0) detectRecurrings(); // refresh patterns
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "import failed" },
      { status: 400 }
    );
  }
}
