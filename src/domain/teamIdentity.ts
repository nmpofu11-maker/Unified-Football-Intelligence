import type { ProviderFixtureCandidate } from "../providers/provider.js";

export interface TrackedTeamIdentity {
  id: string;
  canonicalName: string;
  aliases?: string[];
}
export interface DiscoveredProviderIdentity {
  provider: string;
  providerTeamId: string;
  providerName: string;
  matchedBy: "canonical_name" | "curated_alias";
}
export interface TeamIdentityDiscovery {
  trackedTeamId: string;
  canonicalName: string;
  state: "resolved" | "ambiguous" | "unresolved";
  identities: DiscoveredProviderIdentity[];
  reasons: string[];
}

const normalise = (value: string): string =>
  value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

// Exact, deliberately curated equivalences only. Youth, reserve, and women's
// suffixes are not stripped because doing so can merge different teams.
const CURATED_ALIASES: Record<string, string[]> = {
  "manchester united": ["man utd", "man united", "manchester utd"],
  "manchester city": ["man city"],
  "nottingham forest": ["nottm forest"],
  "wolverhampton wanderers": ["wolves"],
  "queens park rangers": ["qpr"],
  "tottenham hotspur": ["spurs"],
  "atletico madrid": ["ath madrid", "atletico de madrid"],
  "inter": ["internazionale", "fc internazionale milano"],
  "paris saint germain": ["psg"],
  "st johnstone f.c.": ["st johnstone", "st. johnstone"],
  "st. patrick's athletic": ["st patricks athletic", "st patrick's athletic"]
};

function namesFor(team: TrackedTeamIdentity): Map<string, "canonical_name" | "curated_alias"> {
  const names = new Map<string, "canonical_name" | "curated_alias">();
  names.set(normalise(team.canonicalName), "canonical_name");
  for (const alias of team.aliases ?? []) names.set(normalise(alias), "curated_alias");
  for (const [canonical, aliases] of Object.entries(CURATED_ALIASES)) {
    const normalizedCanonical = normalise(canonical);
    if (normalizedCanonical === normalise(team.canonicalName)) {
      for (const alias of aliases) names.set(normalise(alias), "curated_alias");
    }
    if (aliases.some(alias => normalise(alias) === normalise(team.canonicalName))) {
      names.set(normalizedCanonical, "curated_alias");
      for (const alias of aliases) names.set(normalise(alias), "canonical_name");
    }
  }
  return names;
}

/**
 * Discovers provider IDs from observed fixtures without guessing country or league.
 * A name is only mapped when exactly one provider team ID supports the exact name
 * or a curated alias. Missing IDs and collisions remain unresolved/ambiguous.
 */
export function discoverTrackedTeamIdentities(
  trackedTeams: TrackedTeamIdentity[],
  candidates: ProviderFixtureCandidate[]
): TeamIdentityDiscovery[] {
  const observed: Array<{ provider: string; providerTeamId: string; name: string }> = [];
  for (const candidate of candidates) {
    for (const team of [candidate.home, candidate.away]) {
      if (team.providerTeamId?.trim() && team.name.trim()) {
        observed.push({ provider: candidate.provider, providerTeamId: team.providerTeamId.trim(), name: team.name.trim() });
      }
    }
  }

  return trackedTeams.map(tracked => {
    const acceptedNames = namesFor(tracked);
    const byProvider = new Map<string, Map<string, { name: string; matchedBy: "canonical_name" | "curated_alias" }>>();
    const reasons = new Set<string>();
    for (const team of observed) {
      const matchedBy = acceptedNames.get(normalise(team.name));
      if (!matchedBy) continue;
      const providerTeams = byProvider.get(team.provider) ?? new Map();
      const existing = providerTeams.get(team.providerTeamId);
      providerTeams.set(team.providerTeamId, {
        name: team.name,
        matchedBy: existing?.matchedBy === "canonical_name" || matchedBy === "canonical_name"
          ? "canonical_name" : "curated_alias"
      });
      byProvider.set(team.provider, providerTeams);
    }

    const identities: DiscoveredProviderIdentity[] = [];
    let ambiguous = false;
    for (const [provider, providerTeams] of byProvider) {
      if (providerTeams.size > 1) {
        ambiguous = true;
        reasons.add("multiple_provider_ids_match_same_tracked_name");
        continue;
      }
      const [providerTeamId, details] = [...providerTeams.entries()][0] ?? [];
      if (providerTeamId && details) {
        identities.push({ provider, providerTeamId, providerName: details.name, matchedBy: details.matchedBy });
      }
    }
    if (!identities.length && !ambiguous) reasons.add("no_exact_or_curated_alias_observation");
    if (identities.length && identities.length < 2) reasons.add("identity_seen_in_fewer_than_two_providers");
    return {
      trackedTeamId: tracked.id,
      canonicalName: tracked.canonicalName,
      state: ambiguous ? "ambiguous" : identities.length >= 2 ? "resolved" : "unresolved",
      identities: identities.sort((a, b) => a.provider.localeCompare(b.provider)),
      reasons: [...reasons].sort()
    };
  });
}

