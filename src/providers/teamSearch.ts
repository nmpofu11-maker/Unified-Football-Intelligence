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
        errorCode === "provider_auth_error" ? "auth_error" : "schema_error";
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
        // Match the credential transport used by the fixture adapter and supported
        // across Sportmonks v3 deployments. Keep the Authorization header for
        // deployments that also accept it; never log or expose either credential.
        url.searchParams.set("api_token", sportmonksKey);
        return requestSearch("sportmonks", url, { Authorization: sportmonksKey }, candidatesFromSportmonks, signal, fetchImpl);
      })()
    : Promise.resolve<TeamSearchProviderResult>({ provider: "sportmonks", state: "unavailable", candidates: [], errorCode: "credential_not_configured" });
  return Promise.all([apiResult, sportmonksResult]);
}
