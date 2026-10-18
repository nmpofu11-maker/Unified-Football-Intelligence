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

import { classifyProviderIdentityState, reconcileTeamSearchIdentity, reviewTeamSearchCandidates } from "../src/domain/teamIdentity.js";
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

test("rejects curated aliases whose squad category conflicts with the watchlist", () => {
  const results: TeamSearchProviderResult[] = [
    { provider: "api-football", state: "success", candidates: [{ provider: "api-football", providerTeamId: "w-101", name: "Club Example W", country: "Ireland" }] },
    { provider: "sportmonks", state: "success", candidates: [{ provider: "sportmonks", providerTeamId: "w-202", name: "Club Example W", country: "Ireland" }] }
  ];
  const resolution = reconcileTeamSearchIdentity({
    id: "club-example-senior",
    canonicalName: "Club Example",
    aliases: ["Club Example W"],
    country: "Ireland",
    teamCategory: "senior"
  }, results);
  assert.equal(resolution.state, "unresolved");
  assert.deepEqual(resolution.identities, []);
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


test("candidate review flags wrong-country results and separates senior, reserve, youth, and women squads", () => {
  const results: TeamSearchProviderResult[] = [
    {
      provider: "api-football",
      state: "success",
      candidates: [
        { provider: "api-football", providerTeamId: "569", name: "Club Brugge KV", country: "Belgium" },
        { provider: "api-football", providerTeamId: "14130", name: "Club Brugge II", country: "Belgium" },
        { provider: "api-football", providerTeamId: "6344", name: "Club Brugge W", country: "Belgium" },
        { provider: "api-football", providerTeamId: "7893", name: "Club Brugge U19", country: "Belgium" }
      ]
    },
    { provider: "sportmonks", state: "success_empty", candidates: [] }
  ];
  const review = reviewTeamSearchCandidates({
    id: "team-club-brugge",
    canonicalName: "Club Brugge",
    country: "Belgium",
    teamCategory: "senior"
  }, results);
  assert.equal(review.find(item => item.providerTeamId === "569")?.reviewState, "candidate_matches_watchlist_context");
  assert.equal(review.find(item => item.providerTeamId === "14130")?.categoryMatch, "mismatch");
  assert.equal(review.find(item => item.providerTeamId === "6344")?.categoryMatch, "mismatch");
  assert.equal(review.find(item => item.providerTeamId === "7893")?.categoryMatch, "mismatch");
  assert.equal(review.find(item => item.providerTeamId === "14130")?.reviewState, "needs_review");
});

test("candidate review surfaces country conflict even when a women's alias and squad category match", () => {
  const results: TeamSearchProviderResult[] = [
    {
      provider: "api-football",
      state: "success",
      candidates: [{ provider: "api-football", providerTeamId: "19837", name: "Shelbourne W", country: "England" }]
    },
    { provider: "sportmonks", state: "success_empty", candidates: [] }
  ];
  const review = reviewTeamSearchCandidates({
    id: "team-shelbourne-women",
    canonicalName: "Shelbourne Women",
    country: "Ireland",
    teamCategory: "women"
  }, results);
  assert.equal(review[0]?.nameMatch, "curated_alias");
  assert.equal(review[0]?.countryMatch, "conflict");
  assert.equal(review[0]?.categoryMatch, "match");
  assert.equal(review[0]?.reviewState, "needs_review");
  assert.ok(review[0]?.reasons.includes("candidate_country_conflicts_with_watchlist"));
});

test("classifies women's youth candidates separately from international youth watchlist teams", () => {
  const results: TeamSearchProviderResult[] = [{
    provider: "api-football",
    state: "success",
    candidates: [
      { provider: "api-football", providerTeamId: "22723", name: "France U16", country: "France" },
      { provider: "api-football", providerTeamId: "27109", name: "France U16 W", country: "France" },
      { provider: "api-football", providerTeamId: "22724", name: "Japan U16", country: "Japan" },
      { provider: "api-football", providerTeamId: "27134", name: "Japan U16 W", country: "Japan" }
    ]
  }];
  const france = reviewTeamSearchCandidates({
    id: "france-u16", canonicalName: "France U16", country: "France", teamCategory: "international_youth"
  }, results);
  assert.equal(france.find(item => item.providerTeamId === "22723")?.categoryMatch, "match");
  assert.equal(france.find(item => item.providerTeamId === "27109")?.categoryMatch, "mismatch");
  assert.equal(france.find(item => item.providerTeamId === "27109")?.reviewState, "needs_review");

  const japan = reviewTeamSearchCandidates({
    id: "japan-u16", canonicalName: "Japan U16", country: "Japan", teamCategory: "international_youth"
  }, results);
  assert.equal(japan.find(item => item.providerTeamId === "22724")?.categoryMatch, "match");
  assert.equal(japan.find(item => item.providerTeamId === "27134")?.categoryMatch, "mismatch");
});



test("separates a safe provider-scoped candidate from cross-provider confirmation", () => {
  assert.equal(classifyProviderIdentityState("unresolved", true, "candidate_matches_watchlist_context"), "provider_candidate");
  assert.equal(classifyProviderIdentityState("unresolved", true, "needs_review"), "needs_review");
  assert.equal(classifyProviderIdentityState("unresolved", false), "unresolved");
  assert.equal(classifyProviderIdentityState("ambiguous", true, "candidate_matches_watchlist_context"), "provider_candidate");
  assert.equal(classifyProviderIdentityState("ambiguous", false, "candidate_matches_watchlist_context"), "ambiguous");
  assert.equal(classifyProviderIdentityState("confirmed", true, "candidate_matches_watchlist_context"), "cross_provider_confirmed");
});

test("a provider-scoped candidate never promotes an unresolved team to cross-provider confirmed", () => {
  const results: TeamSearchProviderResult[] = [
    { provider: "api-football", state: "success", candidates: [{ provider: "api-football", providerTeamId: "569", name: "Club Brugge KV", country: "Belgium" }] },
    { provider: "sportmonks", state: "success_empty", candidates: [] }
  ];
  const tracked = { id: "club-brugge", canonicalName: "Club Brugge", country: "Belgium", teamCategory: "senior" };
  const resolution = reconcileTeamSearchIdentity(tracked, results);
  const assessment = reviewTeamSearchCandidates(tracked, results.map(item => ({
    provider: item.provider, candidates: item.candidates.map(candidate => ({ providerTeamId: candidate.providerTeamId, name: candidate.name, ...(candidate.country ? { country: candidate.country } : {}) }))
  }))).find(item => item.providerTeamId === "569");
  assert.equal(resolution.state, "unresolved");
  assert.equal(classifyProviderIdentityState(resolution.state, true, assessment?.reviewState), "provider_candidate");
  assert.ok(!resolution.reasons.includes("unique_exact_name_and_country_match_across_two_providers"));
});


test("provider metadata and missing country context prevent unsafe identity confirmation", () => {
  const tracked = {
    id: "club-brugge-senior",
    canonicalName: "Club Brugge KV",
    country: "Belgium",
    teamCategory: "senior"
  };
  const missingCountry = reviewTeamSearchCandidates(tracked, [{
    provider: "sportapi-ai",
    candidates: [{ providerTeamId: "no-country", name: "Club Brugge KV" }]
  }])[0];
  assert.equal(missingCountry?.countryMatch, "unknown");
  assert.equal(missingCountry?.reviewState, "needs_review");

  const womenMetadata = reviewTeamSearchCandidates(tracked, [{
    provider: "sportapi-ai",
    candidates: [{ providerTeamId: "women", name: "Club Brugge KV", country: "Belgium", gender: "female", teamType: "senior" }]
  }])[0];
  assert.equal(womenMetadata?.categoryMatch, "mismatch");
  assert.equal(womenMetadata?.reviewState, "needs_review");

  const reserveMetadata = reviewTeamSearchCandidates(tracked, [{
    provider: "sportapi-ai",
    candidates: [{ providerTeamId: "reserve", name: "Club Brugge KV", country: "Belgium", teamType: "reserve" }]
  }])[0];
  assert.equal(reserveMetadata?.categoryMatch, "mismatch");
  assert.equal(reserveMetadata?.reviewState, "needs_review");
});


test("SportAPI identity review uses country and squad metadata, not name alone", () => {
  const tracked = {
    id: "15-de-agosto-angola",
    canonicalName: "15 de Agosto",
    country: "Angola",
    teamCategory: "senior"
  };
  const correct = reviewTeamSearchCandidates(tracked, [{
    provider: "sportapi-ai",
    state: "success",
    candidates: [{
      providerTeamId: "ao-15-agosto",
      name: "15 de Agosto",
      country: "Angola",
      gender: "male",
      teamType: "senior",
      league: "Girabola"
    }]
  }])[0];
  assert.equal(correct?.countryMatch, "match");
  assert.equal(correct?.categoryMatch, "match");
  assert.equal(correct?.reviewState, "candidate_matches_watchlist_context");

  const wrongCountry = reviewTeamSearchCandidates(tracked, [{
    provider: "sportapi-ai",
    state: "success",
    candidates: [{
      providerTeamId: "european-15-agosto",
      name: "15 de Agosto",
      country: "Portugal",
      gender: "male",
      teamType: "senior"
    }]
  }])[0];
  assert.equal(wrongCountry?.countryMatch, "conflict");
  assert.equal(wrongCountry?.reviewState, "needs_review");

  const missingCategory = reviewTeamSearchCandidates(tracked, [{
    provider: "sportapi-ai",
    state: "success",
    candidates: [{
      providerTeamId: "unknown-category",
      name: "15 de Agosto",
      country: "Angola"
    }]
  }])[0];
  assert.equal(missingCategory?.categoryMatch, "unknown");
  assert.equal(missingCategory?.reviewState, "needs_review");
});
