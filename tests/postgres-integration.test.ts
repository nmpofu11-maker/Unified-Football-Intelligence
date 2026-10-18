import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  getCanonicalEvidenceSummary,
  getObservationStoreStatus,
  getObservationStoreSummary,
  persistProviderObservations
} from "../src/storage/postgresObservations.js";
import type { ProviderFixtureCandidate } from "../src/providers/provider.js";

test("PostgreSQL persists raw observations idempotently without promoting them to verified evidence", async (t) => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip("DATABASE_URL is not set; the dedicated CI PostgreSQL step supplies it");
    return;
  }

  const fixtureId = `ci-integration-${randomUUID()}`;
  const observedAt = new Date().toISOString();
  const candidate: ProviderFixtureCandidate = {
    provider: "sportapi-ai",
    providerFixtureId: fixtureId,
    kickoffUtc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    home: { name: "Integration Home FC" },
    away: { name: "Integration Away FC" },
    competition: { name: "Integration Test League" },
    status: "scheduled",
    observedAt,
    evidenceState: "unverified",
    rawStatus: "Scheduled",
    provenance: {
      provider: "sportapi-ai",
      providerRecordId: fixtureId,
      retrievedAt: observedAt,
      evidenceState: "unverified"
    }
  };

  const cleanupPool = new Pool({ connectionString, max: 1 });
  try {
    const first = await persistProviderObservations([candidate]);
    assert.equal(first.state, "saved");
    assert.equal(first.received, 1);
    assert.equal(first.inserted, 1);
    assert.equal(first.duplicatesSkipped, 0);

    const duplicate = await persistProviderObservations([candidate]);
    assert.equal(duplicate.state, "saved");
    assert.equal(duplicate.inserted, 0);
    assert.equal(duplicate.duplicatesSkipped, 1);

    const status = await getObservationStoreStatus();
    assert.equal(status.state, "ready");
    assert.ok((status.observationCount ?? 0) >= 1);

    const summary = await getObservationStoreSummary();
    assert.equal(summary.state, "ready");
    assert.ok((summary.totalObservations ?? 0) >= 1);
    assert.ok((summary.unverifiedObservations ?? 0) >= 1);

    const canonical = await getCanonicalEvidenceSummary();
    assert.equal(canonical.state, "ready");
    assert.deepEqual(canonical.fixtures, []);
    assert.equal(canonical.verifiedSettledResultCount, 0);
  } finally {
    await cleanupPool.query(
      "DELETE FROM provider_fixture_observations WHERE provider = $1 AND provider_fixture_id = $2",
      ["sportapi-ai", fixtureId]
    ).catch(() => undefined);
    await cleanupPool.end();
  }
});
