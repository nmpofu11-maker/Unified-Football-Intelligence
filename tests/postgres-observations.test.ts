import test from "node:test";
import assert from "node:assert/strict";
import { getObservationStoreStatus, persistProviderObservations } from "../src/storage/postgresObservations.js";
import type { ProviderFixtureCandidate } from "../src/providers/provider.js";

function candidate(evidenceState: ProviderFixtureCandidate["evidenceState"] = "unverified"): ProviderFixtureCandidate {
  return {
    provider: "sportapi-ai",
    providerFixtureId: "fixture-1",
    kickoffUtc: "2026-10-13T18:00:00.000Z",
    home: { name: "Home FC" },
    away: { name: "Away FC" },
    competition: { name: "Example League" },
    status: "scheduled",
    observedAt: "2026-10-13T16:00:00.000Z",
    evidenceState,
    rawStatus: "Scheduled",
    provenance: { provider: "sportapi-ai", providerRecordId: "fixture-1", retrievedAt: "2026-10-13T16:00:00.000Z", evidenceState }
  };
}

test("observation storage fails closed and reports not configured without DATABASE_URL", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.deepEqual(await persistProviderObservations([]), {
      state: "not_configured", received: 0, inserted: 0, duplicatesSkipped: 0
    });
    assert.deepEqual(await getObservationStoreStatus(), {
      configured: false, state: "not_configured"
    });
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("observation storage refuses to persist a candidate already marked verified", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:5432/test";
  try {
    const result = await persistProviderObservations([candidate("verified")]);
    assert.equal(result.state, "error");
    assert.equal(result.errorCode, "observation_validation_failed");
    assert.equal(result.inserted, 0);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
