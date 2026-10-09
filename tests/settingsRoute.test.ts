import { cleanDbBeforeEach, tx } from "./helpers"; // first: points the DB at a throwaway file
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRecurringSettings } from "../src/lib/queries";
import { POST } from "../src/app/api/recurrings/settings/route";

cleanDbBeforeEach();

// WHY: the expected amount is the latest charge. Its editor was never used
// (0 overrides on the owner's data) and was cut; the route no longer takes
// the field, so nothing can set a figure the shelf has no way to show as
// edited or undo but Reset all.
test("the settings route no longer sets an expected amount, and still saves the rest", async () => {
  tx("Netflix", { amount: -15.49 });
  const post = (body: object) => POST(new Request("http://x/api/recurrings/settings", { method: "POST", body: JSON.stringify(body) }) as never);
  await post({ merchant: "Netflix", expectedAmount: 99, alias: "Netflix Premium" });
  const s = getRecurringSettings()["Netflix"];
  assert.equal(s?.alias, "Netflix Premium", "the rename is saved");
  assert.equal(s?.expectedAmount ?? null, null, "the amount is not");
});
