import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { normalizeMerchant } from "./merchant";

// The month of a budget entry that holds for every month (see budget_entries).
export const BUDGET_ALWAYS = "0000-01";

// Single shared connection. Next dev reloads modules, so cache on globalThis.
const DATA_DIR = path.join(process.cwd(), "data");
// The DB path is resolved at call time so tests (and seed tooling) can point at
// a throwaway file via COPILOT_DB_PATH and never touch the real data/copilot.db.
function dbPath(): string {
  const p = process.env.COPILOT_DB_PATH || path.join(DATA_DIR, "copilot.db");
  // Under `node --test`, a file that imports the DB before tests/helpers sets
  // COPILOT_DB_PATH would otherwise open the real finances. Refuse instead.
  if (process.env.NODE_TEST_CONTEXT && path.resolve(p) === path.join(DATA_DIR, "copilot.db")) {
    throw new Error("Refusing to open data/copilot.db under the test runner — import tests/helpers first.");
  }
  return p;
}

declare global {
  var __copilotDb: Database.Database | undefined;
  var __copilotDbPath: string | undefined;
}

function init(db: Database.Database) {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      icon TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
      excludeFromTotals INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      effectiveDate TEXT,
      merchant TEXT NOT NULL,
      amount REAL NOT NULL,
      categoryId INTEGER REFERENCES categories(id),
      account TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      excluded INTEGER NOT NULL DEFAULT 0,
      recurringId INTEGER REFERENCES recurrings(id),
      source TEXT NOT NULL DEFAULT 'seed',
      note TEXT,
      categoryByHand INTEGER NOT NULL DEFAULT 0,
      hash TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      categoryId INTEGER NOT NULL REFERENCES categories(id),
      origin TEXT NOT NULL DEFAULT 'user'
    );

    CREATE TABLE IF NOT EXISTS recurrings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant TEXT NOT NULL,
      categoryId INTEGER REFERENCES categories(id),
      avgAmount REAL NOT NULL,
      cadence TEXT NOT NULL,
      lastDate TEXT NOT NULL,
      nextDate TEXT NOT NULL,
      count INTEGER NOT NULL
    );


    -- Auto-split rules: when a transaction matches (merchant pattern + total
    -- amount), it is split into the category parts in the parts column (JSON).
    -- Used for combined charges like one Chubb payment covering two policies.
    CREATE TABLE IF NOT EXISTS split_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      amount REAL NOT NULL,
      parts TEXT NOT NULL
    );

    -- User overrides for recurring detection, keyed by merchant so they survive
    -- detectRecurrings() rebuilds. 'force' = treat as recurring even if not
    -- auto-detected; 'mute' = never treat as recurring.
    CREATE TABLE IF NOT EXISTS recurring_overrides (
      merchant TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('force','mute'))
    );

    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(categoryId);
  `);

  // Migration: add `excluded` to DBs created before this column existed.
  const cols = db.prepare("PRAGMA table_info(transactions)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "excluded")) {
    db.exec(
      "ALTER TABLE transactions ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0"
    );
  }

  // Migration: add `effectiveDate` override (the accounting date; null = use date).
  if (!cols.some((c) => c.name === "effectiveDate")) {
    db.exec("ALTER TABLE transactions ADD COLUMN effectiveDate TEXT");
  }

  // Migration: add a per-transaction `note` (a free-text memo; null = none).
  if (!cols.some((c) => c.name === "note")) {
    db.exec("ALTER TABLE transactions ADD COLUMN note TEXT");
  }

  // Migration: `categoryByHand` — the user picked this charge's category
  // (1), rather than a rule, history or a plan. A plan's category never
  // overwrites it. Never touched by the importer's upsert.
  if (!cols.some((c) => c.name === "categoryByHand")) {
    db.exec("ALTER TABLE transactions ADD COLUMN categoryByHand INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add `excludeFromTotals` to categories created before it existed.
  const catCols = db.prepare("PRAGMA table_info(categories)").all() as {
    name: string;
  }[];
  if (!catCols.some((c) => c.name === "excludeFromTotals")) {
    db.exec(
      "ALTER TABLE categories ADD COLUMN excludeFromTotals INTEGER NOT NULL DEFAULT 0"
    );
  }

  ensureBudgetEntries(db);
  ensureTxDescriptor(db);
  migrateMerchants(db);
  ensureRecurringSettings(db);
  ensureMerchantLinks(db);
  ensureCleanupLog(db);
  ensureRecurringTxExclusions(db);
  ensureRecurringTxInclusions(db);
  ensureMergeDismissals(db);
  ensurePlans(db);
  ensurePlanCharges(db);
  ensureAccounts(db);
}

// Individual charges the user flagged as one-offs, excluded from their
// merchant's recurring series. Keyed by the stable transaction hash so it
// survives re-imports and detectRecurrings() rebuilds. Idempotent; callable on
// the live connection so the feature works without a dev-server restart.
// A category's budget by month. A 'from' entry holds from its month until the
// next 'from' entry; an 'only' entry (monthly budgets) holds for its month
// alone. A null amount is "no budget" from that month on, so earlier months
// keep theirs. BUDGET_ALWAYS is the month of an entry that has held since
// before any data. Exported so the budget queries create it on the live
// connection without a restart (init only runs on a fresh connection).
export function ensureBudgetEntries(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS budget_entries (
      categoryId INTEGER NOT NULL REFERENCES categories(id),
      month TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('from','only')),
      amount REAL CHECK (amount IS NULL OR amount >= 0),
      period TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly','annual')),
      PRIMARY KEY (categoryId, month, scope)
    )
  `);
  // Migration: the old one-row-per-category budgets table becomes one 'from'
  // entry per category that has always held, so every month reads as before;
  // then the old table goes.
  const budgetCols = db.prepare("PRAGMA table_info(budgets)").all() as { name: string }[];
  if (!budgetCols.length) return;
  const period = budgetCols.some((c) => c.name === "period") ? "period" : "'monthly'";
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO budget_entries (categoryId, month, scope, amount, period)
       SELECT categoryId, ?, 'from', amount, ${period} FROM budgets`
    ).run(BUDGET_ALWAYS);
    db.exec("DROP TABLE budgets");
  })();
}

// The bank's own text for a Plaid charge (Plaid's `name`), kept beside the
// cleaned-up name the app files it under: "GP001 - CAPITOL COMMINDIANAPOLIS
// IN" is what says where a "Commissary" charge was. Null where the bank text
// is the stored name already (CSV imports) or unknown. Exported so the
// importer and the charge shelf add it on a live connection.
export function ensureTxDescriptor(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(transactions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "descriptor")) db.exec("ALTER TABLE transactions ADD COLUMN descriptor TEXT");
}

export function ensureRecurringTxExclusions(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS recurring_tx_exclusions (hash TEXT PRIMARY KEY)");
}

// The mirror: a charge the user put INTO a plan the detector left out (keyed
// by the plan's series name — the recurrings.merchant it links to on rebuild).
export function ensureRecurringTxInclusions(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS recurring_tx_inclusions (hash TEXT PRIMARY KEY, plan TEXT NOT NULL)");
}

// A plan the user confirmed: named it, set its amount, cadence or category,
// started it, or put a charge in it. Keyed by the plan key it had then, which
// never changes afterwards, so its settings and pins stay attached when the
// bill moves day or price. `amount` is signed, like the charges (a refund at
// a bill's price is not the bill); `day` and `anchorDate` are its newest
// charge's. A null categoryId follows the vendor. Plans the user never
// touched are not here: they stay derived.
export function ensurePlans(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS plans (
    key TEXT PRIMARY KEY,
    vendor TEXT NOT NULL,
    amount REAL NOT NULL,
    day INTEGER,
    cadence TEXT NOT NULL,
    categoryId INTEGER,
    anchorDate TEXT NOT NULL
  )`);
}

