import { getDb, ensureAccounts } from "./db";
import type { PlaidAccount, PlaidItem } from "./plaid";

type Side = "asset" | "liability";
type Kind = "cash" | "card" | "loan" | "mortgage" | "investment" | "property" | "vehicle" | "other";

// Plaid's account type says which side of net worth an account sits on: a card
// or loan's balance is what is owed, everything else's is what is held.
function classify(a: PlaidAccount): { side: Side; kind: Kind } {
  switch (a.type) {
    case "depository":
      return { side: "asset", kind: "cash" };
    case "investment":
    case "brokerage":
      return { side: "asset", kind: "investment" };
    case "credit":
      return { side: "liability", kind: "card" };
    case "loan":
      return { side: "liability", kind: a.subtype === "mortgage" ? "mortgage" : "loan" };
    default:
      return { side: "asset", kind: "other" };
  }
}

// Record today's balance for every account a sync pulled: one row per account
// per day, a later sync the same day replacing it. A new account is added with
// the bank's name, which it keeps (the owner renames it, not the bank). A
// relinked bank issues new account ids for accounts already held, which would
// add each one a second time and count it twice in net worth; an unknown id
// takes over the one held account at the same institution with the same mask
// and subtype that this pull no longer carries. Returns the balances recorded.
export function recordBalances(items: PlaidItem[], asOf: string): number {
  const db = getDb();
  ensureAccounts(db);
  const pulled = new Set(items.flatMap((i) => i.accounts.map((a) => a.account_id)));
  const held = db
    .prepare("SELECT id, plaidAccountId, institution, mask, subtype FROM accounts WHERE source = 'plaid'")
    .all() as { id: number; plaidAccountId: string; institution: string | null; mask: string | null; subtype: string | null }[];
  const byPlaidId = new Map(held.map((h) => [h.plaidAccountId, h.id]));
  const orphans = held.filter((h) => !pulled.has(h.plaidAccountId));

  const rekey = db.prepare("UPDATE accounts SET plaidAccountId = ? WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO accounts (source, plaidAccountId, institution, mask, subtype, name, side, kind)
     VALUES ('plaid', @plaidAccountId, @institution, @mask, @subtype, @name, @side, @kind)`
  );
  const upsertBalance = db.prepare(
    `INSERT INTO balances (accountId, asOf, amount, source) VALUES (?, ?, ?, 'bank')
     ON CONFLICT(accountId, asOf) DO UPDATE SET amount = excluded.amount, source = excluded.source`
  );

  let recorded = 0;
  db.transaction(() => {
    for (const item of items) {
      const institution = item.institution ?? null;
      for (const a of item.accounts) {
        let id = byPlaidId.get(a.account_id);
        if (id === undefined) {
          const same = orphans.filter(
            (h) => h.institution === institution && h.mask === (a.mask ?? null) && h.subtype === (a.subtype ?? null)
          );
          if (same.length === 1) {
            id = same[0].id;
            rekey.run(a.account_id, id);
            orphans.splice(orphans.indexOf(same[0]), 1);
          } else {
            id = Number(
              insert.run({
                plaidAccountId: a.account_id,
                institution,
                mask: a.mask ?? null,
                subtype: a.subtype ?? null,
                name: a.name,
                ...classify(a),
              }).lastInsertRowid
            );
          }
          byPlaidId.set(a.account_id, id);
        }
        const current = a.balances?.current;
        if (current == null) continue; // no balance from the bank: keep the last one, dated
        upsertBalance.run(id, asOf, current);
        recorded++;
      }
    }
  })();
  return recorded;
}

// Net worth on a day: each counted account's latest balance on or before it.
// An account that hasn't reported since carries its last balance and says
// when (asOf), so a stale figure never passes for that day's.
export type NetWorth = {
  owned: number;
  owed: number;
  net: number;
  accounts: { id: number; name: string; side: Side; kind: Kind; subtype: string | null; mask: string | null; amount: number; asOf: string; source: string }[];
};
export function netWorth(asOf: string): NetWorth {
  const db = getDb();
  ensureAccounts(db);
  const accounts = db
    .prepare(
      `SELECT a.id, a.name, a.side, a.kind, a.subtype, a.mask, b.amount, b.asOf, b.source
       FROM accounts a
       JOIN balances b ON b.accountId = a.id
        AND b.asOf = (SELECT MAX(asOf) FROM balances WHERE accountId = a.id AND asOf <= @asOf)
       WHERE a.hidden = 0 AND a.inNetWorth = 1
       ORDER BY a.side, a.kind, a.name`
    )
    .all({ asOf }) as NetWorth["accounts"];
  const sum = (side: Side) => accounts.filter((a) => a.side === side).reduce((t, a) => t + a.amount, 0);
  const owned = Number(sum("asset").toFixed(2));
  const owed = Number(sum("liability").toFixed(2));
  return { owned, owed, net: Number((owned - owed).toFixed(2)), accounts };
}
