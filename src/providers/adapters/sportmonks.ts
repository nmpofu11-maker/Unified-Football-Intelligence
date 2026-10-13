import type { FixtureQuery, ProviderDiagnostics, ProviderFixtureCandidate } from "../provider.js";
import type { FootballDataProvider } from "../provider.js";

const NAME = "sportmonks";
let diagnostics: ProviderDiagnostics = { provider: NAME, state: "idle", lastRecordCount: 0 };
const key = () => (process.env.SPORTMONKS_API_KEY || process.env.SPORTMONKS_API_TOKEN || "").trim();
const base = () => (process.env.SPORTMONKS_BASE_URL || "https://api.sportmonks.com/v3/football").replace(/\/+$/, "");

function parseKickoff(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : raw.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function statusMap(value: unknown): ProviderFixtureCandidate["status"] {
  const s = String(value ?? "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["ns", "scheduled", "not_started", "fixture", "upcoming"].includes(s)) return "scheduled";
  if (["live", "in_play", "1h", "2h", "ht", "in_progress"].includes(s)) return "live";
  if (["ft", "aet", "pen", "finished", "final", "full_time", "fulltime", "after_extra_time", "after_penalties"].includes(s)) return "finished";
  if (s.includes("postpon")) return "postponed";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("abandon")) return "abandoned";
  return "unknown";
}
function statusRaw(raw: any): string {
  const state = raw?.state?.data ?? raw?.state;
  return String(state?.short_name ?? state?.state ?? state?.name ?? raw?.status?.short ?? raw?.status?.name ?? raw?.status ?? "UNKNOWN");
}

export function mapSportmonksFixture(raw: unknown, observedAt = new Date().toISOString()): ProviderFixtureCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, any>;
  const id = f.id;
  const participants = f.participants?.data ?? f.participants;
  if (id == null || !Array.isArray(participants)) return null;
  const side = (p: any) => String(p?.meta?.location ?? p?.pivot?.location ?? p?.location ?? p?.side ?? "").trim().toLowerCase();
  const home = participants.find((p: any) => ["home", "1", "local"].includes(side(p)));
  const away = participants.find((p: any) => ["away", "2", "visitor"].includes(side(p)));
  const league = f.league?.data ?? f.league;
  const kickoff = parseKickoff(f.starting_at ?? f.startingAt);
  if (home?.id == null || away?.id == null || !String(home?.name ?? "").trim() || !String(away?.name ?? "").trim() || league?.id == null || !String(league?.name ?? "").trim() || !kickoff) return null;
  const rawStatus = statusRaw(f);
  const status = statusMap(rawStatus);
  const scores = f.scores?.data ?? f.scores;
  let homeGoals: number | undefined, awayGoals: number | undefined;
  if (Array.isArray(scores) && status === "finished") {
    for (const row of scores) {
      const desc = String(row?.description ?? "").toUpperCase();
      if (desc && !["CURRENT", "FT", "FULL_TIME", "FULLTIME"].includes(desc)) continue;
      const goalsRaw = row?.score?.goals ?? row?.goals;
      const goals = typeof goalsRaw === "number" ? goalsRaw : Number(goalsRaw);
      if (!Number.isInteger(goals) || goals < 0) continue;
      const participantId = String(row?.participant_id ?? row?.participant?.id ?? "");
      const rowSide = String(row?.score?.participant ?? row?.participant?.meta?.location ?? row?.meta?.location ?? "").toLowerCase();
      if (participantId === String(home.id) || rowSide === "home") homeGoals = goals;
      if (participantId === String(away.id) || rowSide === "away") awayGoals = goals;
    }
  }
  const hasScore = Number.isInteger(homeGoals) && Number.isInteger(awayGoals);
  return {
    provider: NAME, providerFixtureId: String(id), kickoffUtc: kickoff,
    home: { providerTeamId: String(home.id), name: String(home.name).trim() },
    away: { providerTeamId: String(away.id), name: String(away.name).trim() },
    competition: { providerCompetitionId: String(league.id), name: String(league.name).trim() },
    ...(f.season_id != null || f.season?.id != null ? { providerSeasonId: String(f.season_id ?? f.season.id) } : {}),
    status, observedAt, evidenceState: "unverified", rawStatus,
    ...(hasScore ? { score: { home: homeGoals!, away: awayGoals! } } : {}),
    provenance: { provider: NAME, providerRecordId: String(id), retrievedAt: observedAt, evidenceState: "unverified" }
  };
}

export class SportmonksProvider implements FootballDataProvider {
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