// A confirmed plan's charges, kept across rebuilds: the ones it held when it
// was confirmed and every one it has taken since. A plan's history is not one
// amount (a mortgage at three escrow prices), so matching by amount is only
// for charges it has not seen. Keyed by charge hash, like the pins; unlike a
// pin it is not the user's edit, so a charge here reads as auto.
export function ensurePlanCharges(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS plan_charges (hash TEXT PRIMARY KEY, key TEXT NOT NULL)");
}

// What the household owns and owes (POSITIONING §12, layer 1). An account is
// a bank link's account (source 'plaid', keyed by Plaid's account_id) or one
// the owner keeps by hand ('manual': a home, a vehicle, an unlinked account).
// `side` says how its balance counts in net worth; `kind` groups it. A
// balance is one per account per day, stored as Plaid states it: what the
// account holds for an asset, what is owed for a liability. `source` says
// where it came from: the bank, the owner, or the owner's estimate.
export function ensureAccounts(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('plaid','manual')),
      plaidAccountId TEXT UNIQUE,
      institution TEXT,
      mask TEXT,
      subtype TEXT,
      name TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('asset','liability')),
      kind TEXT NOT NULL CHECK (kind IN ('cash','card','loan','mortgage','investment','property','vehicle','other')),
      hidden INTEGER NOT NULL DEFAULT 0,
      inNetWorth INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS balances (
      accountId INTEGER NOT NULL REFERENCES accounts(id),
      asOf TEXT NOT NULL,
      amount REAL NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('bank','owner','estimate')),
      PRIMARY KEY (accountId, asOf)
    );
    -- A loan's terms: the annual rate (%), the monthly payment, the payoff
    -- date, and what was borrowed when. The bank fills what it reports (Plaid
    -- Liabilities); a field the owner sets is listed in \`edited\` and the bank
    -- no longer touches it. Null is unknown.
    CREATE TABLE IF NOT EXISTS loan_terms (
      accountId INTEGER PRIMARY KEY REFERENCES accounts(id),
      rate REAL,
      payment REAL,
      maturity TEXT,
      original REAL,
      opened TEXT,
      edited TEXT NOT NULL DEFAULT ''
    );
  `);
  // A loan's asset (a mortgage's home, a boat loan's boat), for equity.
  const cols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "securedBy")) db.exec("ALTER TABLE accounts ADD COLUMN securedBy INTEGER REFERENCES accounts(id)");
  // A loan kept by hand, paid from a linked account: the vendor its payments
  // post under ("Hyundai Motor Finance"), so each one lowers the balance.
  if (!cols.some((c) => c.name === "paidBy")) db.exec("ALTER TABLE accounts ADD COLUMN paidBy TEXT");
  // The owner's order within an Accounts section (dragged); null sorts after, by kind and name.
  if (!cols.some((c) => c.name === "position")) db.exec("ALTER TABLE accounts ADD COLUMN position INTEGER");
}

