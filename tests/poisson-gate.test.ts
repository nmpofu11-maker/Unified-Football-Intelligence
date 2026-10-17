import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastPoisson, type HistoricalMatch } from "../src/models/poisson.js";

const generatedAt = "2026-10-17T12:00:00.000Z";
const kickoffUtc = "2026-11-01T12:00:00.000Z";
const scores: Array<[string, string, number, number]> = [
  ["H", "X", 3, 0],
  ["Y", "H", 1, 2],
  ["H", "X", 2, 0],
  ["X", "H", 0, 1],
  ["H", "Y", 2, 1],
  ["Y", "H", 2, 1],
  ["A", "X", 0, 2],
  ["Y", "A", 1, 3],
  ["A", "X", 1, 1],
  ["X", "A", 2, 1],
  ["Y", "A", 2, 2],
  ["A", "Y", 1, 0]
];

function verifiedHistory(): HistoricalMatch[] {
  return scores.map(([homeTeamId, awayTeamId, homeGoals, awayGoals], index) => {
    const date = new Date(Date.parse("2026-09-01T12:00:00.000Z") + index * 86_400_000).toISOString();
    const fixtureId = "test-history-" + index;
    return {
      fixtureId, homeTeamId, awayTeamId, kickoffUtc: date,
      result: {
        fixtureId, homeGoals, awayGoals, settledAt: date,
        reconciliationState: "verified",
        provenance: [{ provider: "unit-test-fixture", retrievedAt: date, evidenceState: "verified" }]
      }
    };
  });
}

test("Poisson forecast computes probabilities from verified history, not a neutral fallback", () => {
  const result = forecastPoisson({
    fixtureId: "target-fixture", homeTeamId: "H", awayTeamId: "A",
    kickoffUtc, generatedAt, matches: verifiedHistory(), minimumTeamMatches: 5
  });
  assert.equal(result.forecast.evidenceState, "unverified");
  const { homeWin, draw, awayWin } = result.forecast;
  assert.ok(homeWin > 0 && draw > 0 && awayWin > 0);
  assert.ok(Math.abs(homeWin + draw + awayWin - 1) < 0.002);
  assert.ok(Math.max(homeWin, draw, awayWin) - Math.min(homeWin, draw, awayWin) > 0.05);
  assert.ok(result.diagnostics.expectedHomeGoals !== null);
  assert.ok(result.diagnostics.expectedAwayGoals !== null);
});

test("Poisson forecast with missing history abstains instead of returning equal percentages", () => {
  const result = forecastPoisson({
    fixtureId: "target-fixture", homeTeamId: "H", awayTeamId: "A",
    kickoffUtc, generatedAt, matches: [], minimumTeamMatches: 5
  });
  assert.equal(result.forecast.evidenceState, "insufficient_evidence");
  assert.ok(result.forecast.abstentionReasons.length > 0);
  assert.deepEqual(
    [result.forecast.homeWin, result.forecast.draw, result.forecast.awayWin],
    [null, null, null]
  );
});
