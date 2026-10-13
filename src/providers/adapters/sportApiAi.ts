import type { FixtureQuery, ProviderDiagnostics, ProviderFixtureCandidate } from "../provider.js";
import type { FootballDataProvider } from "../provider.js";

const NAME = "sportapi-ai";
const EMPTY_DIAGNOSTICS: ProviderDiagnostics = { provider: NAME, state: "idle", lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0 };
let diagnostics: ProviderDiagnostics = { ...EMPTY_DIAGNOSTICS };
const key = () => (process.env.SPORTAPI_AI_KEY || process.env.SPORTAPI_API_KEY || "").trim();
const base = () => (process.env.SPORTAPI_AI_BASE_URL || "https://sportapi.ai/api").replace(/\/+$/, "");

function utc(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return null;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function statusMap(value: unknown): ProviderFixtureCandidate["status"] {
  const s = String(value ?? "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["scheduled", "not_started", "ns", "upcoming", "fixture"].includes(s)) return "scheduled";
  if (["live", "in_play", "1h", "2h", "ht", "in_progress", "half_time"].includes(s)) return "live";
  if (["finished", "ft", "aet", "pen", "final", "completed", "ended", "full_time"].includes(s)) return "finished";
  if (s.includes("postpon")) return "postponed";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("abandon")) return "abandoned";
  return "unknown";
}
const obj = (v: unknown): Record<string, any> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;
const first = (...values: unknown[]) => values.find(v => v !== undefined && v !== null && String(v).trim() !== "");
const idOf = (v: unknown): unknown => {
  const o = obj(v);
  return o ? first(o.id, o.fixture_id, o.fixtureId, o.team_id, o.teamId, o.competition_id, o.competitionId) : v;
};
const nameOf = (v: unknown): unknown => {
  const o = obj(v);
  return o ? first(o.name, o.title, o.display_name, o.displayName, o.short_name, o.shortName) : v;
};
function envelope(payload: unknown): { rows: unknown[] | null; topLevelKeys: string[] } {
  if (Array.isArray(payload)) return { rows: payload, topLevelKeys: ["<array>"] };
  const root = obj(payload);
  if (!root) return { rows: null, topLevelKeys: [] };
  const data = obj(root.data);
  const rows = Array.isArray(root.fixtures) ? root.fixtures
    : Array.isArray(root.records) ? root.records
    : Array.isArray(data?.fixtures) ? data!.fixtures
    : Array.isArray(data?.records) ? data!.records
    : Array.isArray(root.data) ? root.data
    : null;
  return { rows, topLevelKeys: Object.keys(root).sort().slice(0, 30) };
}
export function mapSportApiAiFixture(raw: unknown, observedAt = new Date().toISOString()): ProviderFixtureCandidate | null {
  const f = obj(raw);
  if (!f) return null;
  const fixture = obj(f.fixture);
  const teams = obj(f.teams);
  const home = obj(first(f.home_team, f.homeTeam, f.home, teams?.home, fixture?.home_team));
  const away = obj(first(f.away_team, f.awayTeam, f.away, teams?.away, fixture?.away_team));
  const leagueRaw = first(f.league, f.competition, f.tournament, f.competition_name);
  const league = obj(leagueRaw);
  const fixtureId = first(f.id, f.fixture_id, f.fixtureId, fixture?.id);
  const homeId = first(home?.id, home?.team_id, home?.teamId, f.home_team_id);
  const awayId = first(away?.id, away?.team_id, away?.teamId, f.away_team_id);
  const homeName = first(home?.name, home?.team_name, home?.teamName, typeof f.home_team === "string" ? f.home_team : undefined, typeof f.homeTeam === "string" ? f.homeTeam : undefined, typeof f.home === "string" ? f.home : undefined);
  const awayName = first(away?.name, away?.team_name, away?.teamName, typeof f.away_team === "string" ? f.away_team : undefined, typeof f.awayTeam === "string" ? f.awayTeam : undefined, typeof f.away === "string" ? f.away : undefined);
  const leagueId = first(league?.id, league?.league_id, league?.competition_id, f.league_id, f.competition_id, f.tournament_id);
  const leagueName = first(typeof leagueRaw === "string" ? leagueRaw : undefined, league?.name, league?.title, f.league_name, f.competition_name, f.tournament_name);
  const kickoff = utc(first(f.kickoff_utc, f.kickoffUtc, f.kickoff_time_utc, f.datetime, f.kickoff, f.kickoffAt, fixture?.kickoff, fixture?.date, f.date));
  if (fixtureId == null || !String(fixtureId).trim() ||
      !String(homeName ?? "").trim() || !String(awayName ?? "").trim() ||
      !String(leagueName ?? "").trim() || !kickoff) return null;
  const rawStatus = String(first(obj(f.status)?.short, obj(f.status)?.name, f.status, f.state, "unknown"));
  const status = statusMap(rawStatus);
  const score = obj(f.score);
  const homeScore = first(score?.home, f.home_score, obj(f.scores)?.home, home?.score);
  const awayScore = first(score?.away, f.away_score, obj(f.scores)?.away, away?.score);
  const hasScore = status === "finished" && Number.isInteger(homeScore) && Number(homeScore) >= 0 && Number.isInteger(awayScore) && Number(awayScore) >= 0;
  const season = obj(f.season);
  return {
    provider: NAME, providerFixtureId: String(fixtureId).trim(), kickoffUtc: kickoff,
    home: { ...(homeId != null ? { providerTeamId: String(homeId) } : {}), name: String(homeName).trim() },
    away: { ...(awayId != null ? { providerTeamId: String(awayId) } : {}), name: String(awayName).trim() },
    competition: { ...(leagueId != null ? { providerCompetitionId: String(leagueId) } : {}), name: String(leagueName).trim() },
    ...(season?.id != null || f.season_id != null ? { providerSeasonId: String(season?.id ?? f.season_id) } : {}),
    status, observedAt, evidenceState: "unverified", rawStatus,
    ...(hasScore ? { score: { home: Number(homeScore), away: Number(awayScore) } } : {}),
    provenance: { provider: NAME, providerRecordId: String(fixtureId).trim(), retrievedAt: observedAt, evidenceState: "unverified" }
  };
}
function rejectionReason(raw: unknown): string {
  const f = obj(raw);
  if (!f) return "malformed_record";
  const fixture = obj(f.fixture);
  if (first(f.id, f.fixture_id, f.fixtureId, fixture?.id) == null) return "missing_fixture_id";
  const teams = obj(f.teams);
  const home = obj(first(f.home_team, f.homeTeam, f.home, teams?.home, fixture?.home_team));
  const away = obj(first(f.away_team, f.awayTeam, f.away, teams?.away, fixture?.away_team));
  const homeName = first(home?.name, home?.team_name, home?.teamName, typeof f.home_team === "string" ? f.home_team : undefined, typeof f.homeTeam === "string" ? f.homeTeam : undefined, typeof f.home === "string" ? f.home : undefined);
  const awayName = first(away?.name, away?.team_name, away?.teamName, typeof f.away_team === "string" ? f.away_team : undefined, typeof f.awayTeam === "string" ? f.awayTeam : undefined, typeof f.away === "string" ? f.away : undefined);
  if (!homeName || !awayName) return "missing_team";
  const leagueRaw = first(f.league, f.competition, f.tournament, f.competition_name);
  const league = obj(leagueRaw);
  if (!first(typeof leagueRaw === "string" ? leagueRaw : undefined, league?.name, league?.title, f.league_name, f.competition_name, f.tournament_name)) return "missing_competition";
  if (!utc(first(f.kickoff_utc, f.kickoffUtc, f.kickoff_time_utc, f.kickoff, f.kickoffAt, f.datetime, f.date, fixture?.date, fixture?.kickoff))) return "invalid_kickoff";
  return "malformed_record";
}
export class SportApiAiProvider implements FootballDataProvider {
  readonly name = NAME;
  diagnostics() { return { ...diagnostics, ...(diagnostics.lastRejectionReasons ? { lastRejectionReasons: { ...diagnostics.lastRejectionReasons } } : {}), ...(diagnostics.lastResponseShape ? { lastResponseShape: { ...diagnostics.lastResponseShape, topLevelKeys: [...diagnostics.lastResponseShape.topLevelKeys] } } : {}) }; }
  async fetchFixtures(query: FixtureQuery, signal?: AbortSignal): Promise<ProviderFixtureCandidate[]> {
    const apiKey = key();
    if (!apiKey) { diagnostics = { provider: NAME, state: "unavailable", lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0, lastErrorCode: "credential_not_configured" }; return []; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.dateFromUtc) || query.dateFromUtc !== query.dateToUtc || Number.isNaN(Date.parse(`${query.dateFromUtc}T00:00:00Z`)) || new Date(`${query.dateFromUtc}T00:00:00Z`).toISOString().slice(0, 10) !== query.dateFromUtc) {
      diagnostics = { provider: NAME, state: "schema_error", lastAttemptAt: new Date().toISOString(), lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0, lastErrorCode: "adapter_requires_single_utc_calendar_date" }; return [];
    }
    const attemptedAt = new Date().toISOString();
    diagnostics = { provider: NAME, state: "requesting", lastAttemptAt: attemptedAt, lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0 };
    try {
      // SportAPI's documented route is /fixtures/date/YYYY-MM-DD.
      // The previous /fixtures?date= route returns the API's generic welcome
      // envelope (HTTP 200), not fixture data.
      const url = new URL(`${base()}/fixtures/date/${encodeURIComponent(query.dateFromUtc)}`);
      const response = await fetch(url, {
        headers: { "X-Api-Key": apiKey, Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: signal ?? AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        const state = response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "auth_error" : "http_error";
        diagnostics = { provider: NAME, state, lastAttemptAt: attemptedAt, lastHttpStatus: response.status, lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0, lastErrorCode: `http_${response.status}` };
        return [];
      }
      const payload = await response.json() as unknown;
      const parsed = envelope(payload);
      if (!parsed.rows) {
        const root = obj(payload);
        const message = typeof root?.message === "string" ? root.message.replace(/\s+/g, " ").slice(0, 160) : undefined;
        let uriPath: string | undefined;
        if (typeof root?.uri === "string") {
          try { uriPath = new URL(root.uri, base()).pathname.slice(0, 200); } catch { /* Do not expose an unparseable provider URI. */ }
        }
        diagnostics = {
          provider: NAME, state: "schema_error", lastAttemptAt: attemptedAt, lastHttpStatus: response.status,
          lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0,
          lastResponseShape: { topLevelKeys: parsed.topLevelKeys, ...(message ? { message } : {}), ...(uriPath ? { uriPath } : {}) },
          lastErrorCode: message ? "provider_message_response" : "fixture_array_missing"
        };
        return [];
      }
      const observedAt = new Date().toISOString();
      const rejectionReasons: Record<string, number> = {};
      const mapped: ProviderFixtureCandidate[] = [];
      for (const row of parsed.rows) {
        const candidate = mapSportApiAiFixture(row, observedAt);
        if (candidate) mapped.push(candidate);
        else {
          const reason = rejectionReason(row);
          rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
        }
      }
      const filtered = mapped.filter(f => !query.competitionIds?.length || (f.competition.providerCompetitionId !== undefined && query.competitionIds.includes(f.competition.providerCompetitionId)));
      diagnostics = {
        provider: NAME, state: parsed.rows.length === 0 ? "success_empty" : filtered.length ? (filtered.length + Object.values(rejectionReasons).reduce((a, b) => a + b, 0) === parsed.rows.length ? "success" : "partial") : "partial",
        lastAttemptAt: attemptedAt, lastSuccessAt: observedAt, lastHttpStatus: response.status,
        lastRecordCount: parsed.rows.length, lastAcceptedCount: filtered.length,
        lastRejectedCount: Object.values(rejectionReasons).reduce((a, b) => a + b, 0),
        lastRejectionReasons: rejectionReasons, lastResponseShape: { topLevelKeys: parsed.topLevelKeys, rowCount: parsed.rows.length },
        ...(Object.keys(rejectionReasons).length ? { lastErrorCode: "some_fixture_records_rejected" } : {})
      };
      return filtered;
    } catch (error) {
      diagnostics = { provider: NAME, state: error instanceof Error && error.name === "TimeoutError" ? "request_error" : "request_error",
        lastAttemptAt: attemptedAt, lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0,
        lastErrorCode: error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "network_or_parse_error" };
      return [];
    }
  }
}
