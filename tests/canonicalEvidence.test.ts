import test from "node:test";
import assert from "node:assert/strict";
import { previewCandidateReconciliation } from "../src/domain/reconcileCandidates.js";
import type { ProviderFixtureCandidate } from "../src/providers/provider.js";

function candidate(
  provider: string,
  overrides: Partial<ProviderFixtureCandidate> = {}
): ProviderFixtureCandidate {
  const observedAt = "2026-10-14T17:00:00.000Z";
  return {
    provider,
    providerFixtureId: provider + "-fixture-1",
    kickoffUtc: "2026-10-14T18:00:00.000Z",
    home: { providerTeamId: provider + "-home", name: "Cape Town City" },
    away: { providerTeamId: provider + "-away", name: "Orlando Pirates" },
    competition: { providerCompetitionId: provider + "-league", name: "Premier Soccer League" },
    status: "finished",
    observedAt,
    evidenceState: "unverified",
    rawStatus: "FT",
    score: { home: 1, away: 2 },
    provenance: { provider, providerRecordId: provider + "-fixture-1", retrievedAt: observedAt, evidenceState: "unverified" },
    ...overrides
  };
}

test("same finished score from two providers is corroborated", () => {
  const result = previewCandidateReconciliation([candidate("sportapi-ai"), candidate("api-football")]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "corroborated");
  assert.deepEqual(result[0]?.providers, ["api-football", "sportapi-ai"]);
  assert.deepEqual(result[0]?.scores, [{ home: 1, away: 2 }]);
});

test("different provider scores are flagged as conflicted", () => {
  const result = previewCandidateReconciliation([
    candidate("sportapi-ai"),
    candidate("api-football", { score: { home: 0, away: 2 } })
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "conflicted");
  assert.ok(result[0]?.reasons.includes("provider_score_disagreement"));
});

test("a single provider is not corroborated", () => {
  const result = previewCandidateReconciliation([candidate("sportapi-ai")]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "single_source");
  assert.ok(result[0]?.reasons.includes("only_one_provider_observation"));
});

test("kickoff differences beyond five minutes are not merged", () => {
  const result = previewCandidateReconciliation([
    candidate("sportapi-ai"),
    candidate("api-football", { kickoffUtc: "2026-10-14T18:06:00.000Z" })
  ]);
  assert.equal(result.length, 2);
  assert.ok(result.every(group => group.state === "single_source"));
});

test("curated team and competition aliases reconcile exact provider naming variants", () => {
  const result = previewCandidateReconciliation([
    candidate("sportapi-ai", {
      home: { name: "QPR" },
      competition: { name: "English Championship" }
    }),
    candidate("api-football", {
      home: { name: "Queens Park Rangers" },
      competition: { name: "Championship" }
    })
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "corroborated");
  assert.deepEqual(result[0]?.providers, ["api-football", "sportapi-ai"]);
});

test("aliases do not override kickoff tolerance or score conflict detection", () => {
  const result = previewCandidateReconciliation([
    candidate("sportapi-ai", { home: { name: "QPR" } }),
    candidate("api-football", {
      home: { name: "Queens Park Rangers" },
      kickoffUtc: "2026-10-14T18:06:00.000Z"
    })
  ]);
  assert.equal(result.length, 2);
  assert.ok(result.every(group => group.state === "single_source"));
});

test("UEFA-prefixed and provider-short competition labels reconcile", () => {
  const result = previewCandidateReconciliation([
    candidate("sportapi-ai", {
      competition: { name: "UEFA Champions League" }
    }),
    candidate("api-football", {
      competition: { name: "Champions League" }
    })
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "corroborated");
});
