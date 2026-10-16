import type { Competition, Fixture, Team } from "../domain/types.js";
import type { ProviderFixtureCandidate } from "../providers/provider.js";

export type IdentityResolution =
  | { state: "resolved"; id: string; method: "provider_id" | "exact_name_or_alias" }
  | { state: "unresolved"; candidates: string[]; reason: string }
  | { state: "ambiguous"; candidates: string[]; reason: string }
  | { state: "conflict"; candidates: string[]; reason: string };

export function normalizeIdentityName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[’']/g, "'").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function resolveTeamIdentity(provider: string, providerTeamId: string | undefined, name: string, teams: Team[]): IdentityResolution {
  const byId = providerTeamId ? teams.filter(t => t.providerIds[provider] === providerTeamId) : [];
  if (byId.length > 1) return { state: "conflict", candidates: byId.map(t => t.id), reason: "provider_team_id_maps_to_multiple_canonical_teams" };
  if (byId.length === 1) {
    const team = byId[0]!;
    const accepted = [team.canonicalName, ...team.aliases].map(normalizeIdentityName);
    if (!accepted.includes(normalizeIdentityName(name))) return { state: "conflict", candidates: [team.id], reason: "provider_team_id_and_name_disagree" };
    return { state: "resolved", id: team.id, method: "provider_id" };
  }
  const normalized = normalizeIdentityName(name);
  const matches = teams.filter(t => [t.canonicalName, ...t.aliases].some(n => normalizeIdentityName(n) === normalized));
  if (matches.length === 1) return { state: "resolved", id: matches[0]!.id, method: "exact_name_or_alias" };
  if (matches.length > 1) return { state: "ambiguous", candidates: matches.map(t => t.id), reason: "name_matches_multiple_canonical_teams" };
  return { state: "unresolved", candidates: [], reason: "no_exact_canonical_team_mapping" };
}

export function resolveCompetitionIdentity(provider: string, providerCompetitionId: string | undefined, name: string, competitions: Competition[]): IdentityResolution {
  const byId = providerCompetitionId ? competitions.filter(c => c.providerIds[provider] === providerCompetitionId) : [];
  if (byId.length > 1) return { state: "conflict", candidates: byId.map(c => c.id), reason: "provider_competition_id_maps_to_multiple_canonical_competitions" };
  if (byId.length === 1) {
    const competition = byId[0]!;
    if (normalizeIdentityName(competition.canonicalName) !== normalizeIdentityName(name)) return { state: "conflict", candidates: [competition.id], reason: "provider_competition_id_and_name_disagree" };
    return { state: "resolved", id: competition.id, method: "provider_id" };
  }
  const matches = competitions.filter(c => normalizeIdentityName(c.canonicalName) === normalizeIdentityName(name));
  if (matches.length === 1) return { state: "resolved", id: matches[0]!.id, method: "exact_name_or_alias" };
  if (matches.length > 1) return { state: "ambiguous", candidates: matches.map(c => c.id), reason: "competition_name_matches_multiple_canonical_competitions" };
  return { state: "unresolved", candidates: [], reason: "no_exact_canonical_competition_mapping" };
}

export type CanonicalizationResult =
  | { state: "resolved"; fixture: Fixture; methods: { home: string; away: string; competition: string } }
  | { state: "blocked"; reasons: string[]; home: IdentityResolution; away: IdentityResolution; competition: IdentityResolution };

export function canonicalizeFixtureCandidate(candidate: ProviderFixtureCandidate, teams: Team[], competitions: Competition[]): CanonicalizationResult {
  const home = resolveTeamIdentity(candidate.provider, candidate.home.providerTeamId, candidate.home.name, teams);
  const away = resolveTeamIdentity(candidate.provider, candidate.away.providerTeamId, candidate.away.name, teams);
  const competition = resolveCompetitionIdentity(candidate.provider, candidate.competition.providerCompetitionId, candidate.competition.name, competitions);
  const reasons: string[] = [];
  if (home.state !== "resolved") reasons.push(`home_team_${home.state}:${home.reason}`);
  if (away.state !== "resolved") reasons.push(`away_team_${away.state}:${away.reason}`);
  if (competition.state !== "resolved") reasons.push(`competition_${competition.state}:${competition.reason}`);
  if (home.state === "resolved" && away.state === "resolved" && home.id === away.id) reasons.push("same_canonical_home_and_away_team");
  if (!candidate.providerFixtureId.trim()) reasons.push("provider_fixture_id_missing");
  if (!candidate.kickoffUtc.endsWith("Z") || !Number.isFinite(Date.parse(candidate.kickoffUtc))) reasons.push("kickoff_not_normalized_utc");
  if (reasons.length || home.state !== "resolved" || away.state !== "resolved" || competition.state !== "resolved") {
    return { state: "blocked", reasons, home, away, competition };
  }
  const fixture: Fixture = {
    id: `fx:${competition.id}:${candidate.providerSeasonId ?? "unknown-season"}:${candidate.kickoffUtc}:${home.id}:${away.id}`,
    competitionId: competition.id,
    ...(candidate.providerSeasonId ? { seasonId: candidate.providerSeasonId } : {}),
    homeTeamId: home.id, awayTeamId: away.id, kickoffUtc: candidate.kickoffUtc,
    status: candidate.status, provenance: [candidate.provenance]
  };
  return { state: "resolved", fixture, methods: { home: home.method, away: away.method, competition: competition.method } };
}
