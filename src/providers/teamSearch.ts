export interface TeamSearchCandidate {
  provider: "api-football" | "sportmonks";
  providerTeamId: string;
  name: string;
  country?: string;
  gender?: string;
  teamType?: string;
  shortCode?: string;
}
export interface TeamSearchProviderResult {
  provider: "api-football" | "sportmonks";
  state: "success" | "success_empty" | "unavailable" | "rate_limited" | "auth_error" | "http_error" | "request_error" | "schema_error";
  candidates: TeamSearchCandidate[];
  errorCode?: string;
}
const object = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const clean = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function stateForStatus(status: number): TeamSearchProviderResult["state"] {
  if (status === 429) return "rate_limited";
  if ([401, 403].includes(status)) return "auth_error";
  return "http_error";
}

// Provider error bodies are deliberately reduced to stable, non-sensitive categories.
// Never persist or return the raw provider message because it may contain account details.
function providerErrorCode(payload: unknown): string {
  const root = object(payload);
  const errors = root?.errors;
  const values = Array.isArray(errors) ? errors : errors && typeof errors === "object" ? Object.values(errors) : [];
  const summary = values.map(value => typeof value === "string" ? value : JSON.stringify(value))
    .join(" ").toLowerCase();
  if (/rate.?limit|too many requests|requests per minute/.test(summary)) return "provider_rate_limited";
  if (/invalid api.?key|api.?key.*invalid|invalid token|unauthori[sz]ed|authentication|access token/.test(summary)) return "provider_auth_error";
  if (/subscription|plan|not available on your plan|not allowed|access to this endpoint|endpoint.*access/.test(summary)) return "provider_plan_or_access_restriction";
  if (/parameter|query.*invalid|invalid.*search|missing.*parameter/.test(summary)) return "provider_invalid_request";
  return "provider_reported_error";
}
function candidatesFromApiFootball(payload: unknown): TeamSearchCandidate[] | null {
  const root = object(payload);
  if (!root || !Array.isArray(root.response)) return null;
  const rows: TeamSearchCandidate[] = [];
  for (const value of root.response) {
    const row = object(value);
    const team = object(row?.team);
    if (team?.id == null || !clean(team.name)) continue;
    const name = clean(team.name);
    const countryName = clean(team.country);
    const gender = clean(team.gender);
    const shortCode = clean(team.code);
    if (!name) continue;
    rows.push({
      provider: "api-football",
      providerTeamId: String(team.id),
      name,
      ...(countryName ? { country: countryName } : {}),
      ...(gender ? { gender } : {}),
      ...(shortCode ? { shortCode } : {})
    });
  }
  return rows;
}
function candidatesFromSportmonks(payload: unknown): TeamSearchCandidate[] | null {
  const root = object(payload);
  if (!root || !Array.isArray(root.data)) return null;
  const rows: TeamSearchCandidate[] = [];
  for (const value of root.data) {
    const team = object(value);
    if (team?.id == null || !clean(team.name)) continue;
    const country = object(team.country);
    const name = clean(team.name);
    const countryName = clean(country?.name);
    const gender = clean(team.gender);
    const teamType = clean(team.type);
    const shortCode = clean(team.short_code);
    if (!name) continue;
    rows.push({
      provider: "sportmonks",
      providerTeamId: String(team.id),
      name,
      ...(countryName ? { country: countryName } : {}),
      ...(gender ? { gender } : {}),
      ...(teamType ? { teamType } : {}),
      ...(shortCode ? { shortCode } : {})
    });
  }
  return rows;
}
async function requestSearch(
  provider: TeamSearchProviderResult["provider"],
  url: URL,
  headers: Record<string, string>,
  parse: (payload: unknown) => TeamSearchCandidate[] | null,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<TeamSearchProviderResult> {
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: signal ?? AbortSignal.timeout(12_000) });
    if (!response.ok) return { provider, state: stateForStatus(response.status), candidates: [], errorCode: `http_${response.status}` };
    let payload: unknown;
    try { payload = await response.json(); } catch { return { provider, state: "schema_error", candidates: [], errorCode: "invalid_json" }; }
    const root = object(payload);
    const providerErrors = root?.errors;
    const hasProviderErrors = Array.isArray(providerErrors)
      ? providerErrors.length > 0
      : Boolean(providerErrors && typeof providerErrors === "object" && Object.values(providerErrors).some(value =>
          value != null && value !== "" && value !== false && !(Array.isArray(value) && value.length === 0)
        ));
    if (hasProviderErrors) {
      const errorCode = providerErrorCode(payload);
      const state: TeamSearchProviderResult["state"] =
        errorCode === "provider_rate_limited" ? "rate_limited" :
        errorCode === "provider_auth_error" ? "auth_error" : "http_error";
      return { provider, state, candidates: [], errorCode };
    }
    const candidates = parse(payload);
    if (!candidates) return { provider, state: "schema_error", candidates: [], errorCode: "unexpected_response_shape" };
    return { provider, state: candidates.length ? "success" : "success_empty", candidates };
  } catch (error) {
    return {
      provider, state: "request_error", candidates: [],
      errorCode: error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "network_request_failed"
    };
  }
}

