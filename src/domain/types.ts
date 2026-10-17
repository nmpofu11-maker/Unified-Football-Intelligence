export type EvidenceState = "verified" | "unverified" | "stale" | "conflicted" | "unavailable" | "insufficient_evidence";
export interface Provenance { provider: string; providerRecordId?: string; retrievedAt: string; payloadHash?: string; evidenceState: EvidenceState; }
export interface Team { id: string; canonicalName: string; countryCode?: string; aliases: string[]; providerIds: Record<string, string>; }
export interface Competition { id: string; canonicalName: string; countryCode?: string; providerIds: Record<string, string>; }
export interface Fixture {
  id: string; competitionId: string; seasonId?: string; homeTeamId: string; awayTeamId: string; kickoffUtc: string;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "abandoned" | "unknown";
  provenance: Provenance[];
}
export interface SettledResult {
  fixtureId: string; homeGoals: number; awayGoals: number; settledAt: string; provenance: Provenance[];
  reconciliationState: "verified" | "conflicted" | "unverified";
}
export interface ProbabilityForecast {
  fixtureId: string; modelId: string; modelVersion: string; generatedAt: string; featureCutoffAt: string;
  homeWin: number | null; draw: number | null; awayWin: number | null; evidenceState: EvidenceState; abstentionReasons: string[];
}
export interface OddsQuote {
  fixtureId: string; bookmaker: string; market: string; selection: string; decimalOdds: number; observedAt: string; provenance: Provenance;
}
