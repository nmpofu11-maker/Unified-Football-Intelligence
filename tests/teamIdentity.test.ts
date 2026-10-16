import test from "node:test";
import assert from "node:assert/strict";
import { discoverTrackedTeamIdentities } from "../src/domain/teamIdentity.js";
import type { ProviderFixtureCandidate } from "../src/providers/provider.js";

function candidate(provider: string, homeName: string, homeId: string, awayName = "Opponent", awayId = provider + "-away"): ProviderFixtureCandidate {
  const observedAt = "2026-10-14T17:00:00.000Z";
  return {
    provider, providerFixtureId: provider + "-fixture", kickoffUtc: "2026-10-14T18:00:00.000Z",
    home: { name: homeName, providerTeamId: homeId }, away: { name: awayName, providerTeamId: awayId },
    competition: { name: "League", providerCompetitionId: provider + "-league" },
    status: "scheduled", observedAt, evidenceState: "unverified", rawStatus: "NS",
    provenance: { provider, providerRecordId: provider + "-fixture", retrievedAt: observedAt, evidenceState: "unverified" }
  };
}

test("discovers an exact tracked team identity across providers", () => {
  const result = discoverTrackedTeamIdentities(
    [{ id: "team-1", canonicalName: "Beijing Guoan" }],
    [candidate("sportapi-ai", "Beijing Guoan", "sa-12"), candidate("api-football", "Beijing Guoan", "af-33")]
  );
  assert.equal(result[0]?.state, "resolved");
  assert.deepEqual(result[0]?.identities.map(x => x.providerTeamId), ["af-33", "sa-12"]);
});

test("uses only explicitly curated aliases and preserves youth/reserve distinctions", () => {
  const result = discoverTrackedTeamIdentities(
    [{ id: "team-1", canonicalName: "Manchester United" }, { id: "team-2", canonicalName: "Benfica U19" }],
    [candidate("api-football", "Man Utd", "af-1"), candidate("api-football", "Benfica", "af-2")]
  );
  assert.equal(result[0]?.state, "unresolved");
  assert.equal(result[0]?.identities[0]?.matchedBy, "curated_alias");
  assert.ok(result[0]?.reasons.includes("identity_seen_in_fewer_than_two_providers"));
  assert.equal(result[1]?.state, "unresolved");
});

test("keeps same-name collisions ambiguous instead of guessing an ID", () => {
  const result = discoverTrackedTeamIdentities(
    [{ id: "team-1", canonicalName: "Azam" }],
    [candidate("api-football", "Azam", "af-1"), candidate("api-football", "Azam", "af-2")]
  );
  assert.equal(result[0]?.state, "ambiguous");
  assert.deepEqual(result[0]?.identities, []);
  assert.ok(result[0]?.reasons.includes("multiple_provider_ids_match_same_tracked_name"));
});

test("does not guess a club's country, competition, or an ID when no provider ID exists", () => {
  const noId = candidate("sportapi-ai", "15 de Agosto de Santiago", "temporary");
  delete noId.home.providerTeamId;
  const result = discoverTrackedTeamIdentities(
    [{ id: "team-1", canonicalName: "15 de Agosto de Santiago" }],
    [noId]
  );
  assert.equal(result[0]?.state, "unresolved");
  assert.deepEqual(result[0]?.identities, []);
});

test("normalizes accents and punctuation but does not strip team category suffixes", () => {
  const result = discoverTrackedTeamIdentities(
    [{ id: "team-1", canonicalName: "Tabor Sezana" }, { id: "team-2", canonicalName: "Inter Milan Women" }],
    [candidate("api-football", "Tabor Sežana", "af-1"), candidate("api-football", "Inter Milan", "af-2")]
  );
  assert.equal(result[0]?.state, "resolved");
  assert.equal(result[1]?.state, "unresolved");
});
