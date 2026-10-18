import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  getCanonicalEvidenceSummary,
  getObservationStoreStatus,
  getObservationStoreSummary,
  getReviewedProviderTeamIdentityMap,
  persistCanonicalEvidence,
  persistProviderObservations,
  persistTeamSearchObservations,
  saveReviewedSportApiTeamIdentityMapping,
  getStoredTeamIdentityMappings
} from "../src/storage/postgresObservations.js";
import type { ProviderFixtureCandidate } from "../src/providers/provider.js";
import { createTicket, listTickets, reconcilePendingTickets } from "../src/tickets/store.js";
import { listSavedPredictions } from "../src/prediction/pipeline.js";

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


test("PostgreSQL ticket reconciliation marks an accumulator lost immediately when one verified leg loses", async (t) => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip("DATABASE_URL is not set; the dedicated CI PostgreSQL step supplies it");
    return;
  }

  const fixtureId = `ci-ticket-fixture-${randomUUID()}`;
  const ticketId = `ci-ticket-${randomUUID()}`;
  const kickoffUtc = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const cleanupPool = new Pool({ connectionString, max: 1 });

  try {
    const schema = await getCanonicalEvidenceSummary();
    assert.equal(schema.state, "ready");

    await cleanupPool.query(
      `INSERT INTO canonical_fixture_evidence
        (canonical_key, kickoff_utc, home_name, away_name, competition_name, status, providers, evidence_state, identity_reviewed)
       VALUES ($1,$2,$3,$4,$5,'finished',$6,'corroborated',TRUE)`,
      [fixtureId, kickoffUtc, "Integration Home FC", "Integration Away FC", "Integration Test League", ["sportapi-ai", "sportmonks"]]
    );
    await cleanupPool.query(
      `INSERT INTO verified_settled_results
        (canonical_key, home_goals, away_goals, providers, evidence_state, verified_at)
       VALUES ($1,0,2,$2,'verified',NOW())`,
      [fixtureId, ["sportapi-ai", "sportmonks"]]
    );

    const created = await createTicket({
      ticketId,
      stakeAmount: 10,
      potentialPayout: 100,
      selections: [
        { selectionId: "lost-leg", fixtureId, market: "1x2", pick: "home" },
        { selectionId: "still-pending-leg", fixtureId: `missing-fixture-${randomUUID()}`, market: "1x2", pick: "home" }
      ]
    });
    assert.equal(created.state, "saved");

    const reconciliation = await reconcilePendingTickets();
    assert.equal(reconciliation.state, "ready");
    assert.equal(reconciliation.checked, 1);
    assert.equal(reconciliation.updated, 1);

    const listed = await listTickets(100);
    assert.equal(listed.state, "ready");
    assert.ok("tickets" in listed);
    const saved = listed.tickets.find((ticket: { ticket_id: string }) => ticket.ticket_id === ticketId) as
      | { status: string; settlement: { state: string; selections: Array<{ selectionId: string; state: string }> } }
      | undefined;
    assert.ok(saved);
    assert.equal(saved.status, "lost");
    assert.equal(saved.settlement.state, "lost");
    assert.equal(saved.settlement.selections.find(selection => selection.selectionId === "lost-leg")?.state, "lost");
    assert.equal(saved.settlement.selections.find(selection => selection.selectionId === "still-pending-leg")?.state, "pending");

    const events = await cleanupPool.query(
      "SELECT previous_status, next_status, reason FROM ticket_settlement_events WHERE ticket_id = $1",
      [ticketId]
    );
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0]?.previous_status, "pending");
    assert.equal(events.rows[0]?.next_status, "lost");
  } finally {
    await cleanupPool.query("DELETE FROM ticket_settlement_events WHERE ticket_id = $1", [ticketId]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM ticket_records WHERE ticket_id = $1", [ticketId]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM verified_settled_results WHERE canonical_key = $1", [fixtureId]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM canonical_fixture_evidence WHERE canonical_key = $1", [fixtureId]).catch(() => undefined);
    await cleanupPool.end();
  }
});


