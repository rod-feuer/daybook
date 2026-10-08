import { NextRequest, NextResponse } from "next/server";
import { recurringsForMonth } from "@/lib/queries";
import { localToday } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const month =
    req.nextUrl.searchParams.get("month") ?? localToday().slice(0, 7);
  return NextResponse.json(recurringsForMonth(month));
}