function normaliseSearchName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/**
 * Searches provider-native team catalogues. Curated aliases are attempted only
 * when the canonical query produces no exact-name candidate. Squad qualifiers
 * are never removed or guessed.
 */
export async function searchTeamAcrossProviders(
  teamName: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  fallbackQueries: string[] = []
): Promise<TeamSearchProviderResult[]> {
  const query = teamName.trim();
  if (!query || query.length > 120) {
    return [
      { provider: "api-football", state: "unavailable", candidates: [], errorCode: "invalid_team_name" },
      { provider: "sportmonks", state: "unavailable", candidates: [], errorCode: "invalid_team_name" }
    ];
  }

  const queries = [...new Set([
    query,
    ...fallbackQueries
      .filter(value => typeof value === "string")
      .map(value => value.trim())
      .filter(value => value.length > 0 && value.length <= 120)
  ])].slice(0, 3);
  const acceptableNames = new Set(queries.map(normaliseSearchName));
  const apiKey = (process.env.API_FOOTBALL_KEY ?? "").trim();
  const sportmonksKey = (process.env.SPORTMONKS_API_KEY ?? process.env.SPORTMONKS_API_TOKEN ?? "").trim();
  const apiBase = (process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io").replace(/\/+$/, "");
  const sportmonksBase = (process.env.SPORTMONKS_BASE_URL || "https://api.sportmonks.com/v3/football").replace(/\/+$/, "");

  const searchProvider = async (
    provider: TeamSearchProviderResult["provider"],
    key: string,
    buildUrl: (searchQuery: string) => URL,
    headers: Record<string, string>,
    parse: (payload: unknown) => TeamSearchCandidate[] | null
  ): Promise<TeamSearchProviderResult> => {
    if (!key) {
      return { provider, state: "unavailable", candidates: [], errorCode: "credential_not_configured" };
    }

    const collected = new Map<string, TeamSearchCandidate>();
    for (const [index, searchQuery] of queries.entries()) {
      const result = await requestSearch(provider, buildUrl(searchQuery), headers, parse, signal, fetchImpl);
      if (result.state !== "success" && result.state !== "success_empty") {
        return { ...result, candidates: [...collected.values(), ...result.candidates] };
      }
      for (const candidate of result.candidates) {
        const existing = collected.get(candidate.providerTeamId);
        if (!existing || (!existing.country && candidate.country)) {
          collected.set(candidate.providerTeamId, candidate);
        }
      }
      // Only an exact canonical/curated-name candidate ends the search early.
      if (result.candidates.some(candidate => acceptableNames.has(normaliseSearchName(candidate.name)))) {
        return { provider, state: "success", candidates: [...collected.values()] };
      }
      if (index === queries.length - 1) {
        const candidates = [...collected.values()];
        return candidates.length
          ? { provider, state: "success", candidates }
          : { provider, state: "success_empty", candidates: [], errorCode: "team_search_strategy_v1_exhausted" };
      }
    }
    return { provider, state: "success_empty", candidates: [], errorCode: "team_search_strategy_v1_exhausted" };
  };

  const apiResult = searchProvider(
    "api-football",
    apiKey,
    searchQuery => {
      const url = new URL(apiBase + "/teams");
      url.searchParams.set("search", searchQuery);
      return url;
    },
    { "x-apisports-key": apiKey },
    candidatesFromApiFootball
  );
  const sportmonksResult = searchProvider(
    "sportmonks",
    sportmonksKey,
    searchQuery => {
      const url = new URL(sportmonksBase + "/teams/search/" + encodeURIComponent(searchQuery));
      url.searchParams.set("include", "country");
      url.searchParams.set("per_page", "50");
      url.searchParams.set("page", "1");
      // Sportmonks accepts the token in either a query parameter or Authorization
      // header. Keep both transports for deployment compatibility; never log either.
      url.searchParams.set("api_token", sportmonksKey);
      return url;
    },
    { Authorization: sportmonksKey },
    candidatesFromSportmonks
  );
  return Promise.all([apiResult, sportmonksResult]);
}
