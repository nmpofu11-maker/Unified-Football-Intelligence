import type { FixtureQuery, ProviderDiagnostics, ProviderFixtureCandidate } from "../provider.js";
import type { FootballDataProvider } from "../provider.js";

const NAME = "sportapi-ai";
let diagnostics: ProviderDiagnostics = { provider: NAME, state: "idle", lastRecordCount: 0 };
const key = () => (process.env.SPORTAPI_AI_KEY || process.env.SPORTAPI_API_KEY || "").trim();
const base = () => (process.env.SPORTAPI_AI_BASE_URL || "https://sportapi.ai/api").replace(/\/+$/, "");
const utc = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return null;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const statusMap = (value: unknown): ProviderFixtureCandidate["status"] => {
  const s = String(value ?? "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["scheduled", "not_started", "ns", "upcoming", "fixture"].includes(s)) return "scheduled";
  if (["live", "in_play", "1h", "2h", "ht", "in_progress"].includes(s)) return "live";
  if (["finished", "ft", "aet", "pen", "final", "completed", "ended"].includes(s)) return "finished";
  if (s.includes("postpon")) return "postponed";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("abandon")) return "abandoned";
  return "unknown";
};

export function mapSportApiAiFixture(raw: unknown, observedAt = new Date().toISOString()): ProviderFixtureCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, any>;
  const fixtureId = f.id ?? f.fixture_id ?? f.fixture?.id;
  const home = f.home_team ?? f.homeTeam ?? f.teams?.home;
  const away = f.away_team ?? f.awayTeam ?? f.teams?.away;
  const league = f.league ?? f.competition ?? f.competition_name;
  const leagueId = typeof league === "object" ? league?.id : f.league_id ?? f.competition_id;
  const leagueName = typeof league === "string" ? league : league?.name;
  const kickoff = utc(f.kickoff_utc ?? f.kickoffUtc ?? f.kickoff_time_utc ?? f.date ?? f.fixture?.date);
  if (fixtureId == null || home?.id == null || away?.id == null || !String(home?.name ?? "").trim() || !String(away?.name ?? "").trim() || leagueId == null || !String(leagueName ?? "").trim() || !kickoff) return null;
  const rawStatus = String(f.status?.short ?? f.status?.name ?? f.status ?? f.state ?? "unknown");
  const status = statusMap(rawStatus);
  const homeScore = f.score?.home ?? f.home_score ?? home.score;
  const awayScore = f.score?.away ?? f.away_score ?? away.score;
  const hasScore = status === "finished" && Number.isInteger(homeScore) && homeScore >= 0 && Number.isInteger(awayScore) && awayScore >= 0;
  return {
    provider: NAME, providerFixtureId: String(fixtureId), kickoffUtc: kickoff,
    home: { providerTeamId: String(home.id), name: String(home.name).trim() },
    away: { providerTeamId: String(away.id), name: String(away.name).trim() },
    competition: { providerCompetitionId: String(leagueId), name: String(leagueName).trim() },
    ...(f.season?.id != null || f.season_id != null ? { providerSeasonId: String(f.season?.id ?? f.season_id) } : {}),
    status, observedAt, evidenceState: "unverified", rawStatus,
    ...(hasScore ? { score: { home: homeScore as number, away: awayScore as number } } : {}),
    provenance: { provider: NAME, providerRecordId: String(fixtureId), retrievedAt: observedAt, evidenceState: "unverified" }
  };
}

export class SportApiAiProvider implements FootballDataProvider {
  readonly name = NAME;
  diagnostics() { return { ...diagnostics }; }

  async fetchFixtures(query: FixtureQuery, signal?: AbortSignal): Promise<ProviderFixtureCandidate[]> {
    const apiKey = key();
    if (!apiKey) { diagnostics = { provider: NAME, state: "unavailable", lastRecordCount: 0, lastErrorCode: "credential_not_configured" }; return []; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.dateFromUtc) || query.dateFromUtc !== query.dateToUtc || Number.isNaN(Date.parse(`${query.dateFromUtc}T00:00:00Z`)) || new Date(`${query.dateFromUtc}T00:00:00Z`).toISOString().slice(0, 10) !== query.dateFromUtc) {
      diagnostics = { provider: NAME, state: "schema_error", lastAttemptAt: new Date().toISOString(), lastRecordCount: 0, lastErrorCode: "adapter_requires_single_utc_calendar_date" }; return [];
    }
    const attemptedAt = new Date().toISOString();
    diagnostics = { provider: NAME, state: "requesting", lastAttemptAt: attemptedAt, lastRecordCount: 0 };
    try {
      const response = await fetch(`${base()}/fixtures/date/${encodeURIComponent(query.dateFromUtc)}`, {
        headers: { "X-Api-Key": apiKey, Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: signal ?? AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        const state = response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "auth_error" : "http_error";
        diagnostics = { provider: NAME, state, lastAttemptAt: attemptedAt, lastHttpStatus: response.status, lastRecordCount: 0, lastErrorCode: `http_${response.status}` };
        return [];
      }
      const payload = await response.json() as any;
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.fixtures) ? payload.fixtures : null;
      if (!rows) { diagnostics = { provider: NAME, state: "schema_error", lastAttemptAt: attemptedAt, lastHttpStatus: response.status, lastRecordCount: 0, lastErrorCode: "fixture_array_missing" }; return []; }
      const observedAt = new Date().toISOString();
      const mapped = rows.map((row: unknown) => mapSportApiAiFixture(row, observedAt)).filter((row: ProviderFixtureCandidate | null): row is ProviderFixtureCandidate => row !== null);
      diagnostics = { provider: NAME, state: mapped.length ? "success" : rows.length ? "partial" : "success_empty", lastAttemptAt: attemptedAt, lastSuccessAt: observedAt, lastHttpStatus: response.status, lastRecordCount: mapped.length, ...(rows.length !== mapped.length ? { lastErrorCode: "some_fixture_records_rejected" } : {}) };
      return mapped.filter((f: ProviderFixtureCandidate) => !query.competitionIds?.length || query.competitionIds.includes(f.competition.providerCompetitionId));
    } catch (error) {
      diagnostics = { provider: NAME, state: "request_error", lastAttemptAt: attemptedAt, lastRecordCount: 0, lastErrorCode: error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "network_or_parse_error" };
      return [];
    }
  }
}
