import type { NetWorth } from "@/lib/accounts";
import { shortDate } from "@/lib/format";
import { olderThanAYear } from "@/lib/accountKinds";

type Account = Pick<NetWorth["accounts"][number], "kind" | "origin" | "subtype" | "mask" | "source" | "asOf">;

// Plaid's subtypes are lower case; a few are initialisms.
const SUBTYPE: Record<string, string> = { ira: "IRA", roth: "Roth IRA", "401k": "401(k)", "403b": "403(b)", "457b": "457(b)", hsa: "HSA", "529": "529 plan", cd: "CD" };
// What the owner picks when adding an account, in their words.
export const KIND_LABEL: Record<string, string> = {
  property: "Home", vehicle: "Vehicle", cash: "Cash", investment: "Investment", loan: "Loan", other: "Other",
};

export { olderThanAYear };

// "IRA ··1234" for a linked account; "Home · estimate" for one kept by hand.
export function accountKind(a: Account): string {
  if (a.origin === "manual")
    return [KIND_LABEL[a.kind] ?? a.kind, a.source === "estimate" ? (a.kind === "loan" ? "from payments" : "estimate") : "set by you"].join(" · ");
  const sub = a.subtype ? (SUBTYPE[a.subtype] ?? a.subtype.charAt(0).toUpperCase() + a.subtype.slice(1)) : null;
  return sub && a.mask ? `${sub} ··${a.mask}` : (sub ?? "");
}

// When a figure isn't the page's day, its own date; an estimate over a year
// old says so (it's meant to be revisited).
export function accountWhen(a: Account, latest: string | null, today: string): string | null {
  if (a.source === "estimate" && olderThanAYear(a.asOf, today)) return `${shortDate(a.asOf)}, over a year old`;
  return a.asOf !== latest ? `as of ${shortDate(a.asOf)}` : null;
}
