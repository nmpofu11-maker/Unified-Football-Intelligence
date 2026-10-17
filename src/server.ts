import teamSeed from "./data/initial-tracked-teams.json" with { type: "json" };
import "dotenv/config";
import express, { type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { aggregateProviderStatus } from "./status/aggregate.js";
import type { ProviderDiagnostics } from "./providers/provider.js";
import { SportApiAiProvider } from "./providers/adapters/sportApiAi.js";
import { SportmonksProvider } from "./providers/adapters/sportmonks.js";
import { ApiFootballProvider } from "./providers/adapters/apiFootball.js";
import { previewCandidateReconciliation } from "./domain/reconcileCandidates.js";
import { curatedTeamSearchAliases, discoverTrackedTeamIdentities, reviewTeamSearchCandidates } from "./domain/teamIdentity.js";
import { searchTeamAcrossProviders } from "./providers/teamSearch.js";
import { getCanonicalEvidenceSummary, getObservationStoreStatus, getObservationStoreSummary, getStoredTeamIdentityDiscovery, getStoredTeamSearchReview, getStoredTeamIdentityMappings, reconcileStoredTeamSearchCandidates, persistCanonicalEvidence, persistProviderObservations, persistTeamSearchObservations, replayStoredProviderObservations } from "./storage/postgresObservations.js";
import { listReviewedTeamMappings, predictStoredFixture, predictionStorageStatus, saveReviewedTeamMapping } from "./prediction/pipeline.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const sportApiAiProvider = new SportApiAiProvider();
const sportmonksProvider = new SportmonksProvider();
const apiFootballProvider = new ApiFootballProvider();

const providerConfig = [
  { name: "sportapi-ai", env: "SPORTAPI_AI_KEY", alternateEnv: "SPORTAPI_API_KEY", priority: "primary", adapter: sportApiAiProvider },
  { name: "sportmonks", env: "SPORTMONKS_API_KEY", alternateEnv: "SPORTMONKS_API_TOKEN", priority: "primary", adapter: sportmonksProvider },
  { name: "therundown", env: "THERUNDOWN_KEY", priority: "secondary" },
  { name: "api-football", env: "API_FOOTBALL_KEY", priority: "optional", adapter: apiFootballProvider }
] as const;

const providerCache = new Map<string, { expiresAt: number; retrievedAt: string; payload: unknown }>();
const requestWindows = new Map<string, number[]>();
function safeTokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function providerStatus() {
  return providerConfig.map(p => {
    const adapter = "adapter" in p ? p.adapter : undefined;
    const diagnostics: ProviderDiagnostics = adapter?.diagnostics() ?? {
      provider: p.name, state: "unavailable", lastRecordCount: 0, lastErrorCode: "adapter_not_connected"
    };
    const credentialConfigured = Boolean(process.env[p.env]?.trim() || ("alternateEnv" in p && process.env[p.alternateEnv]?.trim()));
    return { name: p.name, priority: p.priority, credentialConfigured,
      integrationState: adapter ? "adapter_available" as const : "not_connected" as const, diagnostics };
  });
}

app.get("/health", (_req: Request, res: Response) => res.json({
  status: "ok", app: "Unified Football Intelligence", mode: "greenfield-foundation",
  databaseConfigured: Boolean(process.env.DATABASE_URL), providerAdaptersConnected: false,
  liveFixturesAvailable: false, calibratedPredictionsAvailable: false, bettingRecommendationsEnabled: false
}));

app.get("/api/status", (_req: Request, res: Response) => res.json({
  status: "foundation",
  message: "The domain validation and baseline model foundation exist; live ingestion, durable storage and calibration gates are not yet complete.",
  modules: {
    canonicalDomain: "implemented_initial_contracts",
    providerAdapters: "sportapi_ai_and_sportmonks_adapters_implemented_live_validation_pending",
    durableDatabase: process.env.DATABASE_URL ? "provider_observation_store_configured_connection_must_be_checked" : "not_configured",
    verifiedHistoricalEvidence: "not_loaded",
    poissonBaseline: "implemented_not_calibrated",
    immutablePredictionLedger: "not_implemented",
    bettingRecommendations: "disabled_until_evidence_and_calibration_gates_pass"
  }
}));

app.get("/api/storage/status", async (_req: Request, res: Response) => {
  const status = await getObservationStoreStatus();
  res.status(status.state === "error" ? 503 : 200).json(status);
});
app.get("/api/storage/observations/summary", async (_req: Request, res: Response) => {
  const summary = await getObservationStoreSummary();
  res.status(summary.state === "error" ? 503 : 200).json(summary);
});
app.get("/api/providers/status", (_req: Request, res: Response) => {
  const providers = providerStatus();
  res.json({ ...aggregateProviderStatus(providers.map(p => p.diagnostics)), providers });
});

app.get("/api/providers/fixtures", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const now = Date.now();
  const ip = req.ip || "unknown";
  const recent = (requestWindows.get(ip) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= 6) return res.status(429).json({ state: "rate_limited", reason: "provider_check_limit_6_per_minute" });
  recent.push(now); requestWindows.set(ip, recent);
  if (requestWindows.size > 1000) {
    for (const [knownIp, times] of requestWindows) {
      if (!times.some(t => now - t < 60_000)) requestWindows.delete(knownIp);
    }
  }

  const date = String(req.query?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    return res.status(400).json({ state: "invalid_request", reason: "date_must_be_YYYY_MM_DD" });
  }
  const cached = providerCache.get(date);
  if (cached && cached.expiresAt > now) return res.json({ ...(cached.payload as object), cache: "hit", cached: true, cachedAt: cached.retrievedAt });
  const query = { dateFromUtc: date, dateToUtc: date };
  const [sportApiAi, sportmonks, apiFootball] = await Promise.all([
    sportApiAiProvider.fetchFixtures(query), sportmonksProvider.fetchFixtures(query), apiFootballProvider.fetchFixtures(query)
  ]);
  const providers = providerStatus();
  const candidates = [...sportApiAi, ...sportmonks, ...apiFootball];
  const persistence = await persistProviderObservations(candidates);
  const canonicalEvidence = await persistCanonicalEvidence(candidates);
  const reconciliationPreview = previewCandidateReconciliation(candidates);
  const byStatus: Record<string, number> = {};
  for (const candidate of candidates) byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
  const payload = {
    state: "provider_ingestion_completed", date,
    canonicalFixturesCorroborated: canonicalEvidence.corroboratedFixtures,
    verifiedResultsCreatedOrConfirmed: canonicalEvidence.verifiedResults,
    conflictedGroups: canonicalEvidence.conflictedGroups,
    note: "Raw observations remain unverified. Canonical fixture evidence is stored separately and only cross-provider corroborated finished scores can enter the verified-result ledger. Single-source or conflicted evidence is never promoted.",
    persistence,
    canonicalEvidence,
    candidateCount: candidates.length,
    candidateCountsByProvider: { "sportapi-ai": sportApiAi.length, sportmonks: sportmonks.length, "api-football": apiFootball.length },
    candidateCountsByStatus: byStatus,
    reconciliationSummary: {
      groups: reconciliationPreview.length,
      corroborated: reconciliationPreview.filter(item => item.state === "corroborated").length,
      conflicted: reconciliationPreview.filter(item => item.state === "conflicted").length,
      singleSource: reconciliationPreview.filter(item => item.state === "single_source").length
    },
    reconciliationPreview: reconciliationPreview.slice(0, 20),
    teamIdentityDiscovery: await getStoredTeamIdentityDiscovery(teamSeed.teams).then(summary => ({
      ...summary,
      note: summary.state === "ready"
        ? "Discovery is derived from the latest durable provider observations. Only exact names/curated aliases observed across at least two providers are marked resolved; country, competition, and historical evidence are not inferred."
        : "Durable identity discovery requires configured PostgreSQL observation storage. No mappings are invented when storage is unavailable.",
      samples: summary.teams.filter(item => item.state !== "unresolved").slice(0, 20)
    })),
    sampleCandidates: candidates.slice(0, 8).map(candidate => ({
      provider: candidate.provider, providerFixtureId: candidate.providerFixtureId, kickoffUtc: candidate.kickoffUtc,
      home: candidate.home.name, away: candidate.away.name, competition: candidate.competition.name,
      status: candidate.status, ...(candidate.score ? { score: candidate.score } : {}), evidenceState: candidate.evidenceState
    })),
    providers
  };
  const retrievedAt = new Date().toISOString();
  if (persistence.state !== "error") providerCache.set(date, { expiresAt: now + 5 * 60_000, retrievedAt, payload });
  if (providerCache.size > 100) {
    const oldestKey = providerCache.keys().next().value;
    if (oldestKey) providerCache.delete(oldestKey);
  }
  return res.json({ ...payload, cache: "miss", cached: false, retrievedAt });
});