// Merge suggestions the user rejected, keyed by the proposed canonical name, so
// a dismissed "possible duplicate vendor" group never resurfaces in the queue.
export function ensureMergeDismissals(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS merchant_merge_dismissals (canonical TEXT PRIMARY KEY)");
}

// User-declared merchant identity: fold an `alias` descriptor into a
// `primaryMerchant` so they count as one vendor everywhere that groups by
// merchant (detection, paid-matching, the vendor drawer). Keyed by alias so it
// survives rebuilds. Idempotent; safe to ensure on the live connection.
export function ensureMerchantLinks(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_links (
      alias TEXT PRIMARY KEY,
      primaryMerchant TEXT NOT NULL
    )
  `);
}

// Per-recurring user settings, keyed by merchant so they survive
// detectRecurrings() rebuilds (like recurring_overrides). Holds match config
// (mode/text/tolerance) plus presentation overrides (alias, go-forward expected
// amount, cadence, next-due). All columns nullable — a row may set only some.
// Idempotent + migrates the v1 recurring_match_rules table into it, so it works
// on the live connection without a restart.
export function ensureRecurringSettings(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_settings (
      merchant TEXT PRIMARY KEY,
      matchMode TEXT,
      matchText TEXT,
      amountTolerance REAL,
      alias TEXT,
      expectedAmount REAL,
      cadence TEXT,
      nextDate TEXT,
      endedDate TEXT
    )
  `);
  // Migration: add `endedDate` (a canceled subscription's end date) to older DBs.
  const cols = db.prepare("PRAGMA table_info(recurring_settings)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "endedDate")) {
    db.exec("ALTER TABLE recurring_settings ADD COLUMN endedDate TEXT");
  }
  const old = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recurring_match_rules'")
    .get();
  if (old) {
    db.exec(
      `INSERT OR IGNORE INTO recurring_settings (merchant, matchMode, matchText, amountTolerance)
       SELECT merchant, matchMode, matchText, amountTolerance FROM recurring_match_rules`
    );
    db.exec("DROP TABLE recurring_match_rules");
  }
}

// Migration: add `rawMerchant` (the original bank descriptor) and normalize the
// stored `merchant` (see ./merchant). Backfill is guarded by rawMerchant IS NULL
// — it captures each original before normalizing, so it is reversible
// (UPDATE merchant = rawMerchant) and safe to run repeatedly. Exported so the
// recompute route can apply it on the live connection without a restart (init
// only runs on a fresh connection). Returns the number of rows backfilled.
export function migrateMerchants(db: Database.Database): number {
  const cols = db.prepare("PRAGMA table_info(transactions)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "rawMerchant")) {
    db.exec("ALTER TABLE transactions ADD COLUMN rawMerchant TEXT");
  }
  const pending = db
    .prepare("SELECT id, merchant FROM transactions WHERE rawMerchant IS NULL")
    .all() as { id: number; merchant: string }[];
  if (pending.length) {
    const upd = db.prepare(
      "UPDATE transactions SET rawMerchant = @raw, merchant = @norm WHERE id = @id"
    );
    db.transaction(() => {
      for (const r of pending) {
        upd.run({ id: r.id, raw: r.merchant, norm: normalizeMerchant(r.merchant) });
      }
    })();
  }
  return pending.length;
}

