import type { ProviderFixtureCandidate } from "../providers/provider.js";

export type CandidateMatchState = "single_source" | "corroborated" | "conflicted";

export interface CandidateMatchPreview {
  key: string;
  state: CandidateMatchState;
  providers: string[];
  observations: number;
  home: string;
  away: string;
  competition: string;
  kickoffUtc: string;
  statuses: string[];
  scores: Array<{ home: number; away: number }>;
  reasons: string[];
}

const normalise = (value: string): string =>
  value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

// Exact, curated aliases only; never use fuzzy matching for identity decisions.
const TEAM_ALIASES: Record<string, string> = {
  "man utd": "manchester united",
  "man united": "manchester united",
  "manchester utd": "manchester united",
  "man city": "manchester city",
  "nottm forest": "nottingham forest",
  "wolves": "wolverhampton wanderers",
  "qpr": "queens park rangers",
  "spurs": "tottenham hotspur",
  "ath madrid": "atletico madrid",
  "atletico de madrid": "atletico madrid",
  "internazionale": "inter",
  "fc internazionale milano": "inter",
  "psg": "paris saint germain"
};

const COMPETITION_ALIASES: Record<string, string> = {
  "english premier league": "premier league",
  "england premier league": "premier league",
  "epl": "premier league",
  "english championship": "championship",
  "england championship": "championship",
  "uefa champions league": "champions league",
  "uefa europa league": "europa league",
  "uefa conference league": "conference league"
};

function canonicalName(value: string, aliases: Record<string, string>): string {
  const normalized = normalise(value);
  return aliases[normalized] ?? normalized;
}

function baseKey(f: ProviderFixtureCandidate): string {
  return [
    canonicalName(f.home.name, TEAM_ALIASES),
    canonicalName(f.away.name, TEAM_ALIASES),
    canonicalName(f.competition.name, COMPETITION_ALIASES)
  ].join("|");
}

/**
 * Conservative cross-provider corroboration preview. This intentionally does not
 * create canonical fixtures, resolve team/competition IDs, or verify result evidence.
 * Curated exact aliases bridge known naming variants; kickoff times must still be within five minutes.
 */
export function previewCandidateReconciliation(
  candidates: ProviderFixtureCandidate[],
  kickoffToleranceMs = 5 * 60_000,
  nowMs = Date.now()
): CandidateMatchPreview[] {
  const buckets = new Map<string, ProviderFixtureCandidate[]>();
  for (const candidate of candidates) {
    const kickoff = Date.parse(candidate.kickoffUtc);
    if (!Number.isFinite(kickoff) || !candidate.home.name.trim() ||
        !candidate.away.name.trim() || !candidate.competition.name.trim()) continue;
    const key = baseKey(candidate);
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
  }

  const previews: CandidateMatchPreview[] = [];
  for (const [key, bucket] of buckets) {
    const sorted = [...bucket].sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc));
    const groups: ProviderFixtureCandidate[][] = [];
    for (const candidate of sorted) {
      const kickoff = Date.parse(candidate.kickoffUtc);
      const existing = groups.find(group =>
        Math.abs(Date.parse(group[0]!.kickoffUtc) - kickoff) <= kickoffToleranceMs &&
        !group.some(item => item.provider === candidate.provider)
      );
      if (existing) existing.push(candidate);
      else groups.push([candidate]);
    }
    for (const group of groups) {
      const providers = [...new Set(group.map(item => item.provider))].sort();
      const statuses = [...new Set(group.map(item => item.status))].sort();
      const scores = [...new Map(group.filter(item => item.score)
        .map(item => [`${item.score!.home}-${item.score!.away}`, { home: item.score!.home, away: item.score!.away }])).values()];
      const reasons: string[] = [];
      if (providers.length < 2) reasons.push("only_one_provider_observation");
      if (statuses.length > 1) reasons.push("provider_status_disagreement");
      // A live status is stale if either its observation timestamp or the current
      // wall clock is more than six hours after kickoff. Some feeds preserve an old
      // event timestamp in the payload, so observedAt alone is not a safe freshness gate.
      // Do not infer a final score or expose stale live data as a current corroborated fixture.
      const staleLiveObservation = group.some(item =>
        item.status === "live" &&
        Math.max(Date.parse(item.observedAt), nowMs) - Date.parse(item.kickoffUtc) > 6 * 60 * 60_000
      );
      if (staleLiveObservation) reasons.push("stale_live_status");
      if (scores.length > 1) reasons.push("provider_score_disagreement");
      if (group.some(item => item.status === "finished" && !item.score)) reasons.push("finished_observation_missing_score");
      // A stale live label is a freshness/availability problem, not evidence that
      // providers disagree. Keep it visible in reasons, but do not inflate the
      // conflict count or let that label alone classify a fixture as conflicted.
      // Stale live fixtures are separately filtered from the canonical read model.
      // Keep stale live observations in the blocked/conflicted state so they can
      // never enter the canonical corroborated read model. The stale_live_status
      // reason and staleLiveGroups diagnostic distinguish freshness blocks from
      // genuine cross-provider status/score disagreements.
      const state: CandidateMatchState = reasons.some(reason =>
        reason === "provider_status_disagreement" ||
        reason === "provider_score_disagreement" ||
        reason === "stale_live_status"
      ) ? "conflicted" : providers.length >= 2 ? "corroborated" : "single_source";
      const representative = group[0]!;
      previews.push({
        key: `${key}|${Math.min(...group.map(item => Date.parse(item.kickoffUtc))) }`,
        state,
        providers,
        observations: group.length,
        home: representative.home.name,
        away: representative.away.name,
        competition: representative.competition.name,
        kickoffUtc: representative.kickoffUtc,
        statuses,
        scores,
        reasons
      });
    }
  }
  return previews.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));
}