app.post("/api/history/replay", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const result = await replayStoredProviderObservations();
  return res.status(result.state === "error" ? 503 : 200).json({
    state: result.state,
    latestObservationsLoaded: result.latestObservationsLoaded,
    canonicalEvidence: result.canonicalEvidence,
    ...(result.reconciliationDiagnostics ? { reconciliationDiagnostics: result.reconciliationDiagnostics } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {})
  });
});


app.get("/api/teams/provider-search", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const now = Date.now();
  const ip = `team-search:${req.ip || "unknown"}`;
  const recent = (requestWindows.get(ip) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= 2) return res.status(429).json({ state: "rate_limited", reason: "team_search_limit_2_per_minute" });
  recent.push(now);
  requestWindows.set(ip, recent);

  const rawIds = String(req.query?.teamIds ?? "");
  const ids = [...new Set(rawIds.split(",").map(value => value.trim()).filter(Boolean))];
  const batchRaw = req.query?.batch == null ? "" : String(req.query.batch);
  let trackedTeams: typeof teamSeed.teams;
  if (ids.length && batchRaw) {
    return res.status(400).json({ state: "invalid_request", reason: "use_teamIds_or_batch_not_both" });
  }
  if (ids.length) {
    if (ids.length > 5) return res.status(400).json({ state: "invalid_request", reason: "maximum_five_teamIds_per_request" });
    trackedTeams = teamSeed.teams.filter(team => ids.includes(team.id));
    if (trackedTeams.length !== ids.length) {
      return res.status(400).json({ state: "invalid_request", reason: "unknown_team_id", acceptedTeamIds: trackedTeams.map(team => team.id) });
    }
  } else {
    if (!/^(0|[1-9]\\d*)$/.test(batchRaw)) return res.status(400).json({ state: "invalid_request", reason: "provide_teamIds_or_batch_index_starting_at_zero" });
    const batch = Number(batchRaw);
    const batchCount = Math.ceil(teamSeed.teams.length / 5);
    if (!Number.isSafeInteger(batch) || batch >= batchCount) {
      return res.status(400).json({ state: "invalid_request", reason: "batch_out_of_range", batchCount, validBatchRange: [0, batchCount - 1] });
    }
    trackedTeams = teamSeed.teams.slice(batch * 5, batch * 5 + 5);
  }
  const storageCheck = await getStoredTeamSearchReview(teamSeed.teams);
  if (storageCheck.state !== "ready") {
    return res.status(503).json({ state: storageCheck.state, reason: storageCheck.errorCode ?? "durable_team_search_storage_required" });
  }
  const results = await Promise.all(trackedTeams.map(async team => ({
    trackedTeamId: team.id,
    canonicalName: team.canonicalName,
    state: "discovery_only" as const,
    providers: await searchTeamAcrossProviders(team.canonicalName, undefined, undefined, curatedTeamSearchAliases(team))
  })));
  const persistence = await persistTeamSearchObservations(results);
  if (persistence.state !== "saved") {
    return res.status(503).json({ state: "persistence_failed", persistence, reason: "team_search_results_not_durably_saved" });
  }
  const identityMapping = persistence.state === "saved"
    ? await reconcileStoredTeamSearchCandidates(trackedTeams)
    : { state: persistence.state === "error" ? "error" as const : "not_configured" as const, trackedTeams: trackedTeams.length, confirmed: 0, ambiguous: 0, unresolved: trackedTeams.length, skippedIncompleteSearch: trackedTeams.length, mappings: [] };
  return res.json({
    state: "provider_team_search_completed",
    identityMapping,
    resultCount: results.length,
    batch: batchRaw ? Number(batchRaw) : null,
    nextBatch: batchRaw && Number(batchRaw) + 1 < Math.ceil(teamSeed.teams.length / 5) ? Number(batchRaw) + 1 : null,
    persistence,
    results,
    note: "Search results are stored as discovery observations. A mapping is confirmed only when one exact/curated-name candidate from each provider has matching country metadata. Ambiguous or incomplete cases remain unconfirmed. Search at most five favourite teams per request to protect provider quotas."
  });
});
app.post("/api/teams/provider-search/next-batch", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const now = Date.now();
  const ip = `team-search:${req.ip || "unknown"}`;
  const recent = (requestWindows.get(ip) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= 2) return res.status(429).json({ state: "rate_limited", reason: "team_search_limit_2_per_minute" });
  recent.push(now);
  requestWindows.set(ip, recent);

  const before = await getStoredTeamSearchReview(teamSeed.teams);
  if (before.state !== "ready") {
    return res.status(503).json({ state: before.state, reason: before.errorCode ?? "durable_team_search_storage_required" });
  }
  const isRetryable = (team: (typeof before.teams)[number]) =>
    team.state === "never_searched" ||
    team.providers.length < 2 ||
    team.providers.some(provider =>
      provider.state === "request_error" || provider.state === "rate_limited" ||
      (provider.state === "success_empty" && provider.errorCode !== "team_search_strategy_v1_exhausted") ||
      (provider.state === "schema_error" && provider.errorCode === "provider_reported_error") ||
      (provider.state === "http_error" && provider.errorCode?.startsWith("http_5"))
    );
  const neverSearchedIds = new Set(before.teams.filter(team => team.state === "never_searched").map(team => team.trackedTeamId));
  const retryableIds = new Set(before.teams.filter(team => team.state !== "never_searched" && isRetryable(team)).map(team => team.trackedTeamId));
  const orderedDueIds = new Set([
    ...teamSeed.teams.filter(team => neverSearchedIds.has(team.id)).map(team => team.id),
    ...teamSeed.teams.filter(team => retryableIds.has(team.id)).map(team => team.id)
  ]);
  const trackedTeams = teamSeed.teams.filter(team => orderedDueIds.has(team.id)).slice(0, 5);
  if (!trackedTeams.length) {
    return res.json({
      state: "team_search_batches_complete",
      progress: { trackedTeams: before.trackedTeams, searchedTeams: before.searchedTeams, candidateCount: before.candidateCount },
      retryableTeamsRemaining: 0,
      note: "Every favourite team has a persisted result from both providers or no safe automatic retry remains. Unresolved names require better provider coverage or additional verified context."
    });
  }
  const results = await Promise.all(trackedTeams.map(async team => ({
    trackedTeamId: team.id,
    canonicalName: team.canonicalName,
    state: "discovery_only" as const,
    providers: await searchTeamAcrossProviders(team.canonicalName, undefined, undefined, curatedTeamSearchAliases(team))
  })));
  const persistence = await persistTeamSearchObservations(results);
  if (persistence.state !== "saved") {
    return res.status(503).json({ state: "persistence_failed", persistence, reason: "team_search_results_not_durably_saved" });
  }
  const identityMapping = persistence.state === "saved"
    ? await reconcileStoredTeamSearchCandidates(trackedTeams)
    : { state: persistence.state === "error" ? "error" as const : "not_configured" as const, trackedTeams: trackedTeams.length, confirmed: 0, ambiguous: 0, unresolved: trackedTeams.length, skippedIncompleteSearch: trackedTeams.length, mappings: [] };
  const after = await getStoredTeamSearchReview(teamSeed.teams);
  const remaining = after.state === "ready" ? after.teams.filter(isRetryable).length : null;
  return res.json({
    state: "provider_team_search_batch_completed",
    processed: trackedTeams.map(team => ({ id: team.id, name: team.canonicalName })),
    progress: after.state === "ready"
      ? { trackedTeams: after.trackedTeams, searchedTeams: after.searchedTeams, candidateCount: after.candidateCount }
      : { trackedTeams: teamSeed.teams.length, searchedTeams: null, candidateCount: null },
    retryableTeamsRemaining: remaining,
    persistence,
    identityMapping,
    nextAction: remaining && remaining > 0 ? "Call POST /api/teams/provider-search/next-batch again after respecting provider quotas." : "Review /api/teams/watchlist and /api/teams/provider-search/results.",
    note: "Processes at most five favourite teams per request. Canonical searches may use one curated alias fallback when needed. Exact/country-corroborated identities may be confirmed; ambiguous or insufficiently supported identities remain unresolved. No historical results are inferred."
  });
});

