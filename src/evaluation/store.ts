import { Pool } from "pg";
import { evaluateOutOfSample, type EvaluationCandidate } from "./outOfSample.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  allowExitOnIdle: true
});
pool.on("error", () => { /* Do not log credentials or connection strings. */ });

export async function loadOutOfSampleEvaluation(minimumSampleSize = 30) {
  if (!process.env.DATABASE_URL?.trim()) {
    return { state: "not_configured" as const, reason: "database_not_configured" };
  }
  try {
    const [ledgerCount, result] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM prediction_ledger"),
      pool.query(
        `SELECT pl.canonical_key, pl.generated_at, pl.model_id, pl.model_version, pl.forecast,
                f.kickoff_utc, f.evidence_state AS fixture_evidence_state, f.status AS fixture_status,
                r.home_goals, r.away_goals, r.verified_at, r.evidence_state AS result_evidence_state
         FROM prediction_ledger pl
         JOIN canonical_fixture_evidence f ON f.canonical_key = pl.canonical_key
         JOIN verified_settled_results r ON r.canonical_key = f.canonical_key
         WHERE f.status = 'finished'
         ORDER BY pl.generated_at ASC`
      )
    ]);
    const candidates: EvaluationCandidate[] = result.rows.map((row: {
      canonical_key: string; generated_at: Date | string; model_id: string; model_version: string;
      forecast: { featureCutoffAt?: string; homeWin?: number | null; draw?: number | null; awayWin?: number | null } | string;
      kickoff_utc: Date | string; fixture_evidence_state: "corroborated" | "conflicted";
      fixture_status: EvaluationCandidate["fixtureStatus"]; home_goals: number; away_goals: number;
      verified_at: Date | string; result_evidence_state: "verified" | "conflicted";
    }) => {
      const forecast = typeof row.forecast === "string" ? JSON.parse(row.forecast) : row.forecast;
      const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
      return {
        fixtureId: row.canonical_key,
        modelId: row.model_id,
        modelVersion: row.model_version,
        generatedAt: iso(row.generated_at),
        featureCutoffAt: typeof forecast?.featureCutoffAt === "string" ? forecast.featureCutoffAt : "",
        kickoffUtc: iso(row.kickoff_utc),
        probabilities: { homeWin: forecast?.homeWin ?? null, draw: forecast?.draw ?? null, awayWin: forecast?.awayWin ?? null },
        fixtureEvidenceState: row.fixture_evidence_state,
        fixtureStatus: row.fixture_status,
        resultEvidenceState: row.result_evidence_state,
        resultVerifiedAt: iso(row.verified_at),
        homeGoals: Number(row.home_goals),
        awayGoals: Number(row.away_goals)
      };
    });
    return {
      state: "ready" as const,
      storedForecastCount: Number(ledgerCount.rows[0]?.count ?? 0),
      joinedSettledCandidateCount: candidates.length,
      evaluation: evaluateOutOfSample(candidates, minimumSampleSize),
      recommendationEnabled: false,
      note: "This is chronological forecast evaluation, not calibration approval. Recommendations remain disabled."
    };
  } catch {
    return { state: "error" as const, reason: "out_of_sample_evaluation_unavailable" };
  }
}
