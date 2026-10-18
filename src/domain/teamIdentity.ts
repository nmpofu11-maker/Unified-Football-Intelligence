import type { ProviderFixtureCandidate } from "../providers/provider.js";


export interface TrackedTeamIdentity {
  id: string;
  canonicalName: string;
  aliases?: string[];
  /** User-confirmed watchlist metadata, used to reject wrong-country search candidates. */
  country?: string;
  league?: string;
  teamCategory?: string;
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
  "st. patrick's athletic": ["st patricks athletic", "st patrick's athletic"],
  // Provider catalogues may expose the senior Belgian club under its registered
  // "KV" form. Category suffixes for other Brugge squads are intentionally absent.
  "club brugge": ["club brugge kv"],
  "fc nantes": ["nantes"],
  "rc sporting charleroi": ["sporting charleroi", "royal charleroi sporting club"],
  "shelbourne women": ["shelbourne w"],
  "linfield women": ["linfield w"],
  "sligo rovers women": ["sligo rovers w"]
};

/**
 * Returns at most one trusted query alias for a tracked name. This is narrow by
 * design and never strips squad qualifiers such as U19, II, B, W, or reserve.
 */
export function curatedTeamSearchAliases(team: TrackedTeamIdentity): string[] {
  const canonical = normalise(team.canonicalName);
  const candidates = [...(team.aliases ?? [])];
  for (const [name, aliases] of Object.entries(CURATED_ALIASES)) {
    if (normalise(name) === canonical || aliases.some(alias => normalise(alias) === canonical)) {
      candidates.push(...aliases, name);
    }
  }
  const seen = new Set([canonical]);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const normalized = normalise(trimmed);
    if (!trimmed || seen.has(normalized)) continue;
    return [trimmed];
  }
  return [];
}

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


export interface TeamSearchCandidateAssessment {
  provider: "api-football" | "sportmonks" | "sportapi-ai";
  providerTeamId: string;
  providerName: string;
  nameMatch: "canonical_name" | "curated_alias" | "unrelated_search_result";
  countryMatch: "match" | "conflict" | "unknown";
  categoryMatch: "match" | "mismatch" | "unknown";
  reviewState: "candidate_matches_watchlist_context" | "needs_review";
  reasons: string[];
}

