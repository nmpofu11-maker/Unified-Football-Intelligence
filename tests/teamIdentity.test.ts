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
    [
      candidate("api-football", "Tabor Sežana", "af-1"),
      candidate("sportapi-ai", "Tabor Sezana", "sa-1"),
      candidate("api-football", "Inter Milan", "af-2")
    ]
  );
  assert.equal(result[0]?.state, "resolved");
  assert.equal(result[1]?.state, "unresolved");
});

import { reconcileTeamSearchIdentity } from "../src/domain/teamIdentity.js";
import type { TeamSearchProviderResult } from "../src/providers/teamSearch.js";

test("confirms only unique exact cross-provider candidates with matching country", () => {
  const results: TeamSearchProviderResult[] = [
    { provider: "api-football", state: "success", candidates: [{ provider: "api-football", providerTeamId: "101", name: "Club Example", country: "Paraguay" }] },
    { provider: "sportmonks", state: "success", candidates: [{ provider: "sportmonks", providerTeamId: "202", name: "Club Example", country: "Paraguay" }] }
  ];
  const resolution = reconcileTeamSearchIdentity({ id: "team-1", canonicalName: "Club Example" }, results);
  assert.equal(resolution.state, "confirmed");
  assert.deepEqual(resolution.identities.map(item => item.providerTeamId), ["101", "202"]);
});

test("keeps country conflicts ambiguous and missing country unresolved", () => {
  const conflict: TeamSearchProviderResult[] = [
    { provider: "api-football", state: "success", candidates: [{ provider: "api-football", providerTeamId: "101", name: "Club Example", country: "Paraguay" }] },
    { provider: "sportmonks", state: "success", candidates: [{ provider: "sportmonks", providerTeamId: "202", name: "Club Example", country: "Uruguay" }] }
  ];
  assert.equal(reconcileTeamSearchIdentity({ id: "team-1", canonicalName: "Club Example" }, conflict).state, "ambiguous");
  const missingCountry: TeamSearchProviderResult[] = [
    conflict[0]!,
    { provider: "sportmonks", state: "success", candidates: [{ provider: "sportmonks", providerTeamId: "202", name: "Club Example" }] }
  ];
  assert.equal(reconcileTeamSearchIdentity({ id: "team-1", canonicalName: "Club Example" }, missingCountry).state, "unresolved");
});

test("does not merge youth/reserve/women variants by stripping suffixes", () => {
  const results: TeamSearchProviderResult[] = [
    { provider: "api-football", state: "success", candidates: [{ provider: "api-football", providerTeamId: "101", name: "Benfica", country: "Portugal" }] },
    { provider: "sportmonks", state: "success", candidates: [{ provider: "sportmonks", providerTeamId: "202", name: "Benfica", country: "Portugal" }] }
  ];
  assert.equal(reconcileTeamSearchIdentity({ id: "team-1", canonicalName: "Benfica U19" }, results).state, "unresolved");
});

test("preserves a unique exact candidate from one provider without falsely confirming cross-provider identity", () => {
  const results: TeamSearchProviderResult[] = [
    { provider: "api-football", state: "success", candidates: [{ provider: "api-football", providerTeamId: "7888", name: "Benfica U19", country: "Portugal" }] },
    { provider: "sportmonks", state: "success_empty", candidates: [] }
  ];
  const resolution = reconcileTeamSearchIdentity({ id: "team-benfica-u19", canonicalName: "Benfica U19" }, results);
  assert.equal(resolution.state, "unresolved");
  assert.deepEqual(resolution.identities, [{
    provider: "api-football",
    providerTeamId: "7888",
    providerName: "Benfica U19",
    country: "Portugal"
  }]);
  assert.ok(resolution.reasons.includes("single_provider_identity_preserved_not_cross_provider_confirmed"));
});


test("uses the senior Club Brugge KV alias without merging youth, reserve, or women squads", () => {
  const results: TeamSearchProviderResult[] = [
    {
      provider: "api-football",
      state: "success",
      candidates: [
        { provider: "api-football", providerTeamId: "10845", name: "Club Brugge U21", country: "Belgium" },
        { provider: "api-football", providerTeamId: "14130", name: "Club Brugge II", country: "Belgium" },
        { provider: "api-football", providerTeamId: "569", name: "Club Brugge KV", country: "Belgium" },
        { provider: "api-football", providerTeamId: "6344", name: "Club Brugge W", country: "Belgium" },
        { provider: "api-football", providerTeamId: "7893", name: "Club Brugge U19", country: "Belgium" }
      ]
    },
    { provider: "sportmonks", state: "success_empty", candidates: [] }
  ];
  const resolution = reconcileTeamSearchIdentity({
    id: "team-club-brugge",
    canonicalName: "Club Brugge",
    country: "Belgium",
    league: "Belgian Pro League",
    teamCategory: "senior"
  }, results);
  assert.equal(resolution.state, "unresolved");
  assert.deepEqual(resolution.identities, [{
    provider: "api-football",
    providerTeamId: "569",
    providerName: "Club Brugge KV",
    country: "Belgium"
  }]);
});

test("rejects an exact-name search candidate when its country conflicts with the trusted watchlist", () => {
  const results: TeamSearchProviderResult[] = [
    {
      provider: "api-football",
      state: "success",
      candidates: [{ provider: "api-football", providerTeamId: "999", name: "Nantes", country: "United States" }]
    },
    {
      provider: "sportmonks",
      state: "success",
      candidates: [{ provider: "sportmonks", providerTeamId: "202", name: "Nantes", country: "France" }]
    }
  ];
  const resolution = reconcileTeamSearchIdentity({
    id: "team-fc-nantes",
    canonicalName: "FC Nantes",
    country: "France",
    teamCategory: "senior"
  }, results);
  assert.equal(resolution.state, "unresolved");
  assert.deepEqual(resolution.identities, [{
    provider: "sportmonks",
    providerTeamId: "202",
    providerName: "Nantes",
    country: "France"
  }]);
});


test("preserves a unique single-provider identity when country metadata is missing", () => {
  const results: TeamSearchProviderResult[] = [
    { provider: "api-football", state: "success", candidates: [{ provider: "api-football", providerTeamId: "af-15", name: "15 de Agosto" }] },
    { provider: "sportmonks", state: "success_empty", candidates: [] }
  ];
  const resolution = reconcileTeamSearchIdentity({ id: "team-15-agosto", canonicalName: "15 de Agosto" }, results);
  assert.equal(resolution.state, "unresolved");
  assert.deepEqual(resolution.identities, [{
    provider: "api-football", providerTeamId: "af-15", providerName: "15 de Agosto"
  }]);
  assert.ok(resolution.reasons.includes("single_provider_identity_preserved_not_cross_provider_confirmed"));
});
