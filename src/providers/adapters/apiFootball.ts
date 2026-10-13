import type { FixtureQuery, ProviderDiagnostics, ProviderFixtureCandidate } from "../provider.js";
import type { FootballDataProvider } from "../provider.js";

const NAME = "api-football";
let diagnostics: ProviderDiagnostics = { provider: NAME, state: "idle", lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0 };
const key = () => (process.env.API_FOOTBALL_KEY || "").trim();
const base = () => (process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io").replace(/\/+$/, "");

const obj = (v: unknown): Record<string, any> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function statusMap(value: unknown): ProviderFixtureCandidate["status"] {
  const s = String(value ?? "unknown").trim().toUpperCase();
  if (["NS", "TBD"].includes(s)) return "scheduled";
  if (["1H", "2H", "HT", "ET", "BT", "P", "LIVE"].includes(s)) return "live";
  if (["FT", "AET", "PEN"].includes(s)) return "finished";
  if (["PST", "SUSP"].includes(s)) return "postponed";
  if (["CANC", "ABD", "AWD", "WO"].includes(s)) return s === "CANC" ? "cancelled" : s === "ABD" ? "abandoned" : "unknown";
  return "unknown";
}

export function mapApiFootballFixture(raw: unknown, observedAt = new Date().toISOString()): ProviderFixtureCandidate | null {
  const row = obj(raw);
  const fixture = obj(row?.fixture);
  const league = obj(row?.league);
  const teams = obj(row?.teams);
  const home = obj(teams?.home);
  const away = obj(teams?.away);
  const status = obj(fixture?.status);
  const kickoffRaw = fixture?.date;
  if (fixture?.id == null || !league?.id || !String(league?.name ?? "").trim() ||
      home?.id == null || !String(home?.name ?? "").trim() ||
      away?.id == null || !String(away?.name ?? "").trim() ||
      typeof kickoffRaw !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(kickoffRaw) ||
      !Number.isFinite(new Date(kickoffRaw).getTime())) return null;
  const rawStatus = String(status?.short ?? status?.long ?? "UNKNOWN");
  const mappedStatus = statusMap(rawStatus);
  const goals = obj(row?.goals);
  const homeGoals = goals?.home;
  const awayGoals = goals?.away;
  const hasScore = mappedStatus === "finished" && Number.isInteger(homeGoals) && homeGoals >= 0 &&
    Number.isInteger(awayGoals) && awayGoals >= 0;
  return {
    provider: NAME,
    providerFixtureId: String(fixture.id),
    kickoffUtc: new Date(kickoffRaw).toISOString(),
    home: { providerTeamId: String(home.id), name: String(home.name).trim() },
    away: { providerTeamId: String(away.id), name: String(away.name).trim() },
    competition: { providerCompetitionId: String(league.id), name: String(league.name).trim() },
    ...(league.season != null ? { providerSeasonId: String(league.season) } : {}),
    status: mappedStatus,
    observedAt,
    evidenceState: "unverified",
    rawStatus,
    ...(hasScore ? { score: { home: homeGoals as number, away: awayGoals as number } } : {}),
    provenance: { provider: NAME, providerRecordId: String(fixture.id), retrievedAt: observedAt, evidenceState: "unverified" }
  };
}

export class ApiFootballProvider implements FootballDataProvider {
  readonly name = NAME;
  diagnostics() {
    return {
      ...diagnostics,
      ...(diagnostics.lastRejectionReasons ? { lastRejectionReasons: { ...diagnostics.lastRejectionReasons } } : {}),
      ...(diagnostics.lastResponseShape ? { lastResponseShape: { ...diagnostics.lastResponseShape, topLevelKeys: [...diagnostics.lastResponseShape.topLevelKeys] } } : {})
    };
  }

  async fetchFixtures(query: FixtureQuery, signal?: AbortSignal): Promise<ProviderFixtureCandidate[]> {
    const apiKey = key();
    if (!apiKey) {
      diagnostics = { provider: NAME, state: "unavailable", lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0, lastErrorCode: "credential_not_configured" };
      return [];
    }
    if (!validDate(query.dateFromUtc) || query.dateFromUtc !== query.dateToUtc) {
      diagnostics = { provider: NAME, state: "schema_error", lastAttemptAt: new Date().toISOString(), lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0, lastErrorCode: "adapter_requires_single_utc_calendar_date" };
      return [];
    }
    const attemptedAt = new Date().toISOString();
    diagnostics = { provider: NAME, state: "requesting", lastAttemptAt: attemptedAt, lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0 };
    try {
      const url = new URL(`${base()}/fixtures`);
      url.searchParams.set("date", query.dateFromUtc);
      const response = await fetch(url, {
        headers: { "x-apisports-key": apiKey, Accept: "application/json" },
        signal: signal ?? AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        const state = response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "auth_error" : "http_error";
        diagnostics = { provider: NAME, state, lastAttemptAt: attemptedAt, lastHttpStatus: response.status, lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0, lastErrorCode: `http_${response.status}` };
        return [];
      }
      const payload = obj(await response.json());
      const rows = payload && Array.isArray(payload.response) ? payload.response : null;
      const topLevelKeys = payload ? Object.keys(payload).sort().slice(0, 30) : ["<non-object>"];
      const errorKeys = payload && payload.errors && typeof payload.errors === "object"
        ? Object.keys(payload.errors).filter(k => k.toLowerCase() !== "token").slice(0, 8) : [];
      if (errorKeys.length || (payload?.errors && Array.isArray(payload.errors) && payload.errors.length)) {
        diagnostics = {
          provider: NAME, state: "schema_error", lastAttemptAt: attemptedAt, lastHttpStatus: response.status,
          lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0,
          lastResponseShape: { topLevelKeys, ...(typeof payload?.results === "number" ? { rowCount: payload.results } : {}) },
          lastErrorCode: "provider_reported_error"
        };
        return [];
      }
      if (!rows) {
        diagnostics = { provider: NAME, state: "schema_error", lastAttemptAt: attemptedAt, lastHttpStatus: response.status, lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0, lastResponseShape: { topLevelKeys }, lastErrorCode: "fixture_array_missing" };
        return [];
      }
      const observedAt = new Date().toISOString();
      const mapped = rows.map(row => mapApiFootballFixture(row, observedAt)).filter((row): row is ProviderFixtureCandidate => row !== null);
      const rejected = rows.length - mapped.length;
      diagnostics = {
        provider: NAME, state: rows.length === 0 ? "success_empty" : rejected ? (mapped.length ? "partial" : "schema_error") : "success",
        lastAttemptAt: attemptedAt, lastSuccessAt: observedAt, lastHttpStatus: response.status,
        lastRecordCount: rows.length, lastAcceptedCount: mapped.length, lastRejectedCount: rejected,
        lastResponseShape: { topLevelKeys, rowCount: rows.length },
        ...(rejected ? { lastErrorCode: "some_fixture_records_rejected" } : {})
      };
      return mapped.filter(f => !query.competitionIds?.length || (f.competition.providerCompetitionId !== undefined && query.competitionIds.includes(f.competition.providerCompetitionId)));
    } catch (error) {
      diagnostics = { provider: NAME, state: "request_error", lastAttemptAt: attemptedAt, lastRecordCount: 0, lastAcceptedCount: 0, lastRejectedCount: 0, lastErrorCode: error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "network_or_parse_error" };
      return [];
    }
  }
}