// Re-apply the current normalizer to every transaction's stored merchant,
// recomputed from the preserved original descriptor (rawMerchant). Unlike
// migrateMerchants — which only backfills rows that have no rawMerchant yet —
// this refreshes rows that were already normalized, so it's the way to clean up
// existing data after the normalizer itself improves. Reversible: rawMerchant is
// never touched. User aliases and merchant links keyed by a renamed merchant are
// carried onto the new name, so a cleanup never silently drops them. Returns the
// number of transactions whose merchant actually changed.
// Single-row log of the most recent cleanup, holding exactly what it changed so
// it can be reverted (single-level undo). Reset on each cleanup, cleared on undo.
export function ensureCleanupLog(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_cleanup_log (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    )
  `);
}

// What a cleanup changed, enough to reverse it precisely. Pairs are [from, to].
type CleanupUndo = {
  tx: [number, string][]; // [transactionId, previous merchant]
  settings: [string, string][];
  linkPrimary: [string, string][];
  linkAlias: [string, string][];
};

export function renormalizeMerchants(db: Database.Database): number {
  migrateMerchants(db); // guarantee every row has a rawMerchant to recompute from
  ensureRecurringSettings(db);
  ensureMerchantLinks(db);
  ensureCleanupLog(db);

  const rows = db
    .prepare("SELECT id, merchant, rawMerchant FROM transactions WHERE rawMerchant IS NOT NULL")
    .all() as { id: number; merchant: string; rawMerchant: string }[];

  const updTx = db.prepare("UPDATE transactions SET merchant = @to WHERE id = @id");
  const renames = new Map<string, string>(); // old → new, once per distinct merchant
  const undo: CleanupUndo = { tx: [], settings: [], linkPrimary: [], linkAlias: [] };

  db.transaction(() => {
    for (const r of rows) {
      const next = normalizeMerchant(r.rawMerchant);
      if (next !== r.merchant) {
        updTx.run({ id: r.id, to: next });
        undo.tx.push([r.id, r.merchant]);
        renames.set(r.merchant, next);
      }
    }
    // Carry settings/links onto the new name — but never clobber a name that
    // already has its own (rare collision: leave the old to orphan instead).
    // Record only what we actually applied, so undo reverses exactly that.
    const exists = (sql: string, v: string) => !!db.prepare(sql).get(v);
    for (const [from, to] of renames) {
      if (from === to) continue;
      if (!exists("SELECT 1 FROM recurring_settings WHERE merchant = ?", to)) {
        const res = db
          .prepare("UPDATE recurring_settings SET merchant = @to WHERE merchant = @from")
          .run({ from, to });
        if (res.changes > 0) undo.settings.push([from, to]);
      }
      const lp = db
        .prepare("UPDATE merchant_links SET primaryMerchant = @to WHERE primaryMerchant = @from")
        .run({ from, to });
      if (lp.changes > 0) undo.linkPrimary.push([from, to]);
      if (!exists("SELECT 1 FROM merchant_links WHERE alias = ?", to)) {
        const la = db
          .prepare("UPDATE merchant_links SET alias = @to WHERE alias = @from")
          .run({ from, to });
        if (la.changes > 0) undo.linkAlias.push([from, to]);
      }
    }
    db.prepare("INSERT OR REPLACE INTO merchant_cleanup_log (id, payload) VALUES (1, ?)").run(
      JSON.stringify(undo)
    );
  })();

  return undo.tx.length;
}

// Apply ONE proposed name fix (from → to) from the cleanup recommendation queue:
// rename just the transactions of `from` whose raw descriptor normalizes to `to`,
// carry its settings/links only if `from` is fully consumed, and record an undo
// (so the same Undo path reverses exactly this). Mirrors renormalizeMerchants,
// scoped to a single pair. Returns the number of transactions renamed.
export function applyNameCleanup(db: Database.Database, from: string, to: string): number {
  migrateMerchants(db);
  ensureRecurringSettings(db);
  ensureMerchantLinks(db);
  ensureCleanupLog(db);

  const rows = db
    .prepare("SELECT id, rawMerchant FROM transactions WHERE merchant = ? AND rawMerchant IS NOT NULL")
    .all(from) as { id: number; rawMerchant: string }[];

  const updTx = db.prepare("UPDATE transactions SET merchant = @to WHERE id = @id");
  const undo: CleanupUndo = { tx: [], settings: [], linkPrimary: [], linkAlias: [] };

  db.transaction(() => {
    for (const r of rows) {
      if (normalizeMerchant(r.rawMerchant) !== to) continue; // only the matching mapping
      updTx.run({ id: r.id, to });
      undo.tx.push([r.id, from]);
    }
    if (undo.tx.length === 0) return;

    // Carry settings/links onto the new name only when `from` is fully renamed to
    // `to` (no remaining rows under `from` mapping elsewhere) — same non-clobber
    // guards as the bulk cleanup.
    if (from !== to && undo.tx.length === rows.length) {
      const exists = (sql: string, v: string) => !!db.prepare(sql).get(v);
      if (!exists("SELECT 1 FROM recurring_settings WHERE merchant = ?", to)) {
        const res = db
          .prepare("UPDATE recurring_settings SET merchant = @to WHERE merchant = @from")
          .run({ from, to });
        if (res.changes > 0) undo.settings.push([from, to]);
      }
      const lp = db
        .prepare("UPDATE merchant_links SET primaryMerchant = @to WHERE primaryMerchant = @from")
        .run({ from, to });
      if (lp.changes > 0) undo.linkPrimary.push([from, to]);
      if (!exists("SELECT 1 FROM merchant_links WHERE alias = ?", to)) {
        const la = db
          .prepare("UPDATE merchant_links SET alias = @to WHERE alias = @from")
          .run({ from, to });
        if (la.changes > 0) undo.linkAlias.push([from, to]);
      }
    }
    db.prepare("INSERT OR REPLACE INTO merchant_cleanup_log (id, payload) VALUES (1, ?)").run(
      JSON.stringify(undo)
    );
  })();

  return undo.tx.length;
}

// True when the last cleanup hasn't been undone yet (drives the Undo affordance).
export function cleanupUndoAvailable(db: Database.Database): boolean {
  ensureCleanupLog(db);
  return !!db.prepare("SELECT 1 FROM merchant_cleanup_log WHERE id = 1").get();
}

// Revert the most recent cleanup: restore each transaction's prior merchant and
// reverse the settings/link re-keys it made, then drop the log. Returns the
// number of transactions restored (0 if there was nothing to undo).
export function undoRenormalizeMerchants(db: Database.Database): number {
  ensureCleanupLog(db);
  const row = db.prepare("SELECT payload FROM merchant_cleanup_log WHERE id = 1").get() as
    | { payload: string }
    | undefined;
  if (!row) return 0;
  const undo = JSON.parse(row.payload) as CleanupUndo;
  const updTx = db.prepare("UPDATE transactions SET merchant = @to WHERE id = @id");
  const exists = (sql: string, v: string) => !!db.prepare(sql).get(v);

  db.transaction(() => {
    for (const [id, prev] of undo.tx) updTx.run({ id, to: prev });
    // Reverse each recorded rename (to → from).
    for (const [from, to] of undo.settings)
      if (!exists("SELECT 1 FROM recurring_settings WHERE merchant = ?", from))
        db.prepare("UPDATE recurring_settings SET merchant = @from WHERE merchant = @to").run({ from, to });
    for (const [from, to] of undo.linkPrimary)
      db.prepare("UPDATE merchant_links SET primaryMerchant = @from WHERE primaryMerchant = @to").run({ from, to });
    for (const [from, to] of undo.linkAlias)
      if (!exists("SELECT 1 FROM merchant_links WHERE alias = ?", from))
        db.prepare("UPDATE merchant_links SET alias = @from WHERE alias = @to").run({ from, to });
    db.prepare("DELETE FROM merchant_cleanup_log WHERE id = 1").run();
  })();

  return undo.tx.length;
}

// Remove all data (used before a fresh full import). Categories/rules/recurrings
// are recreated by the importer.
export function wipeAll() {
  const db = getDb();
  ensureBudgetEntries(db);
  db.exec(`
    DELETE FROM transactions;
    DELETE FROM recurrings;
    DELETE FROM rules;
    DELETE FROM budget_entries;
    DELETE FROM categories;
  `);
}

export function getDb(): Database.Database {
  const p = dbPath();
  // Reuse the cached connection only if it's for the same path (so switching to
  // a test DB via COPILOT_DB_PATH opens a fresh one rather than reusing prod).
  if (global.__copilotDb && global.__copilotDbPath === p) return global.__copilotDb;
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(p);
  init(db);
  global.__copilotDb = db;
  global.__copilotDbPath = p;
  return db;
}

export function isSeeded(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as {
    n: number;
  };
  return row.n > 0;
}
