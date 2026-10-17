import { createHash } from "node:crypto";
import { Pool } from "pg";
import { forecastPoisson, type HistoricalMatch } from "../models/poisson.js";

type State = "ready" | "not_configured" | "error";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  allowExitOnIdle: true
});
pool.on("error", () => { /* Never log connection strings or credentials. */ });

export interface PredictionTeamMapping {
  teamId: string;
  canonicalName: string;
  reviewedBy: string;
}

export async function ensurePredictionSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prediction_team_registry (
      team_id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE,
      reviewed_by TEXT NOT NULL,
      reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (length(trim(team_id)) > 0),
      CHECK (length(trim(canonical_name)) > 0),
      CHECK (length(trim(reviewed_by)) > 0)
    );
    CREATE TABLE IF NOT EXISTS prediction_ledger (
      id BIGSERIAL PRIMARY KEY,
      canonical_key TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL,
      model_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      evidence_state TEXT NOT NULL,
      forecast JSONB NOT NULL,
      diagnostics JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (canonical_key, generated_at, model_id, model_version, evidence_hash)
    );
    CREATE INDEX IF NOT EXISTS prediction_ledger_fixture_idx
      ON prediction_ledger (canonical_key, generated_at DESC);
  `);
}

export async function saveReviewedTeamMapping(input: PredictionTeamMapping) {
  const teamId = input.teamId.trim();
  const canonicalName = input.canonicalName.trim();
  const reviewedBy = input.reviewedBy.trim();
  if (!teamId || !canonicalName || !reviewedBy) {
    return { state: "invalid_input" as const, reason: "teamId_canonicalName_and_reviewedBy_are_required" };
  }
  if (teamId.length > 160 || canonicalName.length > 200 || reviewedBy.length > 160) {
    return { state: "invalid_input" as const, reason: "mapping_field_too_long" };
  }
  if (/[\\r\\n\\t]/.test(teamId + canonicalName + reviewedBy)) {
    return { state: "invalid_input" as const, reason: "mapping_fields_must_not_contain_control_characters" };
  }
  try {
    await ensurePredictionSchema();
    // Deliberately no fuzzy matching or automatic name/ID inference.
    const result = await pool.query(
      `INSERT INTO prediction_team_registry (team_id, canonical_name, reviewed_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id) DO UPDATE SET canonical_name = EXCLUDED.canonical_name,
         reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW()
       WHERE prediction_team_registry.canonical_name = EXCLUDED.canonical_name
       RETURNING team_id, canonical_name, reviewed_by, reviewed_at`,
      [teamId, canonicalName, reviewedBy]
    );
    if (!result.rowCount) {
      return { state: "conflict" as const, reason: "team_id_exists_with_a_different_name_or_name_is_already_mapped" };
    }
    return { state: "saved" as const, mapping: result.rows[0] };
  } catch {
    return { state: "error" as const, reason: "prediction_registry_unavailable" };
  }
}
export async function listReviewedTeamMappings() {
  if (!process.env.DATABASE_URL?.trim()) return { state: "not_configured" as const, mappings: [] };
  try {
    await ensurePredictionSchema();
    const result = await pool.query(
      "SELECT team_id, canonical_name, reviewed_by, reviewed_at FROM prediction_team_registry ORDER BY canonical_name"
    );
    return { state: "ready" as const, mappings: result.rows };
  } catch {
    return { state: "error" as const, mappings: [], errorCode: "prediction_registry_unavailable" };
  }
}

/**
 * Loads the target fixture and all eligible, verified historical results from PostgreSQL.
 * It never accepts caller-supplied stats and never treats provider observations as results.
 */
export async function predictStoredFixture(canonicalKey: string, generatedAt = new Date().toISOString()) {
  if (!process.env.DATABASE_URL?.trim()) {
    return { state: "unavailable" as const, reason: "database_not_configured" };
  }
  if (!canonicalKey.trim() || canonicalKey.length > 500 || !Number.isFinite(Date.parse(generatedAt)) || !generatedAt.endsWith("Z")) {
    return { state: "invalid_request" as const, reason: "valid_canonical_key_and_UTC_generatedAt_required" };
  }
  try {
    await ensurePredictionSchema();
    const targetResult = await pool.query(
      `SELECT canonical_key, kickoff_utc, home_name, away_name, competition_name, status, evidence_state
       FROM canonical_fixture_evidence WHERE canonical_key = $1`,
      [canonicalKey]
    );
    const target = targetResult.rows[0];
    if (!target) return { state: "withheld" as const, reason: "FIXTURE_NOT_FOUND" };
    if (target.evidence_state !== "corroborated") return { state: "withheld" as const, reason: "FIXTURE_NOT_CORROBORATED" };
    if (target.status !== "scheduled") return { state: "withheld" as const, reason: "FIXTURE_NOT_SCHEDULED" };
    const kickoffUtc = new Date(target.kickoff_utc).toISOString();
    if (Date.parse(kickoffUtc) <= Date.parse(generatedAt)) {
      return { state: "withheld" as const, reason: "FIXTURE_KICKOFF_NOT_IN_FUTURE" };
    }

    const mappingsResult = await pool.query(
      "SELECT team_id, canonical_name FROM prediction_team_registry"
    );
    const mappingByName = new Map<string, string>(
      mappingsResult.rows.map((row: { team_id: string; canonical_name: string }) => [row.canonical_name, row.team_id])
    );
    const homeTeamId = mappingByName.get(target.home_name);
    const awayTeamId = mappingByName.get(target.away_name);
    if (!homeTeamId || !awayTeamId) {
      return {
        state: "withheld" as const, reason: "TEAM_MAPPING_REQUIRED",
        missingMappings: [!homeTeamId ? target.home_name : null, !awayTeamId ? target.away_name : null].filter(Boolean)
      };
    }
    if (homeTeamId === awayTeamId) return { state: "withheld" as const, reason: "HOME_AWAY_TEAM_MAPPING_COLLISION" };

    const historyResult = await pool.query(
      `SELECT f.canonical_key, f.kickoff_utc, f.home_name, f.away_name,
              r.home_goals, r.away_goals, r.verified_at, r.providers
       FROM canonical_fixture_evidence f
       JOIN verified_settled_results r ON r.canonical_key = f.canonical_key
       WHERE f.evidence_state = 'corroborated'
         AND f.status = 'finished'
         AND r.evidence_state = 'verified'
         AND f.kickoff_utc < $1::timestamptz
         AND r.verified_at <= $2::timestamptz
         AND f.canonical_key <> $3
         AND f.competition_name = $4
       ORDER BY f.kickoff_utc DESC`,
      [kickoffUtc, generatedAt, canonicalKey, target.competition_name]
    );

    const matches: HistoricalMatch[] = historyResult.rows.map((row: {
      canonical_key: string; kickoff_utc: Date | string; home_name: string; away_name: string;
      home_goals: number; away_goals: number; verified_at: Date | string; providers: string[];
    }) => {
      const settledAt = row.verified_at instanceof Date ? row.verified_at.toISOString() : new Date(row.verified_at).toISOString();
      const provenance = (Array.isArray(row.providers) ? row.providers : []).map(provider => ({
        provider, retrievedAt: settledAt, evidenceState: "verified" as const
      }));
      return {
        fixtureId: row.canonical_key,
        homeTeamId: mappingByName.get(row.home_name) ?? `unmapped-home:${row.canonical_key}`,
        awayTeamId: mappingByName.get(row.away_name) ?? `unmapped-away:${row.canonical_key}`,
        kickoffUtc: row.kickoff_utc instanceof Date ? row.kickoff_utc.toISOString() : new Date(row.kickoff_utc).toISOString(),
        result: {
          fixtureId: row.canonical_key, homeGoals: Number(row.home_goals), awayGoals: Number(row.away_goals),
          settledAt, provenance, reconciliationState: "verified" as const
        }
      };
    });

    const forecast = forecastPoisson({
      fixtureId: canonicalKey, homeTeamId, awayTeamId, kickoffUtc, generatedAt, matches,
      minimumTeamMatches: Number(process.env.PREDICTION_MIN_TEAM_MATCHES ?? 5)
    });
    const evidenceHash = createHash("sha256").update(JSON.stringify({
      target: { canonicalKey, kickoffUtc, home: target.home_name, away: target.away_name },
      mappings: [homeTeamId, awayTeamId],
      history: matches.map(m => [m.fixtureId, m.kickoffUtc, m.result.homeGoals, m.result.awayGoals, m.result.settledAt, m.result.provenance.map(p => p.provider)])
    })).digest("hex");

    const hasForecast = forecast.forecast.evidenceState !== "insufficient_evidence" &&
      Number.isFinite(forecast.forecast.homeWin) &&
      Number.isFinite(forecast.forecast.draw) &&
      Number.isFinite(forecast.forecast.awayWin) &&
      Math.abs(forecast.forecast.homeWin + forecast.forecast.draw + forecast.forecast.awayWin - 1) < 0.002;
    if (hasForecast) {
      await pool.query(
        `INSERT INTO prediction_ledger
          (canonical_key, generated_at, model_id, model_version, evidence_hash, evidence_state, forecast, diagnostics)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         ON CONFLICT (canonical_key, generated_at, model_id, model_version, evidence_hash) DO NOTHING`,
        [canonicalKey, generatedAt, forecast.forecast.modelId, forecast.forecast.modelVersion, evidenceHash,
          forecast.forecast.evidenceState, JSON.stringify(forecast.forecast), JSON.stringify(forecast.diagnostics)]
      );
    }

    if (!hasForecast) {
      return {
        state: "withheld" as const,
        reason: "INSUFFICIENT_VERIFIED_HISTORY",
        evidenceHash,
        diagnostics: forecast.diagnostics,
        abstentionReasons: forecast.forecast.abstentionReasons,
        historyRowsLoaded: matches.length,
        recommendationEnabled: false
      };
    }
    return {
      state: "forecast_available" as const,
      forecast: forecast.forecast,
      diagnostics: forecast.diagnostics,
      evidenceHash,
      historyRowsLoaded: matches.length,
      recommendationEnabled: false,
      recommendationReason: "MODEL_NOT_CALIBRATED_FOR_BETTING",
      note: "Exploratory statistical forecast only. This is not a calibrated betting recommendation."
    };
  } catch {
    return { state: "error" as const, reason: "PREDICTION_PIPELINE_ERROR" };
  }
}

export async function predictionStorageStatus() {
  if (!process.env.DATABASE_URL?.trim()) return { state: "not_configured" as const };
  try {
    await ensurePredictionSchema();
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM prediction_team_registry) AS reviewed_team_mappings,
         (SELECT COUNT(*)::int FROM prediction_ledger) AS saved_forecasts`
    );
    return { state: "ready" as const, ...result.rows[0] };
  } catch {
    return { state: "error" as const, errorCode: "prediction_storage_unavailable" };
  }
}