test("replay preserves existing canonical rows when supplied provider IDs are unreviewed and hides legacy unreviewed rows", async (t) => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip("DATABASE_URL is not set; the dedicated CI PostgreSQL step supplies it");
    return;
  }

  const reviewedFixtureId = `ci-reviewed-fixture-${randomUUID()}`;
  const legacyFixtureId = `ci-legacy-fixture-${randomUUID()}`;
  const observedAt = new Date().toISOString();
  const kickoffUtc = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const cleanupPool = new Pool({ connectionString, max: 1 });

  try {
    const schema = await getCanonicalEvidenceSummary();
    assert.equal(schema.state, "ready");
    for (const [fixtureId, identityReviewed] of [
      [reviewedFixtureId, true],
      [legacyFixtureId, false]
    ] as const) {
      await cleanupPool.query(
        `INSERT INTO canonical_fixture_evidence
          (canonical_key, kickoff_utc, home_name, away_name, competition_name, status, providers, evidence_state, identity_reviewed)
         VALUES ($1,$2,$3,$4,$5,'finished',$6,'corroborated',$7)`,
        [fixtureId, kickoffUtc, "Snapshot Home FC", "Snapshot Away FC", "Snapshot Test League", ["sportapi-ai", "sportmonks"], identityReviewed]
      );
      await cleanupPool.query(
        `INSERT INTO verified_settled_results
          (canonical_key, home_goals, away_goals, providers, evidence_state, verified_at)
         VALUES ($1,1,0,$2,'verified',NOW())`,
        [fixtureId, ["sportapi-ai", "sportmonks"]]
      );
    }

    const unreviewedCandidate: ProviderFixtureCandidate = {
      provider: "api-football",
      providerFixtureId: `ci-unmapped-provider-fixture-${randomUUID()}`,
      kickoffUtc,
      home: { name: "Snapshot Home FC", providerTeamId: "unreviewed-home-id" },
      away: { name: "Snapshot Away FC", providerTeamId: "unreviewed-away-id" },
      competition: { name: "Snapshot Test League" },
      status: "finished",
      score: { home: 1, away: 0 },
      observedAt,
      evidenceState: "unverified",
      rawStatus: "FT",
      provenance: {
        provider: "api-football",
        providerRecordId: "unreviewed-provider-fixture",
        retrievedAt: observedAt,
        evidenceState: "unverified"
      }
    };

    const replay = await persistCanonicalEvidence([unreviewedCandidate], { replaceSnapshot: true });
    assert.equal(replay.state, "connected_empty");
    assert.equal(replay.snapshotReplacementSkipped, true);

    const summary = await getCanonicalEvidenceSummary();
    assert.equal(summary.state, "ready");
    assert.ok(summary.fixtures?.some(fixture => fixture.id === reviewedFixtureId));
    assert.ok(!summary.fixtures?.some(fixture => fixture.id === legacyFixtureId));
    assert.equal(summary.verifiedSettledResultCount, 1);
  } finally {
    await cleanupPool.query("DELETE FROM verified_settled_results WHERE canonical_key = ANY($1::text[])", [[reviewedFixtureId, legacyFixtureId]]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM canonical_fixture_evidence WHERE canonical_key = ANY($1::text[])", [[reviewedFixtureId, legacyFixtureId]]).catch(() => undefined);
    await cleanupPool.end();
  }
});