function normalizedCountry(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function observedSquadCategory(
  name: string,
  gender?: string,
  teamType?: string
): "women" | "youth" | "women_youth" | "reserve" | "senior" {
  const value = normalise(name);
  const metadata = normalise(`${gender ?? ""} ${teamType ?? ""}`);
  const isWomen = /(^| )(women|woman|ladies|female|w)$/.test(value) ||
    /(^| )(women|woman|ladies|female|w)( |$)/.test(metadata);
  // Youth markers may occur before a gender marker, e.g. "France U16 W".
  // Provider metadata is considered as well as the display name so a plain
  // name with a female/youth team classification is not treated as senior.
  const isYouth = /(^| )(u[0-9]{1,2}|youth|academy|junior|juniors)( |$)/.test(value) ||
    /(^| )(u[0-9]{1,2}|youth|academy|junior|juniors)( |$)/.test(metadata);
  if (isWomen && isYouth) return "women_youth";
  if (isWomen) return "women";
  if (isYouth) return "youth";
  if (/(^| )(ii|iii|iv|b|res|reserve|reserves|amateure|amateures|amateurs)$/.test(value) ||
      /(^| )(ii|iii|iv|b|res|reserve|reserves|second team)( |$)/.test(metadata)) return "reserve";
  return "senior";
}

function matchesTrackedSquadCategory(
  trackedCategory: string | undefined,
  candidateName: string,
  gender?: string,
  teamType?: string
): boolean {
  if (!trackedCategory) return true;
  const observed = observedSquadCategory(candidateName, gender, teamType);
  if (trackedCategory === "senior") return observed === "senior";
  if (trackedCategory === "women" || trackedCategory === "international_women") return observed === "women";
  if (trackedCategory === "youth" || trackedCategory === "international_youth") return observed === "youth";
  if (trackedCategory === "reserve") return observed === "reserve";
  return true;
}

/**
 * Explains whether raw search candidates fit the user's watchlist context.
 * This is a review aid only: even a matching candidate is not a confirmed
 * cross-provider identity and is never evidence of settled match history.
 */
export function reviewTeamSearchCandidates(
  tracked: TrackedTeamIdentity,
  providerResults: Array<{
    provider: "api-football" | "sportmonks" | "sportapi-ai";
    candidates: Array<{ providerTeamId: string; name: string; country?: string; gender?: string; teamType?: string; league?: string }>;
  }>
): TeamSearchCandidateAssessment[] {
  const acceptedNames = namesFor(tracked);
  const expectedCategory = tracked.teamCategory;
  const assessments: TeamSearchCandidateAssessment[] = [];
  for (const result of providerResults) {
    for (const candidate of result.candidates) {
      const normalizedName = normalise(candidate.name);
      const matchedName = acceptedNames.get(normalizedName);
      const countryMatch: TeamSearchCandidateAssessment["countryMatch"] =
        !tracked.country?.trim() || !candidate.country?.trim() ? "unknown" :
          normalizedCountry(tracked.country) === normalizedCountry(candidate.country) ? "match" : "conflict";
      const observedCategory = observedSquadCategory(candidate.name, candidate.gender, candidate.teamType);
      let categoryMatch: TeamSearchCandidateAssessment["categoryMatch"] = "unknown";
      if (expectedCategory === "senior") categoryMatch = observedCategory === "senior" ? "match" : "mismatch";
      else if (expectedCategory === "women" || expectedCategory === "international_women") {
        categoryMatch = observedCategory === "women" ? "match" : "mismatch";
      } else if (expectedCategory === "youth" || expectedCategory === "international_youth") categoryMatch = observedCategory === "youth" ? "match" : "mismatch";
      else if (expectedCategory === "reserve") categoryMatch = observedCategory === "reserve" ? "match" : "mismatch";

      const reasons: string[] = [];
      if (!matchedName) reasons.push("candidate_name_not_exact_or_curated_alias");
      if (countryMatch === "conflict") reasons.push("candidate_country_conflicts_with_watchlist");
      if (categoryMatch === "mismatch") reasons.push("candidate_squad_category_conflicts_with_watchlist");
      if (countryMatch === "unknown") reasons.push("country_context_missing_or_unavailable");
      if (categoryMatch === "unknown") reasons.push("squad_category_not_automatically_classified");
      const countrySufficient = !tracked.country?.trim() || countryMatch === "match";
      const categorySufficient = !expectedCategory || categoryMatch === "match";
      assessments.push({
        provider: result.provider,
        providerTeamId: candidate.providerTeamId,
        providerName: candidate.name,
        nameMatch: !matchedName ? "unrelated_search_result" : matchedName,
        countryMatch,
        categoryMatch,
        reviewState: matchedName && countrySufficient && categorySufficient
          ? "candidate_matches_watchlist_context" : "needs_review",
        reasons
      });
    }
  }
  return assessments;
}

export type ProviderIdentityState = "cross_provider_confirmed" | "operator_reviewed" | "provider_candidate" | "needs_review" | "ambiguous" | "unresolved";

/**
 * Separates a provider-scoped, context-compatible candidate from a confirmed
 * cross-provider mapping. This status is identity metadata only; it never
 * upgrades fixture observations into verified results.
 */
export function classifyProviderIdentityState(
  resolutionState: TeamSearchIdentityResolution["state"],
  identityPresent: boolean,
  reviewState?: TeamSearchCandidateAssessment["reviewState"]
): ProviderIdentityState {
  if (resolutionState === "confirmed" && identityPresent) return "cross_provider_confirmed";
  // Cross-provider ambiguity describes the overall mapping, not necessarily
  // the candidate returned by each provider. Preserve a unique, context-safe
  // provider-scoped candidate without claiming that the two providers agree.
  if (identityPresent && reviewState === "candidate_matches_watchlist_context") return "provider_candidate";
  if (resolutionState === "ambiguous") return "ambiguous";
  if (!identityPresent) return "unresolved";
  return "needs_review";
}

export interface TeamSearchIdentityResolution {
  trackedTeamId: string;
  canonicalName: string;
  state: "confirmed" | "ambiguous" | "unresolved";
  identities: Array<{
    provider: "api-football" | "sportmonks";
    providerTeamId: string;
    providerName: string;
    country?: string;
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
    const candidates = (result?.candidates ?? []).filter(candidate => {
      if (!matchingNames.has(normalise(candidate.name))) return false;
      // Never confirm a provider identity whose squad qualifiers conflict with
      // the user's watchlist category, even when that spelling is a curated alias.
      if (!matchesTrackedSquadCategory(tracked.teamCategory, candidate.name, candidate.gender, candidate.teamType)) return false;
      // The favourite watchlist's country is authoritative. When the watchlist
      // specifies a country, missing as well as conflicting provider country
      // metadata blocks automatic confirmation.
      if (tracked.country?.trim()) {
        if (!candidate.country?.trim()) {
          reasons.add("provider_country_missing");
          return false;
        }
        if (normalizeCountry(candidate.country) !== normalizeCountry(tracked.country)) {
          reasons.add("provider_country_conflict");
          return false;
        }
      }
      return true;
    });
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
      if (candidate) {
        identities.push({
          provider: item.provider,
          providerTeamId: candidate.providerTeamId,
          providerName: candidate.name,
          ...(candidate.country?.trim() ? { country: candidate.country } : {})
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
