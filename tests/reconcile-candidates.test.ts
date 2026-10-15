import test from "node:test";
import assert from "node:assert/strict";
import { previewCandidateReconciliation } from "../src/domain/reconcileCandidates.js";
import type { ProviderFixtureCandidate } from "../src/providers/provider.js";

function candidate(overrides: Partial<ProviderFixtureCandidate> = {}): ProviderFixtureCandidate {
  const base: ProviderFixtureCandidate = {
    provider: "sportapi-ai",
    providerFixtureId: "one",
    kickoffUtc: "2026-10-13T18:00:00.000Z",
    home: { name: "Bristol City", providerTeamId: "10" },
    away: { name: "Blackburn Rovers", providerTeamId: "20" },
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


test("reviewed provider team IDs corroborate fixtures despite provider name variants", () => {
  const first = candidate({
    home: { name: "Bristol City", providerTeamId: "10" },
    away: { name: "Blackburn Rovers", providerTeamId: "20" }
  });
  const second = candidate({
    provider: "api-football",
    providerFixtureId: "two",
    home: { name: "Bristol C.", providerTeamId: "501" },
    away: { name: "Blackburn", providerTeamId: "502" },
    kickoffUtc: "2026-10-13T18:03:00.000Z"
  });
  const reviewedIds = {
    "sportapi-ai:10": "legacy-team-1",
    "sportapi-ai:20": "legacy-team-2",
    "api-football:501": "legacy-team-1",
    "api-football:502": "legacy-team-2"
  };
  const result = previewCandidateReconciliation([first, second], 5 * 60_000, Date.parse("2026-10-13T18:04:00Z"), reviewedIds);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "corroborated");
  assert.deepEqual(result[0]?.providers, ["api-football", "sportapi-ai"]);
});

test("provider candidates with supplied but unreviewed team IDs are excluded from canonical matching", () => {
  const first = candidate({
    home: { name: "Bristol City", providerTeamId: "unreviewed-home" },
    away: { name: "Blackburn Rovers", providerTeamId: "unreviewed-away" }
  });
  const second = candidate({
    provider: "api-football",
    providerFixtureId: "two",
    home: { name: "Bristol City", providerTeamId: "unknown-home" },
    away: { name: "Blackburn Rovers", providerTeamId: "unknown-away" }
  });
  const result = previewCandidateReconciliation([first, second], 5 * 60_000, Date.now(), {});
  assert.equal(result.length, 0);
});

test("reviewed identity prevents same-name fixtures with different provider IDs from being merged", () => {
  const first = candidate({
    home: { name: "Bristol City", providerTeamId: "10" },
    away: { name: "Blackburn Rovers", providerTeamId: "20" }
  });
  const second = candidate({
    provider: "api-football",
    providerFixtureId: "two",
    home: { name: "Bristol City", providerTeamId: "501" },
    away: { name: "Blackburn Rovers", providerTeamId: "502" },
    kickoffUtc: "2026-10-13T18:01:00.000Z"
  });
  const reviewedIds = {
    "sportapi-ai:10": "team-home-a",
    "sportapi-ai:20": "team-away-a",
    "api-football:501": "team-home-b",
    "api-football:502": "team-away-b"
  };
  const result = previewCandidateReconciliation([first, second], 5 * 60_000, Date.now(), reviewedIds);
  assert.equal(result.length, 2);
  assert.ok(result.every(item => item.state === "single_source"));
});
