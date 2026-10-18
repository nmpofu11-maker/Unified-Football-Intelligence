import test from "node:test";
import assert from "node:assert/strict";
import { validateHistoricalDateRange } from "../src/providers/dateRange.js";

test("accepts bounded historical UTC date ranges", () => {
  assert.deepEqual(validateHistoricalDateRange("2026-10-01", "2026-10-07", "2026-10-18"), {
    state: "valid", from: "2026-10-01", to: "2026-10-07", daysInclusive: 7
  });
});

test("rejects invalid calendar dates and reversed ranges", () => {
  assert.equal(validateHistoricalDateRange("2026-02-30", "2026-03-01", "2026-10-18").state, "invalid");
  assert.equal(validateHistoricalDateRange("2026-10-08", "2026-10-01", "2026-10-18").state, "invalid");
});

test("rejects today, future dates, and ranges over the configured limit", () => {
  assert.equal(validateHistoricalDateRange("2026-10-17", "2026-10-18", "2026-10-18").state, "invalid");
  assert.equal(validateHistoricalDateRange("2026-10-19", "2026-10-19", "2026-10-18").state, "invalid");
  assert.equal(validateHistoricalDateRange("2026-10-01", "2026-10-08", "2026-10-18").state, "invalid");
});
