import { cleanDbBeforeEach } from "./helpers"; // first: points the DB at a throwaway file
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { POST as seed } from "../src/app/api/seed/route";
import { POST as importCsv } from "../src/app/api/import/route";

cleanDbBeforeEach();

// WHY: charges arrive from the bank. The seed and CSV routes only build the
// browser suite's fixture; in the app they wrote sample or hand-made charges
// beside real ones, and the Copilot import beside them wiped every charge,
// rule, budget and category when called. Without the fixture flag they don't
// exist.
test("the sample-data and CSV routes refuse outside the test fixture", async () => {
  const flag = process.env.COPILOT_FIXTURES;
  delete process.env.COPILOT_FIXTURES;
  try {
    const count = () => (getDb().prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n;
    const before = count();
    assert.equal((await seed()).status, 404, "Load sample data is gone");
    const csv = new Request("http://x/api/import", { method: "POST", body: "date,merchant,amount\n2026-10-01,Test,-5" });
    assert.equal((await importCsv(csv as never)).status, 404, "Import CSV is gone");
    assert.equal(count(), before, "and neither wrote a charge");
  } finally {
    if (flag !== undefined) process.env.COPILOT_FIXTURES = flag;
  }
});