app.get("/api/teams/provider-search/results", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const summary = await getStoredTeamSearchReview(teamSeed.teams);
  const providerCoverage = (["api-football", "sportmonks"] as const).map(provider => {
    const rows = summary.state === "ready"
      ? summary.teams.flatMap(team => team.providers.filter(item => item.provider === provider))
      : [];
    const stateCounts: Record<string, number> = {};
    for (const row of rows) stateCounts[row.state] = (stateCounts[row.state] ?? 0) + 1;
    return {
      provider,
      teamsWithSearchResults: rows.length,
      teamsWithCandidates: rows.filter(row => row.candidates.length > 0).length,
      candidateCount: rows.reduce((count, row) => count + row.candidates.length, 0),
      stateCounts
    };
  });
  return res.status(summary.state === "error" ? 503 : 200).json({
    ...summary,
    providerCoverage,
    candidateReview: summary.state === "ready"
      ? summary.teams.map(row => {
          const tracked = teamSeed.teams.find(team => team.id === row.trackedTeamId);
          return {
            trackedTeamId: row.trackedTeamId,
            canonicalName: row.canonicalName,
            country: tracked?.country,
            league: tracked?.league,
            teamCategory: tracked?.teamCategory,
            assessments: tracked ? reviewTeamSearchCandidates(tracked, row.providers) : [],
            note: "Context assessment only; a candidate is not a confirmed provider mapping or verified match history."
          };
        })
      : [],
    coverageInterpretation: {
      sportmonks: "A successful empty team search means this query returned no candidates; it does not prove the favourite team is invalid. Subscription/competition coverage must be checked separately using the provider's account league catalogue.",
      identity: "A unique candidate from one provider is retained as a candidate identity, not as a cross-provider-confirmed mapping.",
      historicalEvidence: "Team identity candidates do not establish verified historical results or permit calibrated predictions."
    },
    note: "Saved provider search candidates are for identity review only. They are not canonical mappings and do not establish verified historical evidence."
  });
});