test("unmapped SportAPI fixture IDs do not block a safe snapshot rebuild from mapped primary providers", async (t) => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip("DATABASE_URL is not set; the dedicated CI PostgreSQL step supplies it");
    return;
  }

  const suffix = randomUUID();
  const homeName = `Replay Home ${suffix}`;
  const awayName = `Replay Away ${suffix}`;
  const competitionName = `Replay League ${suffix}`;
  const oldFixtureId = `ci-old-snapshot-${suffix}`;
  const trackedHomeId = `ci-tracked-home-${suffix}`;
  const trackedAwayId = `ci-tracked-away-${suffix}`;
  const kickoffUtc = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const observedAt = new Date().toISOString();
  const cleanupPool = new Pool({ connectionString, max: 1 });

  const candidateFor = (
    provider: ProviderFixtureCandidate["provider"],
    homeProviderId: string,
    awayProviderId: string
  ): ProviderFixtureCandidate => ({
    provider,
    providerFixtureId: `${provider}-${suffix}`,
    kickoffUtc,
    home: { name: homeName, providerTeamId: homeProviderId },
    away: { name: awayName, providerTeamId: awayProviderId },
    competition: { name: competitionName },
    status: "finished",
    score: { home: 2, away: 0 },
    observedAt,
    evidenceState: "unverified",
    rawStatus: "FT",
    provenance: {
      provider,
      providerRecordId: `${provider}-${suffix}`,
      retrievedAt: observedAt,
      evidenceState: "unverified"
    }
  });

  try {
    const schema = await getCanonicalEvidenceSummary();
    assert.equal(schema.state, "ready");

    await cleanupPool.query(
      `INSERT INTO canonical_fixture_evidence
        (canonical_key, kickoff_utc, home_name, away_name, competition_name, status, providers, evidence_state, identity_reviewed)
       VALUES ($1,$2,$3,$4,$5,'finished',$6,'corroborated',TRUE)`,
      [oldFixtureId, kickoffUtc, homeName, awayName, competitionName, ["api-football", "sportmonks"]]
    );
    await cleanupPool.query(
      `INSERT INTO verified_settled_results
        (canonical_key, home_goals, away_goals, providers, evidence_state, verified_at)
       VALUES ($1,2,0,$2,'verified',NOW())`,
      [oldFixtureId, ["api-football", "sportmonks"]]
    );

    const mappings = [
      [trackedHomeId, homeName, "api-football", `api-home-${suffix}`],
      [trackedHomeId, homeName, "sportmonks", `sportmonks-home-${suffix}`],
      [trackedAwayId, awayName, "api-football", `api-away-${suffix}`],
      [trackedAwayId, awayName, "sportmonks", `sportmonks-away-${suffix}`]
    ] as const;
    for (const [trackedTeamId, canonicalName, provider, providerTeamId] of mappings) {
      await cleanupPool.query(
        `INSERT INTO team_identity_mappings
          (tracked_team_id, canonical_name, provider, mapping_state, provider_identity_state, provider_team_id, provider_team_name, country)
         VALUES ($1,$2,$3,'confirmed','cross_provider_confirmed',$4,$2,'Test Country')`,
        [trackedTeamId, canonicalName, provider, providerTeamId]
      );
    }

    const replay = await persistCanonicalEvidence([
      candidateFor("api-football", `api-home-${suffix}`, `api-away-${suffix}`),
      candidateFor("sportmonks", `sportmonks-home-${suffix}`, `sportmonks-away-${suffix}`),
      candidateFor("sportapi-ai", `sportapi-home-${suffix}`, `sportapi-away-${suffix}`)
    ], { replaceSnapshot: true });

    assert.equal(replay.state, "saved");
    assert.equal(replay.snapshotReplacementSkipped, undefined);
    assert.equal(replay.corroboratedFixtures, 1);
    assert.equal(replay.verifiedResults, 1);

    const summary = await getCanonicalEvidenceSummary();
    assert.equal(summary.state, "ready");
    assert.ok(!summary.fixtures?.some(fixture => fixture.id === oldFixtureId));
    assert.ok(summary.fixtures?.some(fixture =>
      fixture.home === homeName && fixture.away === awayName &&
      fixture.competition === competitionName && fixture.evidenceState === "corroborated"
    ));
  } finally {
    const rows = await cleanupPool.query<{ canonical_key: string }>(
      `SELECT canonical_key FROM canonical_fixture_evidence
       WHERE canonical_key = $1 OR (home_name = $2 AND away_name = $3 AND competition_name = $4)`,
      [oldFixtureId, homeName, awayName, competitionName]
    ).catch(() => ({ rows: [] as Array<{ canonical_key: string }> }));
    const keys = rows.rows.map(row => row.canonical_key);
    if (keys.length) {
      await cleanupPool.query("DELETE FROM verified_settled_results WHERE canonical_key = ANY($1::text[])", [keys]).catch(() => undefined);
      await cleanupPool.query("DELETE FROM canonical_fixture_evidence WHERE canonical_key = ANY($1::text[])", [keys]).catch(() => undefined);
    }
    await cleanupPool.query("DELETE FROM team_identity_mappings WHERE tracked_team_id = ANY($1::text[])", [[trackedHomeId, trackedAwayId]]).catch(() => undefined);
    await cleanupPool.end();
  }
});


