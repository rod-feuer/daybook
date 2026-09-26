import { NextRequest, NextResponse } from "next/server";
import {
  setRecurringOverride,
  unconfirmPlansFor,
  clearRecurringOverride,
  clearRecurringTxExclusionsForMerchant,
  merchantVariants,
} from "@/lib/queries";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mark a merchant as recurring ('force'), not recurring ('mute'), or remove the
// override ('clear'), then rebuild recurrings so it takes effect immediately.
// 'mute'/'clear' apply to every descriptor variant of the vendor; 'force'
// targets only the clicked merchant — recurring detection groups by exact
// merchant, so forcing every variant would spawn duplicate recurrings.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const merchant = String(body.merchant ?? "").trim();
  const status = body.status;
  if (!merchant) {
    return NextResponse.json({ error: "merchant required" }, { status: 400 });
  }
  if (status === "clear")
    for (const v of merchantVariants(merchant)) clearRecurringOverride(v);
  else if (status === "mute") {
    unconfirmPlansFor(merchant); // Not recurring: no plan of it stays confirmed
    for (const v of merchantVariants(merchant)) {
      setRecurringOverride(v, "mute");
      // No series → clear any stale per-charge one-off exclusions, so they don't
      // linger as a ghost "excluded from the series" marker on the charge.
      clearRecurringTxExclusionsForMerchant(v);
    }
  } else if (status === "force") setRecurringOverride(merchant, "force");
  else return NextResponse.json({ error: "invalid status" }, { status: 400 });

  detectRecurrings();
  return NextResponse.json({ ok: true });
}
