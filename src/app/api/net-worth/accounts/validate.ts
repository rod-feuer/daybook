import { MANUAL_KINDS, type ManualKind, type OwnerValue } from "@/lib/accounts";

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
  if (asOf > new Date().toISOString().slice(0, 10)) return { error: "the date can't be in the future" };
  return { amount: Math.round(amount * 100) / 100, asOf, estimate: !!body.estimate };
}

export const isError = (v: unknown): v is { error: string } => typeof v === "object" && v !== null && "error" in v;