app.post("/api/teams/provider-search/reconcile", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }

  // Reconcile the latest saved searches only. This endpoint intentionally makes no
  // calls to provider APIs, so it can safely migrate/re-evaluate existing discoveries.
  const identityMapping = await reconcileStoredTeamSearchCandidates(teamSeed.teams);
  const { state: reconciliationState, ...mappingDetails } = identityMapping;
  return res.status(reconciliationState === "saved" ? 200 : 503).json({
    state: reconciliationState === "saved"
      ? "saved_team_searches_reconciled"
      : reconciliationState,
    ...mappingDetails,
    providerRequestsMade: 0,
    note: "Reconciles the latest persisted provider-search observations for all favourite teams. It does not make provider API calls, invent missing identities, or mark a one-provider candidate as cross-provider confirmed."
  });
});


app.get("/api/teams/watchlist", async (_req: Request, res: Response) => {
  const [discovery, searchReview, identityMappings] = await Promise.all([
    getStoredTeamIdentityDiscovery(teamSeed.teams),
    getStoredTeamSearchReview(teamSeed.teams),
    getStoredTeamIdentityMappings(teamSeed.teams)
  ]);
  const byId = new Map(discovery.teams.map(team => [team.trackedTeamId, team]));
  const searchesById = new Map(searchReview.teams.map(team => [team.trackedTeamId, team]));
  const mappingsById = new Map(identityMappings.teams.map(team => [team.trackedTeamId, team]));
  return res.json({
    source: teamSeed.source,
    count: teamSeed.count,
    mappingState: discovery.state === "ready" ? "derived_from_durable_provider_observations" : discovery.state,
    discovery: {
      state: discovery.state, observationsLoaded: discovery.observationsLoaded,
      resolved: discovery.resolved, ambiguous: discovery.ambiguous, unresolved: discovery.unresolved,
      ...(discovery.errorCode ? { errorCode: discovery.errorCode } : {})
    },
    note: "The favourite-team list is preserved. Provider identities are derived conservatively from stored fixture observations; unresolved names are not guessed.",
    providerSearchReview: {
      state: searchReview.state,
      searchedTeams: searchReview.searchedTeams,
      candidateCount: searchReview.candidateCount,
      note: "Provider search candidates are suggestions only; they are not approved mappings."
    },
    canonicalMappingSummary: {
      state: identityMappings.state,
      confirmed: identityMappings.confirmed,
      ambiguous: identityMappings.ambiguous,
      unresolved: identityMappings.unresolved,
      providerCandidates: identityMappings.providerCandidates,
      needsReviewCandidates: identityMappings.needsReviewCandidates,
      ...(identityMappings.errorCode ? { errorCode: identityMappings.errorCode } : {}),
      note: "Provider-scoped candidates are usable only as provider-specific identity hints; they are not cross-provider confirmation and never count as verified historical results."
    },
    teams: teamSeed.teams.map(team => ({
      ...team,
      identityDiscovery: byId.get(team.id) ?? { trackedTeamId: team.id, canonicalName: team.canonicalName, state: "unresolved", identities: [], reasons: ["durable_identity_discovery_unavailable"] },
      providerSearch: searchesById.get(team.id) ?? { trackedTeamId: team.id, canonicalName: team.canonicalName, state: "never_searched", providers: [] },
      canonicalMapping: mappingsById.get(team.id) ?? { trackedTeamId: team.id, canonicalName: team.canonicalName, state: "unresolved", providers: [] }
    }))
  });
});

