import type { Fixture, OddsQuote, ProbabilityForecast, SettledResult } from "./types.js";
export function isValidUtcTimestamp(value: string): boolean {
  return Boolean(value && value.endsWith("Z") && Number.isFinite(Date.parse(value)));
}
export function validateFixture(f: Fixture): string[] {
  const e: string[] = [];
  if (!f.id.trim()) e.push("fixture_id_missing");
  if (!f.competitionId.trim()) e.push("competition_id_missing");
  if (!f.homeTeamId.trim() || !f.awayTeamId.trim()) e.push("team_id_missing");
  if (f.homeTeamId === f.awayTeamId) e.push("same_home_and_away_team");
  if (!isValidUtcTimestamp(f.kickoffUtc)) e.push("kickoff_must_be_utc_iso_timestamp");
  if (!f.provenance.length) e.push("provenance_missing");
  return e;
}
export function validateSettledResult(r: SettledResult): string[] {
  const e: string[] = [];
  if (!r.fixtureId.trim()) e.push("fixture_id_missing");
  if (!Number.isInteger(r.homeGoals) || r.homeGoals < 0) e.push("invalid_home_goals");
  if (!Number.isInteger(r.awayGoals) || r.awayGoals < 0) e.push("invalid_away_goals");
  if (!isValidUtcTimestamp(r.settledAt)) e.push("settled_at_must_be_utc_iso_timestamp");
  if (!r.provenance.length) e.push("provenance_missing");
  if (r.reconciliationState !== "verified") e.push("result_not_verified");
  return e;
}
export function validateForecast(f: ProbabilityForecast): string[] {
  const e: string[] = [], p = [f.homeWin, f.draw, f.awayWin];
  if (p.some(v => !Number.isFinite(v) || v < 0 || v > 1)) e.push("probabilities_out_of_range");
  if (Math.abs(p.reduce((a, b) => a + b, 0) - 1) > 0.001) e.push("probabilities_do_not_sum_to_one");
  if (!isValidUtcTimestamp(f.generatedAt) || !isValidUtcTimestamp(f.featureCutoffAt)) e.push("forecast_timestamps_must_be_utc_iso_timestamps");
  if (Date.parse(f.featureCutoffAt) > Date.parse(f.generatedAt)) e.push("feature_cutoff_in_future");
  if (f.evidenceState !== "verified" && f.abstentionReasons.length === 0) e.push("abstention_reason_required_without_verified_evidence");
  return e;
}
export function validateOddsQuote(q: OddsQuote): string[] {
  const e: string[] = [];
  if (!q.fixtureId.trim()) e.push("fixture_id_missing");
  if (!Number.isFinite(q.decimalOdds) || q.decimalOdds <= 1) e.push("invalid_decimal_odds");
  if (!isValidUtcTimestamp(q.observedAt)) e.push("observed_at_must_be_utc_iso_timestamp");
  if (q.provenance.evidenceState !== "verified") e.push("odds_not_verified");
  return e;
}
