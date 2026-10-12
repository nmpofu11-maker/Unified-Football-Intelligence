import test from "node:test";
import assert from "node:assert/strict";
import { validateForecast, validateFixture, validateOddsQuote, validateSettledResult } from "../src/domain/validation.js";
import type { Fixture, OddsQuote, ProbabilityForecast, SettledResult } from "../src/domain/types.js";
const provenance = [{ provider: "test", retrievedAt: "2026-01-01T00:00:00.000Z", evidenceState: "verified" as const }];
test("fixture rejects same teams and non-UTC timestamp", () => {
  const f: Fixture = { id: "fx", competitionId: "league", homeTeamId: "a", awayTeamId: "a", kickoffUtc: "2026-01-01T12:00:00", status: "scheduled", provenance };
  assert.ok(validateFixture(f).includes("same_home_and_away_team"));
  assert.ok(validateFixture(f).includes("kickoff_must_be_utc_iso_timestamp"));
});
test("forecast probabilities must sum to one", () => {
  const f: ProbabilityForecast = { fixtureId: "fx", modelId: "baseline", modelVersion: "0.1", generatedAt: "2026-01-01T00:00:00.000Z", featureCutoffAt: "2025-12-31T00:00:00.000Z", homeWin: .5, draw: .3, awayWin: .3, evidenceState: "verified", abstentionReasons: [] };
  assert.ok(validateForecast(f).includes("probabilities_do_not_sum_to_one"));
});
test("unverified forecast requires abstention reason", () => {
  const f: ProbabilityForecast = { fixtureId: "fx", modelId: "baseline", modelVersion: "0.1", generatedAt: "2026-01-01T00:00:00.000Z", featureCutoffAt: "2025-12-31T00:00:00.000Z", homeWin: .4, draw: .3, awayWin: .3, evidenceState: "insufficient_evidence", abstentionReasons: [] };
  assert.ok(validateForecast(f).includes("abstention_reason_required_without_verified_evidence"));
});
test("unverified or invalid results fail validation", () => {
  const r: SettledResult = { fixtureId: "fx", homeGoals: -1, awayGoals: 2, settledAt: "2026-01-01T00:00:00.000Z", provenance, reconciliationState: "unverified" };
  assert.ok(validateSettledResult(r).includes("invalid_home_goals"));
  assert.ok(validateSettledResult(r).includes("result_not_verified"));
});
test("odds must be greater than one and verified", () => {
  const q: OddsQuote = { fixtureId: "fx", bookmaker: "book", market: "1x2", selection: "home", decimalOdds: 1, observedAt: "2026-01-01T00:00:00.000Z", provenance: { provider: "book", retrievedAt: "2026-01-01T00:00:00.000Z", evidenceState: "unverified" } };
  assert.ok(validateOddsQuote(q).includes("invalid_decimal_odds"));
  assert.ok(validateOddsQuote(q).includes("odds_not_verified"));
});
