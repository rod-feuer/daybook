import { NextResponse } from "next/server";
import { seed } from "@/lib/seed";
import { isSeeded } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixture-only: the browser test suite builds its database through this
// route. Charges arrive from the bank, so in the app it doesn't exist.
const fixtures = () => process.env.COPILOT_FIXTURES === "1";

export async function POST() {
  if (!fixtures()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const already = isSeeded();
  const inserted = seed();
  return NextResponse.json({ alreadyHadData: already, inserted });
}
