import { Pool, type PoolClient } from "pg";
import type { ProviderFixtureCandidate } from "../providers/provider.js";
import { previewCandidateReconciliation } from "../domain/reconcileCandidates.js";

export type ObservationPersistenceState = "saved" | "connected_empty" | "not_configured" | "error";

export interface ObservationPersistenceResult {
  state: ObservationPersistenceState;
  received: number;
  inserted: number;
  duplicatesSkipped: number;
  errorCode?: string;
}

export interface ObservationStoreStatus {
  configured: boolean;
  state: "ready" | "not_configured" | "error";
  observationCount?: number;
  errorCode?: string;
}

let pool: Pool | undefined;
let schemaReady = false;

function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() ?? "";
}

function getPool(): Pool | undefined {
  const connectionString = databaseUrl();
  if (!connectionString) return undefined;
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      allowExitOnIdle: true
    });
    pool.on("error", () => {
      // Do not log connection details or credentials.
    });
  }
  return pool;
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "28P01" || code === "28000") return "database_authentication_failed";
  if (code === "3D000") return "database_name_not_found";
  if (typeof code === "string" && code.startsWith("08")) return "database_connection_failed";
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ENOTFOUND") return "database_connection_failed";
  return "database_operation_failed";
}

async function ensureSchema(client: PoolClient): Promise<void> {
  if (schemaReady) return;
  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_fixture_observations (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_fixture_id TEXT NOT NULL,
      kickoff_utc TIMESTAMPTZ NOT NULL,
      home_name TEXT NOT NULL,
      away_name TEXT NOT NULL,
      competition_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled','live','finished','postponed','cancelled','abandoned','unknown')),
      score_home INTEGER,
      score_away INTEGER,
      observed_at TIMESTAMPTZ NOT NULL,
      evidence_state TEXT NOT NULL CHECK (evidence_state IN ('verified','unverified','stale','conflicted','unavailable','insufficient_evidence')),
      provenance JSONB NOT NULL,
      observation JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT provider_fixture_observations_score_pair CHECK (
        (score_home IS NULL AND score_away IS NULL) OR (score_home IS NOT NULL AND score_away IS NOT NULL AND score_home >= 0 AND score_away >= 0)
      ),
      CONSTRAINT provider_fixture_observations_identity UNIQUE (provider, provider_fixture_id, observed_at)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS provider_fixture_observations_kickoff_idx
    ON provider_fixture_observations (kickoff_utc)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS provider_fixture_observations_identity_lookup_idx
    ON provider_fixture_observations (provider, provider_fixture_id)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS canonical_fixture_evidence (
      canonical_key TEXT PRIMARY KEY,
      kickoff_utc TIMESTAMPTZ NOT NULL,
      home_name TEXT NOT NULL,
      away_name TEXT NOT NULL,
      competition_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled','live','finished','postponed','cancelled','abandoned','unknown')),
      providers TEXT[] NOT NULL,
      evidence_state TEXT NOT NULL CHECK (evidence_state IN ('corroborated','conflicted')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS verified_settled_results (
      canonical_key TEXT PRIMARY KEY REFERENCES canonical_fixture_evidence(canonical_key),
      home_goals INTEGER NOT NULL CHECK (home_goals >= 0),
      away_goals INTEGER NOT NULL CHECK (away_goals >= 0),
      providers TEXT[] NOT NULL,
      evidence_state TEXT NOT NULL CHECK (evidence_state IN ('verified','conflicted')),
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      conflict_reason TEXT
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS canonical_team_registry (
      team_id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      aliases TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_team_mappings (
      provider TEXT NOT NULL,
      provider_team_id TEXT NOT NULL,
      team_id TEXT NOT NULL REFERENCES canonical_team_registry(team_id) ON DELETE RESTRICT,
      provider_team_name TEXT NOT NULL,
      reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, provider_team_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS provider_team_mappings_team_idx
    ON provider_team_mappings (team_id)
  `);
  schemaReady = true;
}

function validObservation(candidate: ProviderFixtureCandidate): boolean {
  return Boolean(
    candidate.provider.trim() &&
    candidate.providerFixtureId.trim() &&
    candidate.home.name.trim() &&
    candidate.away.name.trim() &&
    candidate.competition.name.trim() &&
    Number.isFinite(Date.parse(candidate.kickoffUtc)) &&
    Number.isFinite(Date.parse(candidate.observedAt)) &&
    candidate.evidenceState === "unverified" &&
    (!candidate.score || (
      Number.isInteger(candidate.score.home) && candidate.score.home >= 0 &&
      Number.isInteger(candidate.score.away) && candidate.score.away >= 0
    ))
  );
}

/**
 * Appends raw provider observations only. It does not create canonical fixtures
 * or promote any score/result to verified evidence.
 */
export async function persistProviderObservations(
  candidates: ProviderFixtureCandidate[]
): Promise<ObservationPersistenceResult> {
  const configuredPool = getPool();
  if (!configuredPool) {
    return { state: "not_configured", received: candidates.length, inserted: 0, duplicatesSkipped: 0 };
  }
  const valid = candidates.filter(validObservation);
  if (valid.length !== candidates.length) {
    return {
      state: "error", received: candidates.length, inserted: 0, duplicatesSkipped: 0,
      errorCode: "observation_validation_failed"
    };
  }
  let client: PoolClient | undefined;
  let inserted = 0;
  try {
    client = await configuredPool.connect();
    // Create/verify the schema outside the observation transaction. Otherwise a later
    // insert failure could roll back DDL after schemaReady has been set to true.
    await ensureSchema(client);
    await client.query("BEGIN");
    for (const candidate of valid) {
      const result = await client.query(
        `INSERT INTO provider_fixture_observations
          (provider, provider_fixture_id, kickoff_utc, home_name, away_name, competition_name,
           status, score_home, score_away, observed_at, evidence_state, provenance, observation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
         ON CONFLICT (provider, provider_fixture_id, observed_at) DO NOTHING
         RETURNING id`,
        [
          candidate.provider, candidate.providerFixtureId, candidate.kickoffUtc,
          candidate.home.name, candidate.away.name, candidate.competition.name,
          candidate.status, candidate.score?.home ?? null, candidate.score?.away ?? null,
          candidate.observedAt, candidate.evidenceState, JSON.stringify(candidate.provenance),
          JSON.stringify(candidate)
        ]
      );
      inserted += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return {
      state: valid.length === 0 ? "connected_empty" : "saved",
      received: candidates.length,
      inserted,
      duplicatesSkipped: valid.length - inserted
    };
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    return {
      state: "error", received: candidates.length, inserted: 0, duplicatesSkipped: 0,
      errorCode: safeErrorCode(error)
    };
  } finally {
    client?.release();
  }
}

export async function getObservationStoreStatus(): Promise<ObservationStoreStatus> {
  const configuredPool = getPool();
  if (!configuredPool) return { configured: false, state: "not_configured" };
  let client: PoolClient | undefined;
  try {
    client = await configuredPool.connect();
    await ensureSchema(client);
    const result = await client.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM provider_fixture_observations"
    );
    return { configured: true, state: "ready", observationCount: result.rows[0]?.count ?? 0 };
  } catch (error) {
    return { configured: true, state: "error", errorCode: safeErrorCode(error) };
  } finally {
    client?.release();
  }
}

export interface CanonicalEvidencePersistenceResult {
  state: "saved" | "connected_empty" | "not_configured" | "error";
  corroboratedFixtures: number;
  verifiedResults: number;
  conflictedGroups: number;
  errorCode?: string;
}

/**
 * Persists only conservative cross-provider matches. A finished score is eligible
 * only when at least two distinct providers agree on fixture identity, finished
 * status, and the same score; single-source or incomplete evidence never qualifies.
 */
export async function persistCanonicalEvidence(
  candidates: ProviderFixtureCandidate[],
  options: { replaceSnapshot?: boolean } = {}
): Promise<CanonicalEvidencePersistenceResult> {
  const configuredPool = getPool();
  if (!configuredPool) {
    return { state: "not_configured", corroboratedFixtures: 0, verifiedResults: 0, conflictedGroups: 0 };
  }
  const previews = previewCandidateReconciliation(candidates);
  const corroborated = previews.filter(p => p.state === "corroborated" && p.providers.length >= 2);
  const conflicted = previews.filter(p => p.state === "conflicted");
  const eligibleResults = corroborated.filter(p =>
    p.statuses.length === 1 && p.statuses[0] === "finished" &&
    p.scores.length === 1 && !p.reasons.includes("finished_observation_missing_score")
  );
  let client: PoolClient | undefined;
  let savedFixtures = 0;
  let savedResults = 0;
  try {
    client = await configuredPool.connect();
    await ensureSchema(client);
    await client.query("BEGIN");
    // A replay is a full reconstruction from the latest snapshot of every stored
    // provider fixture identity. Remove stale canonical keys first, including old
    // competition-label variants, while keeping raw observations immutable.
    if (options.replaceSnapshot && candidates.length > 0) {
      await client.query("DELETE FROM verified_settled_results");
      await client.query("DELETE FROM canonical_fixture_evidence");
    }
    // Batch canonical writes instead of issuing one network round-trip per fixture.
    // Replay commonly handles hundreds of candidates; sequential queries can exceed
    // HTTP timeouts even when the database itself is healthy.
    const fixtureRows = [...corroborated, ...conflicted].map(fixture => ({
      canonical_key: fixture.key,
      kickoff_utc: fixture.kickoffUtc,
      home_name: fixture.home,
      away_name: fixture.away,
      competition_name: fixture.competition,
      status: fixture.statuses.length === 1 ? fixture.statuses[0]! : "unknown",
      providers: fixture.providers,
      evidence_state: fixture.state === "conflicted" ? "conflicted" : "corroborated"
    }));
    if (fixtureRows.length > 0) {
      const fixtureWrite = await client.query(
        `INSERT INTO canonical_fixture_evidence
          (canonical_key, kickoff_utc, home_name, away_name, competition_name, status, providers, evidence_state)
         SELECT x.canonical_key, x.kickoff_utc, x.home_name, x.away_name, x.competition_name,
                x.status, x.providers, x.evidence_state
         FROM jsonb_to_recordset($1::jsonb) AS x(
           canonical_key text, kickoff_utc timestamptz, home_name text, away_name text,
           competition_name text, status text, providers text[], evidence_state text
         )
         ON CONFLICT (canonical_key) DO UPDATE SET
           kickoff_utc = EXCLUDED.kickoff_utc,
           home_name = EXCLUDED.home_name,
           away_name = EXCLUDED.away_name,
           competition_name = EXCLUDED.competition_name,
           status = EXCLUDED.status,
           providers = ARRAY(SELECT DISTINCT unnest(canonical_fixture_evidence.providers || EXCLUDED.providers)),
           evidence_state = CASE WHEN canonical_fixture_evidence.evidence_state = 'conflicted' OR EXCLUDED.evidence_state = 'conflicted' THEN 'conflicted' ELSE 'corroborated' END,
           updated_at = NOW()
         RETURNING canonical_key`,
        [JSON.stringify(fixtureRows)]
      );
      savedFixtures = fixtureWrite.rowCount ?? 0;
    }

    const resultRows = eligibleResults.map(fixture => ({
      canonical_key: fixture.key,
      home_goals: fixture.scores[0]!.home,
      away_goals: fixture.scores[0]!.away,
      providers: fixture.providers
    }));
    if (resultRows.length > 0) {
      await client.query(
        `INSERT INTO verified_settled_results
          (canonical_key, home_goals, away_goals, providers, evidence_state, conflict_reason)
         SELECT x.canonical_key, x.home_goals, x.away_goals, x.providers, 'verified', NULL
         FROM jsonb_to_recordset($1::jsonb) AS x(
           canonical_key text, home_goals integer, away_goals integer, providers text[]
         )
         ON CONFLICT (canonical_key) DO UPDATE SET
           evidence_state = CASE
             WHEN verified_settled_results.home_goals = EXCLUDED.home_goals
              AND verified_settled_results.away_goals = EXCLUDED.away_goals
              AND verified_settled_results.evidence_state = 'verified'
             THEN 'verified' ELSE 'conflicted' END,
           conflict_reason = CASE
             WHEN verified_settled_results.home_goals = EXCLUDED.home_goals
              AND verified_settled_results.away_goals = EXCLUDED.away_goals
             THEN verified_settled_results.conflict_reason ELSE 'subsequent_provider_score_disagreement' END,
           providers = ARRAY(SELECT DISTINCT unnest(verified_settled_results.providers || EXCLUDED.providers)),
           verified_at = NOW()`,
        [JSON.stringify(resultRows)]
      );
      savedResults = resultRows.length;
    }

    if (conflicted.length > 0) {
      await client.query(
        `UPDATE verified_settled_results SET evidence_state = 'conflicted',
           conflict_reason = 'provider_status_or_score_disagreement', verified_at = NOW()
         WHERE canonical_key = ANY($1::text[])`,
        [conflicted.map(fixture => fixture.key)]
      );
    }
    await client.query("COMMIT");
    return {
      state: corroborated.length + conflicted.length === 0 ? "connected_empty" : "saved",
      corroboratedFixtures: corroborated.length,
      verifiedResults: eligibleResults.length,
      conflictedGroups: conflicted.length
    };
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    return { state: "error", corroboratedFixtures: 0, verifiedResults: 0, conflictedGroups: 0, errorCode: safeErrorCode(error) };
  } finally {
    client?.release();
  }
}

export interface StoredObservationReplayResult {
  state: "saved" | "connected_empty" | "not_configured" | "error";
  latestObservationsLoaded: number;
  canonicalEvidence: CanonicalEvidencePersistenceResult;
  reconciliationDiagnostics?: {
    groups: number;
    singleSourceGroups: number;
    corroboratedGroups: number;
    conflictedGroups: number;
    staleLiveGroups: number;
    conflictReasonCounts: Record<string, number>;
    conflictSamples: Array<{
      home: string; away: string; competition: string; kickoffUtc: string;
      providers: string[]; statuses: string[]; scores: Array<{ home: number; away: number }>;
      reasons: string[];
    }>;
  };
  errorCode?: string;
}

/**
 * Replays the latest persisted snapshot for each provider fixture identity.
 * Older snapshots are excluded so prior scheduled/live states cannot conflict
 * with a later final result from the same provider fixture ID.
 */
export async function replayStoredProviderObservations(): Promise<StoredObservationReplayResult> {
  const configuredPool = getPool();
  if (!configuredPool) {
    return {
      state: "not_configured",
      latestObservationsLoaded: 0,
      canonicalEvidence: { state: "not_configured", corroboratedFixtures: 0, verifiedResults: 0, conflictedGroups: 0 }
    };
  }

  let client: PoolClient | undefined;
  let candidates: ProviderFixtureCandidate[] = [];
  try {
    client = await configuredPool.connect();
    await ensureSchema(client);
    const result = await client.query<{ observation: unknown }>(`
      SELECT DISTINCT ON (provider, provider_fixture_id) observation
      FROM provider_fixture_observations
      ORDER BY provider, provider_fixture_id, observed_at DESC, id DESC
    `);
    candidates = result.rows.flatMap(row => {
      try {
        const value = typeof row.observation === "string" ? JSON.parse(row.observation) : row.observation;
        if (!value || typeof value !== "object") return [];
        const candidate = value as ProviderFixtureCandidate;
        if (
          typeof candidate.provider !== "string" ||
          typeof candidate.providerFixtureId !== "string" ||
          typeof candidate.kickoffUtc !== "string" ||
          typeof candidate.home?.name !== "string" ||
          typeof candidate.away?.name !== "string" ||
          typeof candidate.competition?.name !== "string" ||
          typeof candidate.status !== "string" ||
          !Number.isFinite(Date.parse(candidate.kickoffUtc))
        ) return [];
        return [candidate];
      } catch {
        return [];
      }
    });
  } catch (error) {
    const errorCode = safeErrorCode(error);
    return {
      state: "error",
      latestObservationsLoaded: 0,
      canonicalEvidence: { state: "error", corroboratedFixtures: 0, verifiedResults: 0, conflictedGroups: 0, errorCode },
      errorCode
    };
  } finally {
    client?.release();
  }

  // Return safe aggregate diagnostics so the operator can identify why stored
  // provider observations fail to reconcile, without exposing raw payloads or secrets.
  const previews = previewCandidateReconciliation(candidates);
  const conflictReasonCounts: Record<string, number> = {};
  for (const preview of previews.filter(item => item.state === "conflicted")) {
    for (const reason of preview.reasons) {
      conflictReasonCounts[reason] = (conflictReasonCounts[reason] ?? 0) + 1;
    }
  }
  const reconciliationDiagnostics = {
    groups: previews.length,
    singleSourceGroups: previews.filter(item => item.state === "single_source").length,
    corroboratedGroups: previews.filter(item => item.state === "corroborated").length,
    conflictedGroups: previews.filter(item => item.state === "conflicted").length,
    staleLiveGroups: previews.filter(item => item.reasons.includes("stale_live_status")).length,
    conflictReasonCounts,
    conflictSamples: previews.filter(item => item.state === "conflicted").slice(0, 10).map(item => ({
      home: item.home, away: item.away, competition: item.competition, kickoffUtc: item.kickoffUtc,
      providers: item.providers, statuses: item.statuses, scores: item.scores, reasons: item.reasons
    }))
  };
  const canonicalEvidence = await persistCanonicalEvidence(candidates, { replaceSnapshot: true });
  return {
    state: canonicalEvidence.state,
    latestObservationsLoaded: candidates.length,
    canonicalEvidence,
    reconciliationDiagnostics,
    ...(canonicalEvidence.errorCode ? { errorCode: canonicalEvidence.errorCode } : {})
  };
}

export interface CanonicalEvidenceSummary {
  configured: boolean;
  state: "ready" | "not_configured" | "error";
  corroboratedFixtureCount?: number;
  verifiedSettledResultCount?: number;
  conflictedFixtureCount?: number;
  staleLiveFixtureCount?: number;
  fixtures?: Array<{
    id: string; kickoffUtc: string; home: string; away: string; competition: string;
    status: string; providers: string[]; evidenceState: string;
    score?: { home: number; away: number };
  }>;
  errorCode?: string;
}

/** Read-only canonical evidence view. Conflicted results are never exposed as verified. */
export async function getCanonicalEvidenceSummary(): Promise<CanonicalEvidenceSummary> {
  const configuredPool = getPool();
  if (!configuredPool) return { configured: false, state: "not_configured" };
  let client: PoolClient | undefined;
  try {
    client = await configuredPool.connect();
    await ensureSchema(client);
    const counts = await client.query<{
      fixtures: number; verified_results: number; conflicted_fixtures: number; stale_live_fixtures: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::integer FROM canonical_fixture_evidence
          WHERE evidence_state = 'corroborated'
            AND NOT (status = 'live' AND kickoff_utc < NOW() - INTERVAL '6 hours')) AS fixtures,
        (SELECT COUNT(*)::integer FROM verified_settled_results WHERE evidence_state = 'verified') AS verified_results,
        (SELECT COUNT(*)::integer FROM canonical_fixture_evidence
          WHERE evidence_state = 'conflicted') AS conflicted_fixtures,
        (SELECT COUNT(*)::integer FROM canonical_fixture_evidence
          WHERE evidence_state = 'corroborated' AND status = 'live'
            AND kickoff_utc < NOW() - INTERVAL '6 hours') AS stale_live_fixtures
    `);
    const rows = await client.query<{
      canonical_key: string; kickoff_utc: Date; home_name: string; away_name: string;
      competition_name: string; status: string; providers: string[]; evidence_state: string;
      home_goals: number | null; away_goals: number | null;
    }>(`
      SELECT f.canonical_key, f.kickoff_utc, f.home_name, f.away_name, f.competition_name,
             f.status, f.providers, f.evidence_state, r.home_goals, r.away_goals
      FROM canonical_fixture_evidence f
      LEFT JOIN verified_settled_results r
        ON r.canonical_key = f.canonical_key AND r.evidence_state = 'verified'
      WHERE f.evidence_state = 'corroborated'
        AND NOT (f.status = 'live' AND f.kickoff_utc < NOW() - INTERVAL '6 hours')
      ORDER BY f.kickoff_utc ASC
      LIMIT 500
    `);
    const c = counts.rows[0];
    return {
      configured: true, state: "ready",
      corroboratedFixtureCount: c?.fixtures ?? 0,
      verifiedSettledResultCount: c?.verified_results ?? 0,
      conflictedFixtureCount: c?.conflicted_fixtures ?? 0,
      staleLiveFixtureCount: c?.stale_live_fixtures ?? 0,
      fixtures: rows.rows.map(row => ({
        id: row.canonical_key, kickoffUtc: row.kickoff_utc.toISOString(),
        home: row.home_name, away: row.away_name, competition: row.competition_name,
        status: row.status, providers: row.providers, evidenceState: row.evidence_state,
        ...(row.home_goals !== null && row.away_goals !== null
          ? { score: { home: row.home_goals, away: row.away_goals } } : {})
      }))
    };
  } catch (error) {
    return { configured: true, state: "error", errorCode: safeErrorCode(error) };
  } finally {
    client?.release();
  }
}

export interface ObservationStoreSummary {
  configured: boolean;
  state: "ready" | "not_configured" | "error";
  totalObservations?: number;
  unverifiedObservations?: number;
  firstObservedAt?: string | null;
  lastObservedAt?: string | null;
  byProvider?: Array<{ provider: string; observations: number; lastObservedAt: string | null }>;
  byStatus?: Array<{ status: string; observations: number }>;
  errorCode?: string;
}

/** Read-only aggregate diagnostics; never returns raw fixture payloads or credentials. */
export async function getObservationStoreSummary(): Promise<ObservationStoreSummary> {
  const configuredPool = getPool();
  if (!configuredPool) return { configured: false, state: "not_configured" };
  let client: PoolClient | undefined;
  try {
    client = await configuredPool.connect();
    await ensureSchema(client);
    const totals = await client.query<{
      total: number; unverified: number; first_observed_at: Date | null; last_observed_at: Date | null;
    }>(`
      SELECT COUNT(*)::integer AS total,
             COUNT(*) FILTER (WHERE evidence_state = 'unverified')::integer AS unverified,
             MIN(observed_at) AS first_observed_at,
             MAX(observed_at) AS last_observed_at
      FROM provider_fixture_observations
    `);
    const providers = await client.query<{
      provider: string; observations: number; last_observed_at: Date | null;
    }>(`
      SELECT provider, COUNT(*)::integer AS observations, MAX(observed_at) AS last_observed_at
      FROM provider_fixture_observations
      GROUP BY provider ORDER BY provider
    `);
    const statuses = await client.query<{ status: string; observations: number }>(`
      SELECT status, COUNT(*)::integer AS observations
      FROM provider_fixture_observations
      GROUP BY status ORDER BY status
    `);
    const total = totals.rows[0];
    return {
      configured: true,
      state: "ready",
      totalObservations: total?.total ?? 0,
      unverifiedObservations: total?.unverified ?? 0,
      firstObservedAt: total?.first_observed_at?.toISOString() ?? null,
      lastObservedAt: total?.last_observed_at?.toISOString() ?? null,
      byProvider: providers.rows.map(row => ({
        provider: row.provider,
        observations: row.observations,
        lastObservedAt: row.last_observed_at?.toISOString() ?? null
      })),
      byStatus: statuses.rows.map(row => ({ status: row.status, observations: row.observations }))
    };
  } catch (error) {
    return { configured: true, state: "error", errorCode: safeErrorCode(error) };
  } finally {
    client?.release();
  }
}


export interface TrackedTeamSeed {
  id: string;
  canonicalName: string;
  aliases?: string[];
}
export interface TeamRegistrySummary {
  state: "ready" | "not_configured" | "error";
  seededTeams: number;
  mappedTeams: number;
  unresolvedTeams: number;
  providerMappings: number;
  errorCode?: string;
}
export interface ProviderTeamMappingInput {
  teamId: string;
  provider: string;
  providerTeamId: string;
  providerTeamName: string;
  confirmAlias?: boolean;
}
function normalizeTeamLabel(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** Synchronizes the reviewed seed names without inventing provider IDs or overwriting reviewed aliases. */
export async function syncTrackedTeamRegistry(teams: TrackedTeamSeed[]): Promise<TeamRegistrySummary> {
  const configuredPool = getPool();
  if (!configuredPool) return { state: "not_configured", seededTeams: 0, mappedTeams: 0, unresolvedTeams: 0, providerMappings: 0 };
  let client: PoolClient | undefined;
  try {
    client = await configuredPool.connect();
    await ensureSchema(client);
    await client.query("BEGIN");
    if (teams.some(team => !team.id.trim() || !team.canonicalName.trim())) throw new Error("invalid_seed_team");
    await client.query(
      `INSERT INTO canonical_team_registry (team_id, canonical_name, aliases)
       SELECT x.team_id, x.canonical_name, x.aliases
       FROM jsonb_to_recordset($1::jsonb) AS x(team_id text, canonical_name text, aliases text[])
       ON CONFLICT (team_id) DO UPDATE SET
         canonical_name = EXCLUDED.canonical_name,
         aliases = ARRAY(SELECT DISTINCT unnest(canonical_team_registry.aliases || EXCLUDED.aliases)),
         updated_at = NOW()`,
      [JSON.stringify(teams.map(team => ({ team_id: team.id, canonical_name: team.canonicalName, aliases: team.aliases ?? [] })))]
    );
    await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    return { state: "error", seededTeams: 0, mappedTeams: 0, unresolvedTeams: 0, providerMappings: 0, errorCode: safeErrorCode(error) };
  } finally {
    client?.release();
  }
  return getTeamRegistrySummary();
}

/** Returns actual persisted provider-ID mapping coverage; seed names alone are not mappings. */
export async function getTeamRegistrySummary(): Promise<TeamRegistrySummary> {
  const configuredPool = getPool();
  if (!configuredPool) return { state: "not_configured", seededTeams: 0, mappedTeams: 0, unresolvedTeams: 0, providerMappings: 0 };
  let client: PoolClient | undefined;
  try {
    client = await configuredPool.connect();
    await ensureSchema(client);
    const result = await client.query<{ seeded_teams: number; mapped_teams: number; provider_mappings: number }>(`
      SELECT COUNT(*)::integer AS seeded_teams,
        COUNT(DISTINCT t.team_id) FILTER (WHERE m.team_id IS NOT NULL)::integer AS mapped_teams,
        (SELECT COUNT(*)::integer FROM provider_team_mappings) AS provider_mappings
      FROM canonical_team_registry t
      LEFT JOIN provider_team_mappings m ON m.team_id = t.team_id
    `);
    const row = result.rows[0];
    const seededTeams = row?.seeded_teams ?? 0;
    const mappedTeams = row?.mapped_teams ?? 0;
    return { state: "ready", seededTeams, mappedTeams, unresolvedTeams: seededTeams - mappedTeams, providerMappings: row?.provider_mappings ?? 0 };
  } catch (error) {
    return { state: "error", seededTeams: 0, mappedTeams: 0, unresolvedTeams: 0, providerMappings: 0, errorCode: safeErrorCode(error) };
  } finally {
    client?.release();
  }
}

/**
 * Adds an explicitly reviewed provider ID mapping. A differing provider label is
 * persisted as an alias only when the caller explicitly confirms that identity.
 * Existing provider IDs are never silently reassigned to another canonical team.
 */
export async function saveProviderTeamMapping(input: ProviderTeamMappingInput): Promise<
  { state: "saved" | "conflict" | "invalid" | "not_configured" | "error"; errorCode?: string; teamId?: string }
> {
  const provider = input.provider.trim().toLowerCase();
  const providerTeamId = input.providerTeamId.trim();
  const providerTeamName = input.providerTeamName.trim();
  const teamId = input.teamId.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(provider) ||
      !providerTeamId || providerTeamId.length > 200 ||
      !providerTeamName || providerTeamName.length > 200 ||
      !teamId || teamId.length > 200) return { state: "invalid", errorCode: "invalid_mapping_fields" };
  const configuredPool = getPool();
  if (!configuredPool) return { state: "not_configured", errorCode: "database_not_configured" };
  let client: PoolClient | undefined;
  try {
    client = await configuredPool.connect();
    await ensureSchema(client);
    await client.query("BEGIN");
    const found = await client.query<{ canonical_name: string; aliases: string[] }>(
      "SELECT canonical_name, aliases FROM canonical_team_registry WHERE team_id = $1 FOR UPDATE", [teamId]
    );
    const team = found.rows[0];
    if (!team) {
      await client.query("ROLLBACK");
      return { state: "invalid", errorCode: "canonical_team_not_found" };
    }
    const label = normalizeTeamLabel(providerTeamName);
    const matchesKnownName = [team.canonical_name, ...(team.aliases ?? [])]
      .some(name => normalizeTeamLabel(name) === label);
    if (!matchesKnownName && input.confirmAlias !== true) {
      await client.query("ROLLBACK");
      return { state: "conflict", errorCode: "provider_name_requires_explicit_alias_confirmation" };
    }
    if (!matchesKnownName) {
      const allTeams = await client.query<{ team_id: string; canonical_name: string; aliases: string[] }>(
        "SELECT team_id, canonical_name, aliases FROM canonical_team_registry WHERE team_id <> $1",
        [teamId]
      );
      const duplicateAlias = allTeams.rows.some(other =>
        [other.canonical_name, ...(other.aliases ?? [])].some(name => normalizeTeamLabel(name) === label)
      );
      if (duplicateAlias) {
        await client.query("ROLLBACK");
        return { state: "conflict", errorCode: "provider_name_alias_matches_another_canonical_team" };
      }
      await client.query(
        "UPDATE canonical_team_registry SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || $2::text[])), updated_at = NOW() WHERE team_id = $1",
        [teamId, [providerTeamName]]
      );
    }
    const existing = await client.query<{ team_id: string; provider_team_name: string }>(
      "SELECT team_id, provider_team_name FROM provider_team_mappings WHERE provider = $1 AND provider_team_id = $2 FOR UPDATE",
      [provider, providerTeamId]
    );
    if (existing.rows.length) {
      const current = existing.rows[0]!;
      if (current.team_id !== teamId || normalizeTeamLabel(current.provider_team_name) !== label) {
        await client.query("ROLLBACK");
        return { state: "conflict", errorCode: "provider_team_id_already_mapped_differently" };
      }
      await client.query("COMMIT");
      return { state: "saved", teamId };
    }
    await client.query(
      "INSERT INTO provider_team_mappings (provider, provider_team_id, team_id, provider_team_name) VALUES ($1, $2, $3, $4)",
      [provider, providerTeamId, teamId, providerTeamName]
    );
    await client.query("COMMIT");
    return { state: "saved", teamId };
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    return { state: "error", errorCode: safeErrorCode(error) };
  } finally {
    client?.release();
  }
}