    type FetchBatch = { rows: unknown[]; status?: number; topLevelKeys: string[]; message?: string; partial: boolean; errorCode?: string; endpoint: "date" | "date_range" };
    const requestEndpoint = async (endpoint: "date" | "date_range"): Promise<FetchBatch> => {
      const rows: unknown[] = [];
      let status: number | undefined;
      let topLevelKeys: string[] = [];
      let message: string | undefined;
      let partial = false;
      for (let page = 1; page <= 5; page++) {
        const path = endpoint === "date"
          ? `/fixtures/date/${encodeURIComponent(query.dateFromUtc)}`
          : `/fixtures/between/${encodeURIComponent(query.dateFromUtc)}/${encodeURIComponent(query.dateToUtc)}`;
        const url = new URL(`${base()}${path}`);
        url.searchParams.set("include", "participants;scores;league;state;season");
        url.searchParams.set("timezone", "UTC");
        url.searchParams.set("per_page", "50");
        url.searchParams.set("api_token", apiKey);
        url.searchParams.set("page", String(page));
        const response = await fetch(url, { headers: { Authorization: apiKey, Accept: "application/json" }, signal: signal ?? AbortSignal.timeout(15_000) });
        status = response.status;
        if (!response.ok) {
          const errorCode = response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "auth_error" : `http_${response.status}`;
          return { rows, status, topLevelKeys, message, partial, endpoint, errorCode };
        }
        const payload = await response.json() as any;
        topLevelKeys = payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload).sort().slice(0, 30) : ["<non-object>"];
        message = typeof payload?.message === "string" ? payload.message.replace(/\s+/g, " ").slice(0, 160) : undefined;
        if (!Array.isArray(payload?.data)) return { rows, status, topLevelKeys, message, partial: true, endpoint, errorCode: "fixture_array_missing" };
        rows.push(...payload.data);
        const hasMore = payload?.pagination?.has_more === true || payload?.pagination?.hasMore === true || payload?.meta?.pagination?.has_more === true;
        if (!hasMore) break;
        if (page === 5) partial = true;
      }
      return { rows, status, topLevelKeys, message, partial, endpoint };
    };

    try {
      let batch = await requestEndpoint("date");
      let fallbackAttempted = false;
      // Try the documented date-range endpoint only after a successful, valid empty
      // date response. This preserves real HTTP/auth failures instead of masking them.
      if (batch.status !== undefined && batch.status >= 200 && batch.status < 300 &&
          batch.rows.length === 0 && !batch.errorCode && !batch.partial) {
        fallbackAttempted = true;
        const rangeBatch = await requestEndpoint("date_range");
        if (rangeBatch.status !== undefined && rangeBatch.status >= 200 && rangeBatch.status < 300 &&
            rangeBatch.rows.length > 0 && !rangeBatch.errorCode) {
          batch = rangeBatch;
        } else if (rangeBatch.errorCode) {
          batch = { ...rangeBatch, partial: true, errorCode: `date_range_fallback_${rangeBatch.errorCode}` };
        } else if (rangeBatch.rows.length === 0) {
          batch = { ...rangeBatch, errorCode: "empty_date_and_date_range_results" };
        } else {
          batch = rangeBatch;
        }
      }
      if (batch.errorCode === "auth_error" || batch.errorCode === "rate_limited") {
        diagnostics = { provider: NAME, state: batch.errorCode, lastAttemptAt: attemptedAt, lastHttpStatus: batch.status, lastRecordCount: 0, lastErrorCode: batch.errorCode };
        return [];
      }
      if (batch.errorCode?.startsWith("http_")) {
        diagnostics = { provider: NAME, state: "http_error", lastAttemptAt: attemptedAt, lastHttpStatus: batch.status, lastRecordCount: 0, lastErrorCode: batch.errorCode };
        return [];
      }
      const observedAt = new Date().toISOString();
      const mapped = batch.rows.map(row => mapSportmonksFixture(row, observedAt)).filter((row): row is ProviderFixtureCandidate => row !== null)
        .filter(f => !query.competitionIds?.length || (f.competition.providerCompetitionId !== undefined && query.competitionIds.includes(f.competition.providerCompetitionId)));
      diagnostics = {
        provider: NAME,
        state: batch.partial || batch.errorCode || mapped.length !== batch.rows.length ? "partial" : mapped.length ? "success" : "success_empty",
        lastAttemptAt: attemptedAt, lastSuccessAt: observedAt,
        ...(batch.status === undefined ? {} : { lastHttpStatus: batch.status }),
        lastRecordCount: batch.rows.length, lastAcceptedCount: mapped.length, lastRejectedCount: batch.rows.length - mapped.length,
        lastRejectionReasons: mapped.length !== batch.rows.length ? { fixture_mapping_or_filter_rejected: batch.rows.length - mapped.length } : {},
        lastResponseShape: { topLevelKeys: batch.topLevelKeys, rowCount: batch.rows.length,
          ...(batch.message ? { message: batch.message } : {}),
          uriPath: batch.endpoint === "date" ? "fixtures/date/{date}" : "fixtures/between/{start_date}/{end_date}" },
        ...(batch.errorCode ? { lastErrorCode: batch.errorCode } : batch.rows.length === 0 ? { lastErrorCode: fallbackAttempted ? "empty_date_and_date_range_results" : "empty_date_results" } : {})
      };
      return mapped;
    } catch (error) {
      diagnostics = { provider: NAME, state: "request_error", lastAttemptAt: attemptedAt, lastRecordCount: 0, lastErrorCode: error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "network_or_parse_error" };
      return [];
    }
  }
}
