import { NextRequest, NextResponse } from "next/server";
import { monthThroughDay } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The days a month's figures cover: { through } is the last one (0 = none yet).
export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ error: "month required" }, { status: 400 });
  return NextResponse.json({ through: monthThroughDay(month) });
}
