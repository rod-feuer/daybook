// Loans with what they're against, for the Accounts list. A counted loan
// pointing at a counted asset leaves the Loans section and is shown on that
// asset's row, whose figure becomes equity (worth less what's owed on it).
// A display change only: owned, owed and net worth are summed as before, from
// every counted account. A loan against an asset that isn't counted, or
// isn't listed, stays in Loans, so nothing disappears.
type Acct = { id: number; side: "asset" | "liability"; counted: boolean; securedBy: number | null; amount: number };

export function pairLoans<T extends Acct>(accounts: T[]): { loansOf: Map<number, T[]>; paired: Set<number> } {
  const assets = new Set(accounts.filter((a) => a.counted && a.side === "asset").map((a) => a.id));
  const loansOf = new Map<number, T[]>();
  const paired = new Set<number>();
  for (const l of accounts) {
    if (!l.counted || l.side !== "liability" || l.securedBy == null || !assets.has(l.securedBy)) continue;
    loansOf.set(l.securedBy, [...(loansOf.get(l.securedBy) ?? []), l]);
    paired.add(l.id);
  }
  return { loansOf, paired };
}

export const equityOf = <T extends Acct>(asset: T, loans: T[] = []) =>
  Number((asset.amount - loans.reduce((t, l) => t + l.amount, 0)).toFixed(2));