app.get("/api/predictions/status", async (_req: Request, res: Response) => {
  const status = await predictionStorageStatus();
  const mappings = await listReviewedTeamMappings();
  return res.status(status.state === "error" || mappings.state === "error" ? 503 : 200).json({
    ...status,
    teamMappingsState: mappings.state,
    teamMappingCount: mappings.state === "ready" ? mappings.mappings.length : null,
    predictionModel: "poisson-baseline",
    calibratedForBetting: false,
    bettingRecommendationsEnabled: false,
    note: "A working data path is not proof of calibration. Forecasts are exploratory only; betting recommendations remain disabled."
  });
});

app.get("/api/predictions/team-mappings", async (_req: Request, res: Response) => {
  const result = await listReviewedTeamMappings();
  return res.status(result.state === "error" ? 503 : 200).json({
    ...result,
    note: "Mappings are manually reviewed exact canonical names. No fuzzy matching or automatic identity guesses are used."
  });
});

app.post("/api/predictions/team-mappings", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const body = req.body ?? {};
  const result = await saveReviewedTeamMapping({
    teamId: typeof body.teamId === "string" ? body.teamId : "",
    canonicalName: typeof body.canonicalName === "string" ? body.canonicalName : "",
    reviewedBy: typeof body.reviewedBy === "string" ? body.reviewedBy : ""
  });
  const statusCode = result.state === "saved" ? 201 : result.state === "conflict" ? 409 : 400;
  return res.status(statusCode).json(result);
});

app.get("/api/predictions", async (req: Request, res: Response) => {
  const canonicalKey = typeof req.query.canonicalKey === "string" ? req.query.canonicalKey : "";
  if (!canonicalKey) return res.status(400).json({ state: "invalid_request", reason: "canonicalKey_query_parameter_required" });
  const result = await predictStoredFixture(canonicalKey);
  const statusCode = result.state === "forecast_available" ? 200 :
    result.state === "withheld" ? 422 : result.state === "unavailable" ? 503 :
    result.state === "invalid_request" ? 400 : 503;
  return res.status(statusCode).json(result);
});

app.post("/api/predictions/run", async (req: Request, res: Response) => {
  const canonicalKey = typeof req.body?.canonicalKey === "string" ? req.body.canonicalKey : "";
  if (!canonicalKey) return res.status(400).json({ state: "invalid_request", reason: "canonicalKey_required" });
  const result = await predictStoredFixture(canonicalKey);
  const statusCode = result.state === "forecast_available" ? 200 :
    result.state === "withheld" ? 422 : result.state === "unavailable" ? 503 :
    result.state === "invalid_request" ? 400 : 503;
  return res.status(statusCode).json(result);
});

app.get("/api/fixtures", async (_req: Request, res: Response) => {
  const evidence = await getCanonicalEvidenceSummary();
  if (evidence.state !== "ready") {
    return res.status(evidence.state === "error" ? 503 : 200).json({
      state: evidence.state, fixtures: [], count: 0,
      reasons: [evidence.errorCode ?? "canonical_evidence_store_not_ready"]
    });
  }
  return res.json({
    state: "canonical_evidence",
    fixtures: evidence.fixtures ?? [],
    count: evidence.corroboratedFixtureCount ?? 0,
    verifiedSettledResults: evidence.verifiedSettledResultCount ?? 0,
    conflictedFixtures: evidence.conflictedFixtureCount ?? 0,
    note: "Fixtures are shown only when corroborated across independent providers. Scores are included only when settled-result evidence passed the verification gate."
  });
});