test("forecast ledger labels legacy unreviewed fixture identities instead of presenting them as currently eligible", async (t) => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip("DATABASE_URL is not set; the dedicated CI PostgreSQL step supplies it");
    return;
  }

  const reviewedFixtureId = `ci-ledger-reviewed-${randomUUID()}`;
  const legacyFixtureId = `ci-ledger-legacy-${randomUUID()}`;
  const missingFixtureId = `ci-ledger-missing-${randomUUID()}`;
  const fixtureKeys = [reviewedFixtureId, legacyFixtureId, missingFixtureId];
  const kickoffUtc = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const generatedAt = new Date().toISOString();
  const cleanupPool = new Pool({ connectionString, max: 1 });

  try {
    const canonical = await getCanonicalEvidenceSummary();
    assert.equal(canonical.state, "ready");
    const ledger = await listSavedPredictions(100);
    assert.equal(ledger.state, "ready");

    for (const [fixtureId, identityReviewed] of [
      [reviewedFixtureId, true],
      [legacyFixtureId, false]
    ] as const) {
      await cleanupPool.query(
        `INSERT INTO canonical_fixture_evidence
          (canonical_key, kickoff_utc, home_name, away_name, competition_name, status, providers, evidence_state, identity_reviewed)
         VALUES ($1,$2,$3,$4,$5,'scheduled',$6,'corroborated',$7)`,
        [fixtureId, kickoffUtc, `Home ${fixtureId}`, `Away ${fixtureId}`, "Ledger Test League", ["api-football", "sportmonks"], identityReviewed]
      );
    }

    for (const fixtureId of fixtureKeys) {
      await cleanupPool.query(
        `INSERT INTO prediction_ledger
          (canonical_key, generated_at, model_id, model_version, evidence_hash, evidence_state, forecast, diagnostics)
         VALUES ($1,$2,$3,$4,$5,'exploratory',$6::jsonb,$7::jsonb)`,
        [fixtureId, generatedAt, `integration-${fixtureId}`, "test-v1", `hash-${fixtureId}`,
          JSON.stringify({ homeWin: null, draw: null, awayWin: null }), JSON.stringify({ test: true })]
      );
    }

    const result = await listSavedPredictions(100);
    assert.equal(result.state, "ready");
    const predictions = result.predictions as Array<{
      canonical_key: string;
      currently_identity_eligible: boolean;
      current_identity_status: string;
    }>;
    const reviewed = predictions.find(item => item.canonical_key === reviewedFixtureId);
    const legacy = predictions.find(item => item.canonical_key === legacyFixtureId);
    const missing = predictions.find(item => item.canonical_key === missingFixtureId);
    assert.equal(reviewed?.currently_identity_eligible, true);
    assert.equal(reviewed?.current_identity_status, "identity_gate_passed");
    assert.equal(legacy?.currently_identity_eligible, false);
    assert.equal(legacy?.current_identity_status, "legacy_unreviewed_identity");
    assert.equal(missing?.currently_identity_eligible, false);
    assert.equal(missing?.current_identity_status, "canonical_fixture_missing");
  } finally {
    await cleanupPool.query("DELETE FROM prediction_ledger WHERE canonical_key = ANY($1::text[])", [fixtureKeys]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM verified_settled_results WHERE canonical_key = ANY($1::text[])", [fixtureKeys]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM canonical_fixture_evidence WHERE canonical_key = ANY($1::text[])", [fixtureKeys]).catch(() => undefined);
    await cleanupPool.end();
  }
});


test("explicit SportAPI identity review persists an audited mapping only for a safe latest candidate", async (t) => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip("DATABASE_URL is not set; the dedicated CI PostgreSQL step supplies it");
    return;
  }

  const trackedTeamId = `ci-reviewed-sportapi-${randomUUID()}`;
  const goodProviderTeamId = `sportapi-good-${randomUUID()}`;
  const wrongCountryProviderTeamId = `sportapi-wrong-country-${randomUUID()}`;
  const searchedAt = new Date().toISOString();
  const cleanupPool = new Pool({ connectionString, max: 1 });
  const trackedTeam = {
    id: trackedTeamId,
    canonicalName: "15 de Agosto",
    country: "Angola",
    league: "Girabola",
    teamCategory: "senior"
  };

  try {
    const schema = await getCanonicalEvidenceSummary();
    assert.equal(schema.state, "ready");
    await cleanupPool.query(
      `INSERT INTO team_search_observations
        (tracked_team_id, tracked_team_name, provider, search_state, provider_team_id, provider_team_name, country, gender, team_type, league, searched_at)
       VALUES
        ($1,$2,'sportapi-ai','success',$3,'15 de Agosto','Angola','male','senior','Girabola',$5),
        ($1,$2,'sportapi-ai','success',$4,'15 de Agosto','France','male','senior','Foreign League',$5)`,
      [trackedTeamId, trackedTeam.canonicalName, goodProviderTeamId, wrongCountryProviderTeamId, searchedAt]
    );

    const rejected = await saveReviewedSportApiTeamIdentityMapping({
      trackedTeamId, providerTeamId: wrongCountryProviderTeamId, reviewedBy: "integration-test"
    }, [trackedTeam]);
    assert.equal(rejected.state, "unsafe_candidate");
    assert.equal(rejected.reason, "candidate_country_must_match_watchlist_country");

    const saved = await saveReviewedSportApiTeamIdentityMapping({
      trackedTeamId, providerTeamId: goodProviderTeamId, reviewedBy: "integration-test"
    }, [trackedTeam]);
    assert.equal(saved.state, "saved");
    assert.equal(saved.mapping?.providerTeamId, goodProviderTeamId);
    assert.equal(saved.mapping?.reviewedBy, "integration-test");

    const reviewedIds = await getReviewedProviderTeamIdentityMap();
    assert.equal(reviewedIds[`sportapi-ai:${goodProviderTeamId}`], trackedTeamId);
    assert.equal(reviewedIds[`sportapi-ai:${wrongCountryProviderTeamId}`], undefined);

    const audit = await cleanupPool.query(
      "SELECT provider_team_id, reviewed_by, action FROM provider_identity_review_events WHERE tracked_team_id = $1",
      [trackedTeamId]
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0]?.provider_team_id, goodProviderTeamId);
    assert.equal(audit.rows[0]?.reviewed_by, "integration-test");
    assert.equal(audit.rows[0]?.action, "confirmed");
  } finally {
    await cleanupPool.query("DELETE FROM provider_identity_review_events WHERE tracked_team_id = $1", [trackedTeamId]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM team_identity_mappings WHERE tracked_team_id = $1 AND provider = 'sportapi-ai'", [trackedTeamId]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM team_search_observations WHERE tracked_team_id = $1 AND provider = 'sportapi-ai'", [trackedTeamId]).catch(() => undefined);
    await cleanupPool.end();
  }
});


