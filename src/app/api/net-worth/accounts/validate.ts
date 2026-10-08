import { MANUAL_KINDS, TERM_FIELDS, type ManualKind, type OwnerValue, type TermField } from "@/lib/accounts";
import { localToday } from "@/lib/format";

// Shared checks for the account routes. Each returns the clean value or an
// error string the route sends back as a 400.
export function cleanName(v: unknown): string | { error: string } {
  const name = String(v ?? "").trim();
  if (!name) return { error: "a name is required" };
  if (name.length > 80) return { error: "a name is at most 80 characters" };
  return name;
}

export function cleanKind(v: unknown): ManualKind | { error: string } {
  return (MANUAL_KINDS as readonly string[]).includes(String(v)) ? (v as ManualKind) : { error: "unknown kind" };
}

// A value is dated today or earlier: a future balance hasn't happened.
export function cleanValue(body: { amount?: unknown; asOf?: unknown; estimate?: unknown }): OwnerValue | { error: string } {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return { error: "the value must be a number, zero or more" };
  const asOf = String(body.asOf ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf + "T00:00:00Z"))) return { error: "the date must be YYYY-MM-DD" };
  if (asOf > localToday()) return { error: "the date can't be in the future" };
  return { amount: Math.round(amount * 100) / 100, asOf, estimate: !!body.estimate };
}

export const isError = (v: unknown): v is { error: string } => typeof v === "object" && v !== null && "error" in v;

// A loan's terms patch: each field a value, or null to clear it. A rate is an
// annual percentage (0–100), money is zero or more, dates are YYYY-MM-DD.
export function cleanTerms(v: unknown): Partial<Record<TermField, number | string | null>> | { error: string } {
  if (typeof v !== "object" || v === null) return { error: "terms must be an object" };
  const out: Partial<Record<TermField, number | string | null>> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!(TERM_FIELDS as readonly string[]).includes(k)) return { error: `unknown term: ${k}` };
    const f = k as TermField;
    if (raw === null || raw === "") {
      out[f] = null;
    } else if (f === "maturity" || f === "opened") {
      const d = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + "T00:00:00Z"))) return { error: `${f} must be YYYY-MM-DD` };
      out[f] = d;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || (f === "rate" && n > 100)) return { error: f === "rate" ? "the rate is a percentage, 0 to 100" : `${f} must be zero or more` };
      out[f] = Math.round(n * (f === "rate" ? 1000 : 100)) / (f === "rate" ? 1000 : 100);
    }
  }
  return out;
}
