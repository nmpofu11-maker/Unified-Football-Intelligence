import test from "node:test";
import assert from "node:assert/strict";
import { checkFixtureFreshness } from "../src/prediction/freshness.js";

test("accepts corroborated fixture evidence within the configured age", () => {
  assert.deepEqual(checkFixtureFreshness(
    "2026-10-17T10:00:00.000Z", "2026-10-17T11:00:00.000Z", 180
  ), { state: "fresh", ageMinutes: 60, maxAgeMinutes: 180 });
});

test("withholds fixture evidence older than the configured maximum age", () => {
  assert.deepEqual(checkFixtureFreshness(
    "2026-10-17T06:00:00.000Z", "2026-10-17T11:00:00.000Z", 180
  ), { state: "stale", ageMinutes: 300, maxAgeMinutes: 180 });
});

test("rejects evidence timestamps too far in the future", () => {
  const result = checkFixtureFreshness(
    "2026-10-17T11:10:00.000Z", "2026-10-17T11:00:00.000Z", 180
  );
  assert.equal(result.state, "invalid");
  if (result.state === "invalid") assert.equal(result.reason, "timestamp_in_future");
});

test("rejects invalid timestamps and unsafe freshness settings", () => {
  assert.equal(checkFixtureFreshness("not-a-date", "2026-10-17T11:00:00Z", 180).state, "invalid");
  const invalidPolicy = checkFixtureFreshness(
    "2026-10-17T10:00:00Z", "2026-10-17T11:00:00Z", 0
  );
  assert.equal(invalidPolicy.state, "invalid");
  if (invalidPolicy.state === "invalid") assert.equal(invalidPolicy.reason, "invalid_max_age");
});
