import test from "node:test";
import assert from "node:assert/strict";
import { hasCompleteReviewedProviderTeamIdentityCoverage, previewCandidateReconciliation } from "../src/domain/reconcileCandidates.js";
import type { ProviderFixtureCandidate } from "../src/providers/provider.js";

function candidate(overrides: Partial<ProviderFixtureCandidate> = {}): ProviderFixtureCandidate {
  const base: ProviderFixtureCandidate = {
    provider: "sportapi-ai",
    providerFixtureId: "one",
    kickoffUtc: "2026-10-13T18:00:00.000Z",
    home: { name: "Bristol City" },
    away: { name: "Blackburn Rovers" },
    competition: { name: "Championship", providerCompetitionId: "53" },
    status: "scheduled",
    observedAt: "2026-10-13T16:00:00.000Z",
    evidenceState: "unverified",
    rawStatus: "NS",
    provenance: { provider: "sportapi-ai", providerRecordId: "one", retrievedAt: "2026-10-13T16:00:00.000Z", evidenceState: "unverified" }
  };
  return { ...base, ...overrides };
}

test("candidate reconciliation only corroborates exact normalized identities across providers", () => {
  const result = previewCandidateReconciliation([
    candidate(),
    candidate({ provider: "api-football", providerFixtureId: "two", home: { name: "BRISTOL CITY" }, away: { name: "Blackburn Rovers" }, competition: { name: "Championship" }, kickoffUtc: "2026-10-13T18:03:00.000Z" })
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "corroborated");
  assert.deepEqual(result[0]?.providers, ["api-football", "sportapi-ai"]);
});

test("candidate reconciliation flags provider status and score disagreements", () => {
  const scheduledWithoutScore = candidate({ provider: "api-football", providerFixtureId: "two", status: "scheduled" });
  delete scheduledWithoutScore.score;
  const result = previewCandidateReconciliation([
    candidate({ status: "finished", score: { home: 1, away: 0 } }),
    scheduledWithoutScore
  ]);
  assert.equal(result[0]?.state, "conflicted");
  assert.ok(result[0]?.reasons.includes("provider_status_disagreement"));
});

test("candidate reconciliation does not merge fixtures outside kickoff tolerance or with different teams", () => {
  const result = previewCandidateReconciliation([
    candidate(),
    candidate({ provider: "api-football", providerFixtureId: "two", kickoffUtc: "2026-10-13T19:00:00.000Z" }),
    candidate({ provider: "sportmonks", providerFixtureId: "three", home: { name: "Different FC" } })
  ]);
  assert.equal(result.length, 3);
  assert.ok(result.every(item => item.state === "single_source"));
});

test("a single provider cannot corroborate its own duplicate observations", () => {
  const result = previewCandidateReconciliation([
    candidate(),
    candidate({ providerFixtureId: "duplicate" })
  ]);
  assert.equal(result.length, 2);
  assert.ok(result.every(item => item.state === "single_source"));
});


test("stale live status is reported separately and does not masquerade as a provider conflict", () => {
  const stale = candidate({
    status: "live",
    observedAt: "2026-10-13T18:05:00.000Z"
  });
  const result = previewCandidateReconciliation(
    [stale],
    5 * 60_000,
    Date.parse("2026-10-15T12:00:00.000Z")
  );
  assert.equal(result[0]?.state, "stale");
  assert.ok(result[0]?.reasons.includes("only_one_provider_observation"));
  assert.ok(result[0]?.reasons.includes("stale_live_status"));
  assert.ok(!result[0]?.reasons.includes("provider_status_disagreement"));
});


test("provider IDs are not corroborated by names until each ID has a reviewed canonical mapping", () => {
  const sportApi = candidate({
    home: { name: "Bristol City", providerTeamId: "sport-home" },
    away: { name: "Blackburn Rovers", providerTeamId: "sport-away" }
  });
  const apiFootball = candidate({
    provider: "api-football",
    providerFixtureId: "api-fixture",
    home: { name: "Bristol City", providerTeamId: "api-home" },
    away: { name: "Blackburn Rovers", providerTeamId: "api-away" }
  });

  assert.deepEqual(previewCandidateReconciliation([sportApi, apiFootball]), []);
  const reviewed = {
    "sportapi-ai:sport-home": "tracked-bristol",
    "sportapi-ai:sport-away": "tracked-blackburn",
    "api-football:api-home": "tracked-bristol",
    "api-football:api-away": "tracked-blackburn"
  };
  const result = previewCandidateReconciliation([sportApi, apiFootball], 5 * 60_000, Date.now(), reviewed);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "corroborated");
  assert.deepEqual(result[0]?.providers, ["api-football", "sportapi-ai"]);
});

test("complete reviewed identity coverage rejects missing, unmapped, and same-team home/away IDs", () => {
  const withIds = candidate({
    home: { name: "Bristol City", providerTeamId: "home-id" },
    away: { name: "Blackburn Rovers", providerTeamId: "away-id" }
  });
  assert.equal(hasCompleteReviewedProviderTeamIdentityCoverage([withIds], {}), false);
  assert.equal(hasCompleteReviewedProviderTeamIdentityCoverage([{
    ...withIds, away: { name: "Blackburn Rovers" }
  }], { "sportapi-ai:home-id": "home" }), false);
  assert.equal(hasCompleteReviewedProviderTeamIdentityCoverage([withIds], {
    "sportapi-ai:home-id": "same",
    "sportapi-ai:away-id": "same"
  }), false);
  assert.equal(hasCompleteReviewedProviderTeamIdentityCoverage([withIds], {
    "sportapi-ai:home-id": "home",
    "sportapi-ai:away-id": "away"
  }), true);
});
