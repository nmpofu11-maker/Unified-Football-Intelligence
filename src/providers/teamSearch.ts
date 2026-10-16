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
function candidatesFromApiFootball(payload: unknown): TeamSearchCandidate[] | null {
  const root = object(payload);
  if (!root || !Array.isArray(root.response)) return null;
  const rows: TeamSearchCandidate[] = [];
  for (const value of root.response) {
    const row = object(value);
    const team = object(row?.team);
    if (team?.id == null || !clean(team.name)) continue;
    rows.push({
      provider: "api-football",
      providerTeamId: String(team.id),
      name: clean(team.name)!,
      ...(clean(team.country) ? { country: clean(team.country) } : {}),
      ...(clean(team.gender) ? { gender: clean(team.gender) } : {}),
      ...(clean(team.code) ? { shortCode: clean(team.code) } : {})
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
    rows.push({
      provider: "sportmonks",
      providerTeamId: String(team.id),
      name: clean(team.name)!,
      ...(clean(country?.name) ? { country: clean(country?.name) } : {}),
      ...(clean(team.gender) ? { gender: clean(team.gender) } : {}),
      ...(clean(team.type) ? { teamType: clean(team.type) } : {}),
      ...(clean(team.short_code) ? { shortCode: clean(team.short_code) } : {})
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
    if (Array.isArray(providerErrors) && providerErrors.length > 0) {
      return { provider, state: "schema_error", candidates: [], errorCode: "provider_reported_error" };
    }
    if (providerErrors && typeof providerErrors === "object" && Object.keys(providerErrors).length > 0) {
      return { provider, state: "schema_error", candidates: [], errorCode: "provider_reported_error" };
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

/** Searches provider-native team catalogues. Results are discovery candidates only, never reviewed mappings. */
export async function searchTeamAcrossProviders(
  teamName: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<TeamSearchProviderResult[]> {
  const query = teamName.trim();
  if (!query || query.length > 120) {
    return [
      { provider: "api-football", state: "unavailable", candidates: [], errorCode: "invalid_team_name" },
      { provider: "sportmonks", state: "unavailable", candidates: [], errorCode: "invalid_team_name" }
    ];
  }
  const apiKey = (process.env.API_FOOTBALL_KEY ?? "").trim();
  const sportmonksKey = (process.env.SPORTMONKS_API_KEY ?? process.env.SPORTMONKS_API_TOKEN ?? "").trim();
  const apiBase = (process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io").replace(/\/+$/, "");
  const sportmonksBase = (process.env.SPORTMONKS_BASE_URL || "https://api.sportmonks.com/v3/football").replace(/\/+$/, "");
  const apiResult = apiKey
    ? (() => {
        const url = new URL(`${apiBase}/teams`);
        url.searchParams.set("search", query);
        return requestSearch("api-football", url, { "x-apisports-key": apiKey }, candidatesFromApiFootball, signal, fetchImpl);
      })()
    : Promise.resolve<TeamSearchProviderResult>({ provider: "api-football", state: "unavailable", candidates: [], errorCode: "credential_not_configured" });
  const sportmonksResult = sportmonksKey
    ? (() => {
        const url = new URL(`${sportmonksBase}/teams/search/${encodeURIComponent(query)}`);
        url.searchParams.set("include", "country");
        url.searchParams.set("per_page", "50");
        url.searchParams.set("page", "1");
        return requestSearch("sportmonks", url, { Authorization: sportmonksKey }, candidatesFromSportmonks, signal, fetchImpl);
      })()
    : Promise.resolve<TeamSearchProviderResult>({ provider: "sportmonks", state: "unavailable", candidates: [], errorCode: "credential_not_configured" });
  return Promise.all([apiResult, sportmonksResult]);
}
