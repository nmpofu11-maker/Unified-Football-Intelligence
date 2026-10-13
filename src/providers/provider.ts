import type { EvidenceState, Fixture, Provenance } from "../domain/types.js";

export type ProviderCallState = "idle" | "requesting" | "success" | "success_empty" | "partial" | "rate_limited" | "auth_error" | "http_error" | "request_error" | "schema_error" | "unavailable";
export interface ProviderDiagnostics {
  provider: string;
  state: ProviderCallState;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastHttpStatus?: number;
  lastRecordCount: number;
  lastAcceptedCount?: number;
  lastRejectedCount?: number;
  lastRejectionReasons?: Record<string, number>;
  lastResponseShape?: { topLevelKeys: string[]; rowCount?: number; message?: string; uriPath?: string };
  lastErrorCode?: string;
}
export interface FixtureQuery { dateFromUtc: string; dateToUtc: string; competitionIds?: string[]; }
export interface ProviderTeamCandidate { providerTeamId?: string; name: string; }
export interface ProviderCompetitionCandidate { providerCompetitionId?: string; name: string; }
/** Provider observation before canonical identity mapping; it is never a canonical fixture by itself. */
export interface ProviderFixtureCandidate {
  provider: string;
  providerFixtureId: string;
  kickoffUtc: string;
  home: ProviderTeamCandidate;
  away: ProviderTeamCandidate;
  competition: ProviderCompetitionCandidate;
  providerSeasonId?: string;
  status: Fixture["status"];
  observedAt: string;
  evidenceState: EvidenceState;
  rawStatus: string;
  score?: { home: number; away: number };
  provenance: Provenance;
}
export interface FootballDataProvider {
  readonly name: string;
  fetchFixtures(query: FixtureQuery, signal?: AbortSignal): Promise<ProviderFixtureCandidate[]>;
  diagnostics(): ProviderDiagnostics;
}
