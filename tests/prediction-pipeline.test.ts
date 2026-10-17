import { test } from "node:test";
import assert from "node:assert/strict";

// Contract-level tests: live database tests require a configured PostgreSQL service.
test("prediction pipeline module exposes strict stored-evidence operations", async () => {
  const mod = await import("../src/prediction/pipeline.js");
  assert.equal(typeof mod.predictStoredFixture, "function");
  assert.equal(typeof mod.saveReviewedTeamMapping, "function");
  assert.equal(typeof mod.listReviewedTeamMappings, "function");
  assert.equal(typeof mod.predictionStorageStatus, "function");
});

test("prediction refuses to claim availability when PostgreSQL is not configured", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const mod = await import("../src/prediction/pipeline.js");
    const result = await mod.predictStoredFixture("fixture-unknown");
    assert.deepEqual(result, { state: "unavailable", reason: "database_not_configured" });
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});
