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

// What moved net worth since the comparison day: each counted account's
// effect, an asset rising adding and a debt rising subtracting, largest first.
// Accounts with no value then (none, given the like-for-like rule) move
// nothing. The effects add up to the change in net worth.
export type Mover = { id: number; name: string; side: "asset" | "liability"; effect: number; change: number };
export function movers<T extends Acct & { name: string }>(accounts: T[], prev: { id: number; amount: number }[]): Mover[] {
  const then = new Map(prev.map((p) => [p.id, p.amount]));
  return accounts
    .filter((a) => a.counted && then.has(a.id))
    .map((a) => {
      const change = Number((a.amount - then.get(a.id)!).toFixed(2));
      return { id: a.id, name: a.name, side: a.side, change, effect: a.side === "asset" ? change : -change };
    })
    .filter((m) => m.effect !== 0)
    .sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect));
}