app.get("/api/history/status", async (_req: Request, res: Response) => {
  const [evidence, teamDiscovery, identityMappings, searchReview] = await Promise.all([
    getCanonicalEvidenceSummary(),
    getStoredTeamIdentityDiscovery(teamSeed.teams),
    getStoredTeamIdentityMappings(teamSeed.teams),
    getStoredTeamSearchReview(teamSeed.teams)
  ]);
  const failed = evidence.state === "error" || teamDiscovery.state === "error" ||
    identityMappings.state === "error" || searchReview.state === "error";
  return res.status(failed ? 503 : 200).json({
    state: evidence.state === "ready" ? "canonical_evidence" : evidence.state,
    seededTeamNames: teamSeed.count,
    canonicalTeamMappings: identityMappings.confirmed,
    teamIdentityMappings: {
      state: identityMappings.state, confirmed: identityMappings.confirmed,
      ambiguous: identityMappings.ambiguous, unresolved: identityMappings.unresolved,
      providerCandidates: identityMappings.providerCandidates,
      needsReviewCandidates: identityMappings.needsReviewCandidates
    },
    teamSearchProgress: {
      state: searchReview.state, searchedTeams: searchReview.searchedTeams,
      candidateCount: searchReview.candidateCount, totalTeams: searchReview.trackedTeams
    },
    discoveredTeamIdentities: teamDiscovery.resolved,
    teamIdentityDiscovery: {
      state: teamDiscovery.state, observationsLoaded: teamDiscovery.observationsLoaded,
      resolved: teamDiscovery.resolved, ambiguous: teamDiscovery.ambiguous, unresolved: teamDiscovery.unresolved
    },
    teamMappingState: identityMappings.state === "ready" ? "persistent_cross_provider_identity_registry" : identityMappings.state,
    canonicalFixtures: evidence.corroboratedFixtureCount ?? 0,
    verifiedSettledResults: evidence.verifiedSettledResultCount ?? 0,
    conflictedFixtures: evidence.conflictedFixtureCount ?? 0,
    staleLiveFixtures: evidence.staleLiveFixtureCount ?? 0,
    reasons: [
      ...(evidence.state === "ready" ? [] : [evidence.errorCode ?? "canonical_evidence_store_not_ready"]),
      ...(teamDiscovery.state === "ready" ? [] : [teamDiscovery.errorCode ?? "team_identity_storage_not_ready"]),
      ...(identityMappings.state === "ready" ? [] : [identityMappings.errorCode ?? "canonical_team_mapping_store_not_ready"]),
      ...(searchReview.state === "ready" ? [] : [searchReview.errorCode ?? "team_search_store_not_ready"])
    ]
  });
});

