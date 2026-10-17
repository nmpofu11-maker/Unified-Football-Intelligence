import test from "node:test";
import assert from "node:assert/strict";
import { forecastPoisson } from "../src/models/poisson.js";
import type { HistoricalMatch } from "../src/models/poisson.js";

function history(n: number): HistoricalMatch[] {
  return Array.from({length:n}, (_, i) => {
    const fixtureId = `past-${i}`;
    return { fixtureId, homeTeamId: i % 2 ? "A" : "C", awayTeamId: i % 2 ? "C" : "B", kickoffUtc: `2026-01-${String(i+1).padStart(2,"0")}T12:00:00.000Z`, result: {
      fixtureId, homeGoals: i % 3 === 0 ? 2 : 1, awayGoals: i % 2, settledAt: `2026-01-${String(i+1).padStart(2,"0")}T15:00:00.000Z`, reconciliationState: "verified" as const,
      provenance: [{provider:"fixture-test", retrievedAt:"2026-02-01T00:00:00.000Z", evidenceState:"verified" as const}]
    }};
  });
}

test("model abstains when verified history is insufficient", () => {
  const out = forecastPoisson({fixtureId:"upcoming",homeTeamId:"A",awayTeamId:"B",kickoffUtc:"2026-03-01T12:00:00.000Z",generatedAt:"2026-02-28T12:00:00.000Z",matches:history(3)});
  assert.equal(out.forecast.evidenceState,"insufficient_evidence");
  assert.ok(out.forecast.abstentionReasons.length > 0);
  assert.equal(out.diagnostics.expectedHomeGoals,null);
});

test("model only uses pre-kickoff verified settled matches", () => {
  const matches = history(12);
  matches.push({...matches[0]!,fixtureId:"future",kickoffUtc:"2026-03-02T12:00:00.000Z",result:{...matches[0]!.result,fixtureId:"future",settledAt:"2026-03-03T12:00:00.000Z"}});
  const out = forecastPoisson({fixtureId:"upcoming",homeTeamId:"A",awayTeamId:"B",kickoffUtc:"2026-03-01T12:00:00.000Z",generatedAt:"2026-02-28T12:00:00.000Z",matches});
  assert.equal(out.diagnostics.leagueSamples,12);
  assert.equal(typeof out.forecast.homeWin, "number");
  assert.equal(typeof out.forecast.draw, "number");
  assert.equal(typeof out.forecast.awayWin, "number");
  assert.ok(Math.abs(out.forecast.homeWin! + out.forecast.draw! + out.forecast.awayWin! - 1) < 0.001);
  assert.equal(out.forecast.evidenceState,"unverified");
});
