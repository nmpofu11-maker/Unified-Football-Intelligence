import { pathToFileURL } from "node:url";

export interface LiveEndpointResult {
  path: string;
  httpStatus: number | null;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface LiveVerificationReport {
  generatedAt: string;
  host: string;
  overall: "FAIL" | "WARN" | "PASS";
  evidencePipelineReady: boolean;
  bettingRecommendationsEnabled: false;
  endpoints: LiveEndpointResult[];
  checks: Array<{ name: string; state: "pass" | "warn" | "fail"; detail: string }>;
  nextActions: string[];
}

const ENDPOINTS = [
  "/health",
  "/api/storage/status",
  "/api/storage/observations/summary",
  "/api/data-pipeline/status",
  "/api/predictions/status",
  "/api/history/status",
  "/api/teams/watchlist"
] as const;

type JsonObject = Record<string, unknown>;
const record = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const nested = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((current, key) => record(current)[key], value);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const state = (value: unknown): string => typeof value === "string" ? value : "unknown";

export function evaluateLiveVerification(host: string, endpoints: LiveEndpointResult[]): LiveVerificationReport {
  const byPath = new Map(endpoints.map(endpoint => [endpoint.path, endpoint]));
  const checks: LiveVerificationReport["checks"] = [];
  const nextActions: string[] = [];
  const check = (name: string, passed: boolean, detail: string, blocker: boolean, action: string) => {
    checks.push({ name, state: passed ? "pass" : blocker ? "fail" : "warn", detail });
    if (!passed && action) nextActions.push(action);
  };

  for (const path of ENDPOINTS) {
    const result = byPath.get(path);
    check(`endpoint:${path}`, Boolean(result?.ok), result?.ok ? `HTTP ${result.httpStatus}` : result?.error ?? `HTTP ${result?.httpStatus ?? "unavailable"}`, true, `Restore read access to ${path} and rerun this report.`);
  }

  const health = record(byPath.get("/health")?.data);
  const storage = record(byPath.get("/api/storage/status")?.data);
  const observations = record(byPath.get("/api/storage/observations/summary")?.data);
  const pipeline = record(byPath.get("/api/data-pipeline/status")?.data);
  const predictions = record(byPath.get("/api/predictions/status")?.data);
  const history = record(byPath.get("/api/history/status")?.data);
  const watchlist = record(byPath.get("/api/teams/watchlist")?.data);
  const stages = record(pipeline.stages);

  check("database-storage", storage.state === "ready" && nested(health, "readiness", "database") === true,
    `storage=${state(storage.state)}, health.database=${String(nested(health, "readiness", "database"))}`, true,
    "Configure and verify the persistent PostgreSQL connection; do not continue provider replay until storage is ready.");
  const observationCount = count(observations.totalObservations);
  check("durable-observations", observations.state === "ready" && observationCount !== null && observationCount > 0,
    `state=${state(observations.state)}, totalObservations=${observationCount === null ? "unknown" : observationCount}`, false,
    "Run one authorized provider check, then confirm valid raw observations are persisted and survive redeploy.");
  const providerStage = record(stages.providers);
  check("recent-provider-success", state(providerStage.state) === "recent_success",
    `provider stage=${state(providerStage.state)}`, false,
    "Inspect each provider's sanitized status and run one provider check; respect rate limits and credentials.");
  const fixtureStage = record(stages.canonicalFixtures);
  const fixtureCount = count(fixtureStage.corroboratedCount);
  check("corroborated-fixtures", fixtureStage.state === "available" && fixtureCount !== null && fixtureCount > 0,
    `state=${state(fixtureStage.state)}, count=${fixtureCount === null ? "unknown" : fixtureCount}`, false,
    "Resolve reviewed provider team IDs and replay stored observations; do not infer identity from names alone.");
  const resultStage = record(stages.verifiedResults);
  const resultCount = count(resultStage.count);
  check("verified-settled-results", resultStage.state === "available" && resultCount !== null && resultCount > 0,
    `state=${state(resultStage.state)}, count=${resultCount === null ? "unknown" : resultCount}`, false,
    "Backfill and reconcile historical results; only corroborated finished fixtures with matching scores count.");
  const mappingStage = record(stages.reviewedTeamMappings);
  const mappingCount = count(mappingStage.count);
  check("reviewed-team-mappings", mappingStage.state === "ready" && mappingCount !== null && mappingCount > 0,
    `state=${state(mappingStage.state)}, count=${mappingCount === null ? "unknown" : mappingCount}`, false,
    "Review exact provider IDs and country/squad context. Keep unresolved or ambiguous favourites unmapped.");
  check("prediction-storage", predictions.state === "ready" && predictions.teamMappingsState === "ready",
    `prediction storage=${state(predictions.state)}, team mappings=${state(predictions.teamMappingsState)}`, true,
    "Resolve prediction-storage or reviewed-mapping errors before testing forecasts.");
  const watchlistCount = count(watchlist.count);
  const watchlistLength = Array.isArray(watchlist.teams) ? watchlist.teams.length : null;
  check("authoritative-watchlist", watchlistCount === 80 && watchlistLength === 80,
    `declared count=${watchlistCount === null ? "unknown" : watchlistCount}, returned entries=${watchlistLength ?? "unknown"}`, true,
    "Restore the complete user-confirmed 80-team watchlist before any discovery run; never replace it with provider-ranked teams.");
  check("betting-safety-gate", predictions.calibratedForBetting === false && predictions.bettingRecommendationsEnabled === false,
    `calibratedForBetting=${String(predictions.calibratedForBetting)}, bettingRecommendationsEnabled=${String(predictions.bettingRecommendationsEnabled)}`, true,
    "Keep betting recommendations disabled until genuine chronological out-of-sample calibration is independently established.");

  const hardFailure = checks.some(item => item.state === "fail");
  const evidencePipelineReady = !hardFailure && checks.every(item => item.state === "pass" || item.name === "betting-safety-gate") &&
    predictions.calibratedForBetting === false && predictions.bettingRecommendationsEnabled === false;
  const hasWarnings = checks.some(item => item.state === "warn");
  const overall = hardFailure ? "FAIL" : hasWarnings || !evidencePipelineReady ? "WARN" : "PASS";
  return {
    generatedAt: new Date().toISOString(),
    host,
    overall,
    evidencePipelineReady,
    bettingRecommendationsEnabled: false,
    endpoints,
    checks,
    nextActions: [...new Set(nextActions)]
  };
}

export async function fetchLiveEndpoints(host: string, fetchImpl: typeof fetch = fetch): Promise<LiveEndpointResult[]> {
  const base = new URL(host);
  if (base.username || base.password || base.search || base.hash) throw new Error("Host must not contain credentials, query parameters or fragments.");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname))) {
    throw new Error("Use HTTPS for deployed hosts; HTTP is permitted only for localhost.");
  }
  base.pathname = "/";
  const origin = base.origin;
  return Promise.all(ENDPOINTS.map(async path => {
    try {
      const response = await fetchImpl(new URL(path, origin), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        redirect: "error"
      });
      const text = await response.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch {
        return { path, httpStatus: response.status, ok: false, error: "response_not_json" };
      }
      return { path, httpStatus: response.status, ok: response.ok, data, ...(!response.ok ? { error: `http_${response.status}` } : {}) };
    } catch (error) {
      const code = error && typeof error === "object" && "name" in error ? String((error as {name:unknown}).name) : "request_failed";
      return { path, httpStatus: null, ok: false, error: code };
    }
  }));
}

async function main(): Promise<void> {
  const host = process.argv[2];
  if (!host) {
    console.error("Usage: npm run verify:live -- https://your-deployed-host");
    process.exitCode = 2;
    return;
  }
  let report: LiveVerificationReport;
  try {
    const endpoints = await fetchLiveEndpoints(host);
    report = evaluateLiveVerification(new URL(host).origin, endpoints);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid deployment host.");
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.overall !== "PASS") process.exitCode = 1;
  console.error("Safety note: this read-only check never enables betting recommendations. CI success is not production verification.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
