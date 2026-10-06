import { test } from "node:test";
import assert from "node:assert/strict";
import { monthDayGap } from "../src/lib/cadence";

test("a monthly bill's day is measured on the calendar, short months included", () => {
  // WHY: counting every month as 31 days put Feb 28 four days from the 1st,
  // so a renamed bill posting a day early was refused as off its day.
  assert.equal(monthDayGap("2027-02-28", 1), 1, "Feb 28 is a day before Mar 1");
  assert.equal(monthDayGap("2026-09-30", 31), 0, "a bill on the 31st posts on Sep 30");
  assert.equal(monthDayGap("2026-10-01", 30), 1, "Oct 1 is a day after Sep 30");
  assert.equal(monthDayGap("2026-10-05", 1), 4, "four days after the 1st is four");
  assert.equal(monthDayGap("2026-12-30", 2), 3, "Dec 30 is three days before Jan 2");
});
