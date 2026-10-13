import { Pool, type PoolClient } from "pg";
import type { ProviderFixtureCandidate } from "../providers/provider.js";

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
