import { NextRequest, NextResponse } from "next/server";
import {
  setRecurringSetting,
  resetRecurringOverrides,
  confirmPlan,
  unconfirmPlan,
  getMerchantLinks,
  canonicalMerchant,
  getRecurringSettings,
  type RecurringSettings,
} from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CADENCES = ["weekly", "biweekly", "monthly", "bimonthly", "quarterly", "semiannual", "yearly"];

const ALL_NULL_SETTINGS = {
  matchMode: null,
  matchText: null,
  amountTolerance: null,
  alias: null,
  expectedAmount: null,
  cadence: null,
  nextDate: null,
  endedDate: null,
} as const;

// Update a recurring's per-merchant settings. Only keys present in the body are
// changed; send a key as null to clear it. `clear: true` removes every override
// except endedDate (see resetRecurringOverrides).
export async function POST(req: NextRequest) {
  const body = await req.json();
  const raw = String(body.merchant ?? "").trim();
  if (!raw) {
    return NextResponse.json({ error: "merchant required" }, { status: 400 });
  }
  // Settings belong to the canonical vendor, so an edit made from a folded-in
  // descriptor's shelf lands where the display name is read from (and isn't lost
  // on a non-canonical key). Migrate any setting stranded on the raw descriptor
  // by an earlier mis-keyed write onto the canonical before applying this patch.
  const merchant = canonicalMerchant(raw, getMerchantLinks());
  if (merchant !== raw) {
    const all = getRecurringSettings();
    const stranded = all[raw];
    if (stranded) {
      // Carry over only fields the canonical doesn't already set, so a real
      // canonical override is never clobbered by the orphan's nulls.
      const canon = all[merchant] ?? {};
      const fill = Object.fromEntries(
        Object.entries(stranded).filter(
          ([k, v]) => v != null && (canon as Record<string, unknown>)[k] == null
        )
      );
      if (Object.keys(fill).length) setRecurringSetting(merchant, fill);
      setRecurringSetting(raw, { ...ALL_NULL_SETTINGS }); // drop the orphan row
    }
  }

  if (body.clear) {
    resetRecurringOverrides(merchant);
    unconfirmPlan(merchant); // Reset all: the plan is the detector's again
    return NextResponse.json({ ok: true });
  }

  const patch: Partial<RecurringSettings> = {};
  if ("alias" in body) patch.alias = body.alias ? String(body.alias).trim() : null;
  if ("expectedAmount" in body)
    patch.expectedAmount =
      body.expectedAmount == null || body.expectedAmount === ""
        ? null
        : Math.abs(Number(body.expectedAmount));
  if ("cadence" in body)
    patch.cadence = CADENCES.includes(body.cadence) ? body.cadence : null;
  if ("nextDate" in body)
    patch.nextDate = body.nextDate ? String(body.nextDate).slice(0, 10) : null;
  if ("endedDate" in body)
    patch.endedDate = body.endedDate ? String(body.endedDate).slice(0, 10) : null;
  if ("matchMode" in body)
    patch.matchMode = body.matchMode === "contains" ? "contains" : body.matchMode === "exact" ? "exact" : null;
  if ("matchText" in body)
    patch.matchText = body.matchText ? String(body.matchText).trim() : null;
  if ("amountTolerance" in body)
    patch.amountTolerance =
      body.amountTolerance == null ? null : Number(body.amountTolerance);

  // A "contains" rule needs text; drop the rule if text is missing.
  if (patch.matchMode === "contains" && !patch.matchText) {
    patch.matchMode = null;
  }

  setRecurringSetting(merchant, patch);
  // Setting anything on a plan confirms it, so what was set stays on it when
  // the bill moves day or price.
  if (Object.values(patch).some((v) => v != null)) confirmPlan(merchant);
  return NextResponse.json({ ok: true });
}