app.get("/", (_req: Request, res: Response) => res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unified Football Intelligence</title>
<style>body{margin:0;background:#0b1220;color:#e8eef9;font:16px system-ui}main{max-width:1000px;margin:auto;padding:32px 20px}h1{margin-bottom:6px}.muted{color:#9baac2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:24px 0}.card{background:#121e31;border:1px solid #2a3a54;border-radius:12px;padding:18px}.status{font-weight:700;color:#f2c879}.row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #2a3a54;padding:12px 0}.small{font-size:13px;color:#9baac2}code{color:#9ed7ff}</style></head>
<body><main><p class="small">GREENFIELD PLATFORM · FOUNDATION BUILD</p><h1>Unified Football Intelligence</h1><p class="muted">Broad fixture monitoring. Deep team histories. Evidence-first forecasts. Selective betting only when the evidence justifies it.</p>
<div class="grid"><section class="card"><div class="small">LIVE FIXTURES</div><h2 id="fixtures">Not connected</h2><p class="muted">No placeholder fixtures are shown.</p></section><section class="card"><div class="small">VERIFIED HISTORY</div><h2 id="history">Not loaded</h2><p class="muted">Counts will only include reconciled settled results.</p></section><section class="card"><div class="small">DURABLE STORAGE</div><h2 id="storage">Checking…</h2><p class="muted" id="storage-detail">Checking PostgreSQL observation storage.</p></section><section class="card"><div class="small">MODEL READINESS</div><h2>Not calibrated</h2><p class="muted">Baseline code is not a proven betting model.</p></section></div>
<section class="card"><h2>Provider connections</h2><p class="muted">A configured secret is not proof that an API call works. Each provider remains disconnected until its contract, live response and data validation pass.</p><div id="providers">Loading provider status…</div></section>
<section class="card" style="margin-top:14px"><h2>Run live fixture check</h2><p class="muted">This makes on-demand calls to SportAPI.ai, Sportmonks and API-Football if credentials are configured. Returned records remain unverified until canonical identity checks and persistence are connected.</p><div class="row"><label for="fixture-date">UTC calendar date</label><input id="fixture-date" type="date"><label for="provider-token">Diagnostics token (when configured)</label><input id="provider-token" type="password" autocomplete="off"><button id="fetch-fixtures">Check providers</button></div><pre id="fixture-check" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No provider check run yet.</pre></section>
<section class="card" style="margin-top:14px"><h2>Favourite-team identity discovery</h2><p class="muted">Searches the 80 saved favourites in small, rate-limited batches. Exact name/alias plus matching country from both providers is required before a provider identity is confirmed. This does not create historical match results.</p><div class="row"><button id="discover-teams">Discover favourite teams</button><span id="team-discovery-progress" class="small">Not started</span></div><pre id="team-discovery-log" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">Ready when PostgreSQL and provider credentials are configured.</pre></section>
<section class="card" style="margin-top:14px"><h2>Prediction engine</h2>
<p class="muted">Select a canonical fixture key from <code>/api/fixtures</code>. The engine reads only verified historical results from PostgreSQL; it does not accept manually supplied statistics. Any missing evidence is reported as a withheld forecast.</p>
<div class="row"><label for="prediction-fixture-key">Canonical fixture key</label><input id="prediction-fixture-key" type="text" placeholder="Paste canonical_key from /api/fixtures"><button id="run-prediction">Run forecast</button></div>
<pre id="prediction-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No prediction requested.</pre>
<p class="small">Team mappings must be reviewed and saved before forecasting. Enter the exact canonical fixture team name and a stable team ID that you have verified.</p>
<div class="row"><label for="mapping-team-id">Reviewed team ID</label><input id="mapping-team-id" type="text" placeholder="Verified stable ID"><label for="mapping-canonical-name">Exact canonical name</label><input id="mapping-canonical-name" type="text" placeholder="Exact name from fixture"><label for="mapping-reviewed-by">Reviewed by</label><input id="mapping-reviewed-by" type="text" placeholder="Reviewer identifier"><button id="save-team-mapping">Save mapping</button></div>
<pre id="mapping-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">Mappings require the diagnostics token in production.</pre>
</section>
<section class="card" style="margin-top:14px"><h2>Integrity rules</h2><ul><li>Unknown data stays unknown; it is never replaced with zero or a guess.</li><li>Conflicting fixture identity or results are flagged, not silently selected.</li><li>Forecast probabilities and betting decisions are separate.</li><li>No recommendations until verified data, calibration, fresh odds and risk gates pass.</li></ul><p class="small">This foundation is not yet a live prediction service. Status is intentionally honest.</p></section>
<script>async function load(){try{const [p,f,h,s]=await Promise.all([fetch('/api/providers/status').then(r=>r.json()),fetch('/api/fixtures').then(r=>r.json()),fetch('/api/history/status').then(r=>r.json()),fetch('/api/storage/status').then(r=>r.json()).catch(()=>({state:'error',errorCode:'status_unavailable'}))]);document.getElementById('fixtures').textContent=f.count+' corroborated fixtures';document.getElementById('history').textContent=h.seededTeamNames+' teams · '+(h.canonicalTeamMappings||0)+' mapped · '+h.verifiedSettledResults+' verified results';document.getElementById('storage').textContent=s.state==='ready'?'Connected':s.state==='not_configured'?'Not configured':'Unavailable';document.getElementById('storage-detail').textContent=s.state==='ready'?s.observationCount+' observations saved':(s.errorCode||'Configure DATABASE_URL to persist observations');document.getElementById('providers').innerHTML=p.providers.map(x=>'<div class="row"><span><strong>'+x.name+'</strong><br><span class="small">'+x.priority+' · credential '+(x.credentialConfigured?'configured':'missing')+' · '+x.integrationState+'</span></span><span class="status">'+x.diagnostics.state+'</span></div>').join('')}catch(e){document.getElementById('providers').textContent='Status API unavailable.'}}document.getElementById('fixture-date').value=new Date().toISOString().slice(0,10);
document.getElementById('discover-teams').addEventListener('click',async()=>{
 const button=document.getElementById('discover-teams'),progress=document.getElementById('team-discovery-progress'),log=document.getElementById('team-discovery-log');
 const token=document.getElementById('provider-token').value;
 button.disabled=true;log.textContent='Starting rate-limited discovery…';progress.textContent='Running';
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));let done=false,rateRetries=0;
 try{
  for(let batch=1;batch<=32;batch++){
   if(batch>1)await sleep(31000);
   let response=await fetch('/api/teams/provider-search/next-batch',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-provider-diagnostics-token':token}:{})},body:'{}'});
   if(response.status===429&&rateRetries<3){rateRetries++;log.textContent+='\\nRate limit reached; waiting 65 seconds before retry '+rateRetries+'/3.';await sleep(65000);batch--;continue}
   const data=await response.json().catch(()=>({state:'invalid_response'}));
   if(!response.ok){log.textContent+='\\nStopped: HTTP '+response.status+' — '+(data.reason||data.state||'request failed');progress.textContent='Stopped';break}
   if(data.state==='team_search_batches_complete'){log.textContent+='\\nAll searchable batches complete.';progress.textContent='Complete';done=true;break}
   if(data.state!=='provider_team_search_batch_completed'){log.textContent+='\\nStopped: '+(data.state||'unexpected response');progress.textContent='Stopped';break}
   const p=data.progress||{},m=data.identityMapping||{};
   const names=(data.processed||[]).map(x=>x.name).join(', ');
   log.textContent='Batch '+batch+': '+(p.searchedTeams??'?')+'/'+(p.trackedTeams??80)+' teams searched; '+(p.candidateCount??0)+' candidates saved; '+(m.confirmed??0)+' confirmed mappings this batch; '+(data.retryableTeamsRemaining??'?')+' retryable teams remaining.\\n'+names;
   progress.textContent=(p.searchedTeams??'?')+'/'+(p.trackedTeams??80)+' searched';
   if(data.retryableTeamsRemaining===0){done=true;progress.textContent='Complete';break}
   rateRetries=0;
  }
  if(!done&&progress.textContent!=='Stopped'){progress.textContent='Paused';log.textContent+='\\nRun again later to continue any remaining retryable teams.'}
  load();
 }catch(e){progress.textContent='Error';log.textContent+='\\nDiscovery request failed; check server and database status.'}
 finally{button.disabled=false}
});
document.getElementById('run-prediction').addEventListener('click',async()=>{
 const key=document.getElementById('prediction-fixture-key').value.trim(),out=document.getElementById('prediction-output');
 if(!key){out.textContent='Enter a canonical fixture key from /api/fixtures.';return}
 out.textContent='Loading verified history and running the model…';
 try{
  const response=await fetch('/api/predictions/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({canonicalKey:key})});
  const data=await response.json();
  if(data.state==='forecast_available'&&data.forecast){
   const p=data.forecast;
   out.textContent='FORECAST AVAILABLE — NOT A BETTING RECOMMENDATION\\nHome win: '+(p.homeWin*100).toFixed(2)+'%\\nDraw: '+(p.draw*100).toFixed(2)+'%\\nAway win: '+(p.awayWin*100).toFixed(2)+'%\\nEvidence state: '+p.evidenceState+'\\nHistorical rows loaded: '+data.historyRowsLoaded+'\\nHome/away samples: '+data.diagnostics.homeSamples+'/'+data.diagnostics.awaySamples+'\\nEvidence hash: '+data.evidenceHash+'\\nReason betting remains disabled: '+data.recommendationReason;
  }else{out.textContent='PREDICTION WITHHELD\\n'+JSON.stringify(data,null,2)}
 }catch(e){out.textContent='Prediction request failed. No probabilities are shown.'}
});
document.getElementById('save-team-mapping').addEventListener('click',async()=>{
 const out=document.getElementById('mapping-output'),token=document.getElementById('provider-token').value;
 const body={teamId:document.getElementById('mapping-team-id').value.trim(),canonicalName:document.getElementById('mapping-canonical-name').value.trim(),reviewedBy:document.getElementById('mapping-reviewed-by').value.trim()};
 out.textContent='Saving reviewed mapping…';
 try{
  const response=await fetch('/api/predictions/team-mappings',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-provider-diagnostics-token':token}:{})},body:JSON.stringify(body)});
  const data=await response.json();out.textContent=JSON.stringify(data,null,2);
 }catch(e){out.textContent='Mapping request failed. No mapping was confirmed.'}
});
document.getElementById('fetch-fixtures').addEventListener('click',async()=>{const date=document.getElementById('fixture-date').value;const out=document.getElementById('fixture-check');out.textContent='Checking providers…';try{const token=document.getElementById('provider-token').value;const r=await fetch('/api/providers/fixtures?date='+encodeURIComponent(date),{headers:token?{'x-provider-diagnostics-token':token}:{}});const data=await r.json();if(data.candidateCount!==undefined){out.textContent=JSON.stringify({state:data.state,date:data.date,candidateCount:data.candidateCount,canonicalFixturesCorroborated:data.canonicalFixturesCorroborated,verifiedResultsCreatedOrConfirmed:data.verifiedResultsCreatedOrConfirmed,conflictedGroups:data.conflictedGroups,canonicalEvidence:data.canonicalEvidence,persistence:data.persistence,cache:data.cache,cachedAt:data.cachedAt,retrievedAt:data.retrievedAt,candidateCountsByProvider:data.candidateCountsByProvider,candidateCountsByStatus:data.candidateCountsByStatus,reconciliationSummary:data.reconciliationSummary,providers:(data.providers||[]).map(p=>({name:p.name,state:p.diagnostics?.state,attemptedAt:p.diagnostics?.lastAttemptAt,succeededAt:p.diagnostics?.lastSuccessAt,records:p.diagnostics?.lastRecordCount,accepted:p.diagnostics?.lastAcceptedCount,rejected:p.diagnostics?.lastRejectedCount,rejectionReasons:p.diagnostics?.lastRejectionReasons,httpStatus:p.diagnostics?.lastHttpStatus,responseShape:p.diagnostics?.lastResponseShape,error:p.diagnostics?.lastErrorCode})),sampleCandidates:(data.sampleCandidates||[]).slice(0,5)},null,2);try{const s=await fetch('/api/storage/status').then(r=>r.json());document.getElementById('storage').textContent=s.state==='ready'?'Connected':s.state==='not_configured'?'Not configured':'Unavailable';document.getElementById('storage-detail').textContent=s.state==='ready'?s.observationCount+' observations saved':(s.errorCode||'Configure DATABASE_URL to persist observations')}catch{document.getElementById('storage-detail').textContent='Could not refresh storage status'}}else{out.textContent=JSON.stringify(data,null,2)}}catch(e){out.textContent='Provider check failed. Inspect server diagnostics.'}});load();</script>
</main></body></html>`));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Unified Football Intelligence listening on ${port}`));