test("SportAPI identity approval requires saved safe candidate context, prevents collisions and records an audit event", async (t) => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip("DATABASE_URL is not set; the dedicated CI PostgreSQL step supplies it");
    return;
  }

  const suffix = randomUUID();
  const trackedTeamId = `review-team-${suffix}`;
  const secondTeamId = `review-team-second-${suffix}`;
  const providerTeamId = `sportapi-team-${suffix}`;
  const trackedTeams = [
    { id: trackedTeamId, canonicalName: `Review Club ${suffix}`, country: "Angola", teamCategory: "senior" },
    { id: secondTeamId, canonicalName: `Review Rival ${suffix}`, country: "Angola", teamCategory: "senior" }
  ];
  const cleanupPool = new Pool({ connectionString, max: 1 });
  try {
    const absent = await saveReviewedSportApiTeamIdentityMapping({
      trackedTeamId, providerTeamId, reviewedBy: "integration-test"
    }, trackedTeams);
    assert.equal(absent.state, "candidate_not_found");

    const persisted = await persistTeamSearchObservations([{
      trackedTeamId,
      canonicalName: trackedTeams[0]!.canonicalName,
      providers: [{
        provider: "sportapi-ai",
        state: "success",
        candidates: [{
          providerTeamId,
          name: trackedTeams[0]!.canonicalName,
          country: "Angola",
          gender: "male",
          teamType: "senior",
          league: "Girabola"
        }]
      }]
    }]);
    assert.equal(persisted.state, "saved");

    const saved = await saveReviewedSportApiTeamIdentityMapping({
      trackedTeamId, providerTeamId, reviewedBy: "integration-test"
    }, trackedTeams);
    assert.equal(saved.state, "saved");
    assert.equal(saved.mapping?.providerTeamId, providerTeamId);
    assert.equal(saved.mapping?.reviewedBy, "integration-test");

    const mappings = await getStoredTeamIdentityMappings();
    assert.equal(mappings.state, "ready");
    const team = mappings.mappings.find(item => item.trackedTeamId === trackedTeamId);
    assert.equal(team?.state, "confirmed");
    assert.equal(team?.providers.find(item => item.provider === "sportapi-ai")?.providerIdentityState, "operator_reviewed");

    const collision = await saveReviewedSportApiTeamIdentityMapping({
      trackedTeamId: secondTeamId, providerTeamId, reviewedBy: "integration-test"
    }, trackedTeams);
    assert.equal(collision.state, "conflict");

    const audit = await cleanupPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM provider_identity_review_events
       WHERE tracked_team_id = $1 AND provider = 'sportapi-ai' AND provider_team_id = $2 AND reviewed_by = $3`,
      [trackedTeamId, providerTeamId, "integration-test"]
    );
    assert.equal(Number(audit.rows[0]?.count), 1);
  } finally {
    await cleanupPool.query("DELETE FROM provider_identity_review_events WHERE tracked_team_id = ANY($1::text[])", [[trackedTeamId, secondTeamId]]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM team_identity_mappings WHERE tracked_team_id = ANY($1::text[])", [[trackedTeamId, secondTeamId]]).catch(() => undefined);
    await cleanupPool.query("DELETE FROM team_search_observations WHERE tracked_team_id = ANY($1::text[])", [[trackedTeamId, secondTeamId]]).catch(() => undefined);
    await cleanupPool.end();
  }
});