export interface TeamSearchIdentityResolution {
  trackedTeamId: string;
  canonicalName: string;
  state: "confirmed" | "ambiguous" | "unresolved";
  identities: Array<{
    provider: "api-football" | "sportmonks";
    providerTeamId: string;
    providerName: string;
    country: string;
  }>;
  reasons: string[];
}

/**
 * Confirms a provider identity only when both provider catalogues return one
 * exact/curated-name candidate and their country metadata agrees. It never
 * strips youth, reserve, or women's qualifiers.
 */
export function reconcileTeamSearchIdentity(
  tracked: TrackedTeamIdentity,
  providerResults: import("../providers/teamSearch.js").TeamSearchProviderResult[]
): TeamSearchIdentityResolution {
  const matchingNames = namesFor(tracked);
  const normalizeCountry = (value: string): string =>
    value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  const providers = (["api-football", "sportmonks"] as const).map(provider => {
    const result = providerResults.find(item => item.provider === provider);
    const candidates = (result?.candidates ?? []).filter(candidate => matchingNames.has(normalise(candidate.name)));
    return { provider, result, candidates };
  });
  const reasons = new Set<string>();
  const identities: TeamSearchIdentityResolution["identities"] = [];
  if (providers.some(item => item.candidates.length > 1)) {
    reasons.add("multiple_exact_candidates_within_provider");
    return { trackedTeamId: tracked.id, canonicalName: tracked.canonicalName, state: "ambiguous", identities: [], reasons: [...reasons] };
  }
  const api = providers[0]!;
  const sportmonks = providers[1]!;
  // Keep a unique exact identity from an individual provider even when the other
  // catalogue has no result. This is still an unresolved cross-provider mapping:
  // preserving the candidate must never be mistaken for corroboration.
  if (api.candidates.length !== 1 || sportmonks.candidates.length !== 1) {
    reasons.add("requires_one_exact_candidate_from_each_provider");
    if (api.candidates.length === 0 && sportmonks.candidates.length === 0) reasons.add("no_exact_or_curated_alias_search_candidate");
    for (const item of providers) {
      const candidate = item.candidates[0];
      if (candidate?.country?.trim()) {
        identities.push({
          provider: item.provider,
          providerTeamId: candidate.providerTeamId,
          providerName: candidate.name,
          country: candidate.country
        });
      }
    }
    if (identities.length) reasons.add("single_provider_identity_preserved_not_cross_provider_confirmed");
    return {
      trackedTeamId: tracked.id,
      canonicalName: tracked.canonicalName,
      state: "unresolved",
      identities,
      reasons: [...reasons]
    };
  }
  const apiCandidate = api.candidates[0]!;
  const sportmonksCandidate = sportmonks.candidates[0]!;
  if (!apiCandidate.country?.trim() || !sportmonksCandidate.country?.trim()) {
    reasons.add("country_metadata_missing");
    return { trackedTeamId: tracked.id, canonicalName: tracked.canonicalName, state: "unresolved", identities: [], reasons: [...reasons] };
  }
  if (normalizeCountry(apiCandidate.country) !== normalizeCountry(sportmonksCandidate.country)) {
    reasons.add("provider_country_conflict");
    return { trackedTeamId: tracked.id, canonicalName: tracked.canonicalName, state: "ambiguous", identities: [], reasons: [...reasons] };
  }
  identities.push(
    { provider: "api-football", providerTeamId: apiCandidate.providerTeamId, providerName: apiCandidate.name, country: apiCandidate.country },
    { provider: "sportmonks", providerTeamId: sportmonksCandidate.providerTeamId, providerName: sportmonksCandidate.name, country: sportmonksCandidate.country }
  );
  return { trackedTeamId: tracked.id, canonicalName: tracked.canonicalName, state: "confirmed", identities, reasons: ["unique_exact_name_and_country_match_across_two_providers"] };
}
