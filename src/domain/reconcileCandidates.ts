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

function baseKey(f: ProviderFixtureCandidate): string {
  return [
    normalise(f.home.name),
    normalise(f.away.name),
    normalise(f.competition.name)
  ].join("|");
}

/**
 * Conservative cross-provider corroboration preview. This intentionally does not
 * create canonical fixtures, resolve team/competition IDs, or verify result evidence.
 * Only exact normalized names and kickoff times within five minutes are grouped.
 */
export function previewCandidateReconciliation(
  candidates: ProviderFixtureCandidate[],
  kickoffToleranceMs = 5 * 60_000
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
      if (scores.length > 1) reasons.push("provider_score_disagreement");
      if (group.some(item => item.status === "finished" && !item.score)) reasons.push("finished_observation_missing_score");
      const state: CandidateMatchState = reasons.some(reason =>
        reason === "provider_status_disagreement" || reason === "provider_score_disagreement"
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
