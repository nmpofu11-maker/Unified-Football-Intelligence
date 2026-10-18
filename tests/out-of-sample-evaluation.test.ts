import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOutOfSample, type EvaluationCandidate } from "../src/evaluation/outOfSample.js";

function candidate(index: number): EvaluationCandidate {
  const kickoff = new Date(Date.parse("2026-01-01T00:00:00Z") + index * 86_400_000).toISOString();
  const generated = new Date(Date.parse(kickoff) - 86_400_000).toISOString();
  return {
    fixtureId: "fixture-" + index, modelId: "poisson-baseline", modelVersion: "v1",
    generatedAt: generated, featureCutoffAt: generated, kickoffUtc: kickoff,
    probabilities: { homeWin: 0.55, draw: 0.25, awayWin: 0.2 },
    fixtureEvidenceState: "corroborated", fixtureStatus: "finished",
    resultEvidenceState: "verified",
    resultVerifiedAt: new Date(Date.parse(kickoff) + 3_600_000).toISOString(),
    homeGoals: 2, awayGoals: 0
  };
}

test("withholds performance metrics below the minimum sample", () => {
  const result = evaluateOutOfSample([candidate(1), candidate(2)], 30);
  assert.equal(result.state, "insufficient");
  assert.equal(result.sampleSize, 2);
  assert.equal(result.brierScore, null);
  assert.equal(result.logLoss, null);
  assert.equal(result.accuracy, null);
});

test("excludes leakage, unverified results, conflicts, and null probability triplets", () => {
  const base = candidate(1);
  const invalid = [
    { ...base, generatedAt: base.kickoffUtc },
    { ...base, featureCutoffAt: new Date(Date.parse(base.generatedAt) + 1000).toISOString() },
    { ...base, resultVerifiedAt: base.generatedAt },
    { ...base, resultEvidenceState: "conflicted" as const },
    { ...base, fixtureEvidenceState: "conflicted" as const },
    { ...base, probabilities: { homeWin: null, draw: null, awayWin: null } }
  ];
  const result = evaluateOutOfSample(invalid, 1);
  assert.equal(result.state, "insufficient");
  assert.equal(result.sampleSize, 0);
});

test("uses only the latest eligible forecast for each fixture/model", () => {
  const first = candidate(1);
  const second = { ...first, generatedAt: new Date(Date.parse(first.generatedAt) + 60_000).toISOString(),
    featureCutoffAt: new Date(Date.parse(first.generatedAt) + 60_000).toISOString() };
  const result = evaluateOutOfSample([first, second], 2);
  assert.equal(result.state, "insufficient");
  assert.equal(result.sampleSize, 1);
});

test("computes metrics only after the required verified chronological sample", () => {
  const result = evaluateOutOfSample(Array.from({ length: 30 }, (_, i) => candidate(i)), 30);
  assert.equal(result.state, "evaluated");
  assert.equal(result.sampleSize, 30);
  assert.ok(typeof result.brierScore === "number" && result.brierScore >= 0);
  assert.ok(typeof result.logLoss === "number" && result.logLoss >= 0);
  assert.ok(typeof result.accuracy === "number" && result.accuracy >= 0 && result.accuracy <= 1);
});
