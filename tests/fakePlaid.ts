// A stand-in for the Plaid CLI, for tests of the whole sync. Import this BEFORE
// ../src/lib/plaid: that module reads PLAID_CLI_PATH once, when it loads. The
// fake prints whatever `setBankPayload` last wrote, in the CLI's JSON shape.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-plaid-"));
const payload = path.join(dir, "payload.json");
const cli = path.join(dir, "plaid");
fs.writeFileSync(payload, JSON.stringify({ items: [] }));
fs.writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(${JSON.stringify(payload)}, "utf8"));\n`, { mode: 0o755 });
process.env.PLAID_CLI_PATH = cli;
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

export type BankTxn = { id: string; date: string; name: string; amount: number; pending?: boolean };
// Amounts use Plaid's sign: positive is money out.
// `balance` is the account's current balance, as Plaid sends it with the pull.
export function setBankPayload(txns: BankTxn[], balance?: number) {
  fs.writeFileSync(
    payload,
    JSON.stringify({
      items: [
        {
          item: { item_id: "item-1" },
          accounts: [{ account_id: "acct-1", name: "Visa", type: "credit", subtype: "credit card", mask: "0001", ...(balance === undefined ? {} : { balances: { current: balance } }) }],
          transactions: txns.map((t) => ({ transaction_id: t.id, account_id: "acct-1", date: t.date, name: t.name, merchant_name: t.name, amount: t.amount, pending: !!t.pending })),
        },
      ],
    })
  );
}
