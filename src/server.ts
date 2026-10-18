import teamSeed from "./data/initial-tracked-teams.json" with { type: "json" };
import "dotenv/config";
import express, { type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { aggregateProviderStatus } from "./status/aggregate.js";
import { createTicket, getTicketById, listTickets, reconcilePendingTickets } from "./tickets/store.js";
import { parseBetMatrixTicket } from "./tickets/betmatrixImport.js";
import { loadOutOfSampleEvaluation } from "./evaluation/store.js";
import type { ProviderDiagnostics } from "./providers/provider.js";
import { SportApiAiProvider } from "./providers/adapters/sportApiAi.js";
import { validateHistoricalDateRange } from "./providers/dateRange.js";
import { SportmonksProvider } from "./providers/adapters/sportmonks.js";
import { ApiFootballProvider } from "./providers/adapters/apiFootball.js";
import { hasCompleteReviewedProviderTeamIdentityCoverage, previewCandidateReconciliation } from "./domain/reconcileCandidates.js";
import { curatedTeamSearchAliases, discoverTrackedTeamIdentities, reviewTeamSearchCandidates } from "./domain/teamIdentity.js";
import { searchTeamAcrossProviders } from "./providers/teamSearch.js";
import { getCanonicalEvidenceSummary, getObservationStoreStatus, getObservationStoreSummary, getReviewedProviderTeamIdentityMap, getStoredTeamIdentityDiscovery, getStoredTeamSearchReview, getStoredTeamIdentityMappings, reconcileStoredTeamSearchCandidates, saveReviewedSportApiTeamIdentityMapping, resolveCanonicalFixtureProviderRefs, persistCanonicalEvidence, persistProviderObservations, persistTeamSearchObservations, replayStoredProviderObservations } from "./storage/postgresObservations.js";
import { listReviewedTeamAliases, listReviewedTeamMappings, listSavedPredictions, predictStoredFixture, predictionStorageStatus, saveReviewedTeamAlias, saveReviewedTeamMapping } from "./prediction/pipeline.js";

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
function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  };
  return value.replace(/[&<>"']/g, character => entities[character] ?? character);
}
function ticketAccessAllowed(req: Request, res: Response): boolean {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
    return false;
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
    return false;
  }
  return true;
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

app.get("/health", async (_req: Request, res: Response) => {
  // Liveness is independent of optional integrations; report readiness facts separately.
  const [storage, predictionStorage, canonicalEvidence] = await Promise.all([
    getObservationStoreStatus(),
    predictionStorageStatus(),
    getCanonicalEvidenceSummary()
  ]);
  const providers = providerStatus();
  const now = Date.now();
  const recentProviderSuccess = providers.some(provider => {
    const d = provider.diagnostics;
    const successAt = d.lastSuccessAt ? Date.parse(d.lastSuccessAt) : Number.NaN;
    return provider.credentialConfigured &&
      ["success", "success_empty", "partial"].includes(d.state) &&
      Number.isFinite(successAt) && now - successAt >= 0 && now - successAt <= 6 * 60 * 60 * 1000;
  });
  const fixtureCount = canonicalEvidence.state === "ready"
    ? (canonicalEvidence.corroboratedFixtureCount ?? 0) : null;
  return res.json({
    status: "ok",
    app: "Unified Football Intelligence",
    mode: "evidence_gated",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    databaseState: storage.state,
    predictionStorageState: predictionStorage.state,
    providerCredentialsConfigured: providers.some(p => p.credentialConfigured),
    providerAdaptersConnected: recentProviderSuccess,
    providerDiagnostics: providers.map(p => ({
      name: p.name, credentialConfigured: p.credentialConfigured,
      state: p.diagnostics.state, lastSuccessAt: p.diagnostics.lastSuccessAt ?? null,
      lastRecordCount: p.diagnostics.lastRecordCount, lastErrorCode: p.diagnostics.lastErrorCode ?? null
    })),
    liveFixturesAvailable: fixtureCount === null ? null : fixtureCount > 0,
    corroboratedFixtureCount: fixtureCount,
    calibratedPredictionsAvailable: false,
    bettingRecommendationsEnabled: false,
    readiness: {
      database: storage.state === "ready" && predictionStorage.state === "ready",
      recentProviderSuccess,
      corroboratedFixtures: fixtureCount !== null && fixtureCount > 0,
      verifiedHistoricalResults: predictionStorage.state === "ready"
        ? predictionStorage.evidence.verifiedSettledResults : null,
      forecastModelCalibrated: false,
      bettingRecommendations: false
    },
    note: "HTTP 200 confirms process liveness only. Read readiness fields separately; missing or unavailable counts remain null and never imply zero."
  });
});

app.get("/api/status", async (_req: Request, res: Response) => {
  const [storage, predictionStorage, mappings] = await Promise.all([
    getObservationStoreStatus(),
    predictionStorageStatus(),
    listReviewedTeamMappings()
  ]);
  const predictionState = predictionStorage.state === "ready" ? predictionStorage : null;
  return res.status(storage.state === "error" || predictionStorage.state === "error" || mappings.state === "error" ? 503 : 200).json({
    status: "foundation",
    message: "The core pipeline and evidence ledger are implemented. Live data coverage and deployment durability must be verified in the target environment; betting recommendations remain disabled.",
    modules: {
      canonicalDomain: "implemented_initial_contracts",
      providerAdapters: "implemented_live_credentials_and_coverage_unverified",
      durableDatabase: storage.state,
      predictionStorage: predictionStorage.state,
      verifiedHistoricalEvidence: predictionState?.evidence ?? "unavailable_until_database_and_evidence_tables_are_ready",
      reviewedTeamMappings: mappings.state === "ready" ? mappings.mappings.length : mappings.state,
      poissonBaseline: "implemented_not_calibrated",
      immutablePredictionLedger: "implemented_evidence_hash_and_read_only_history_endpoint",
      bettingRecommendations: "disabled_until_evidence_and_out_of_sample_calibration_gates_pass"
    }
  });
});

app.get("/api/storage/status", async (_req: Request, res: Response) => {
  const status = await getObservationStoreStatus();
  res.status(status.state === "error" ? 503 : 200).json(status);
});
app.get("/api/storage/observations/summary", async (_req: Request, res: Response) => {
  const summary = await getObservationStoreSummary();
  res.status(summary.state === "error" ? 503 : 200).json(summary);
});
app.get("/api/data-pipeline/status", async (_req: Request, res: Response) => {
  const [observations, canonical, prediction, mappings] = await Promise.all([
    getObservationStoreSummary(),
    getCanonicalEvidenceSummary(),
    predictionStorageStatus(),
    listReviewedTeamMappings()
  ]);
  const providers = providerStatus();
  const now = Date.now();
  const providerSummary = providers.map(provider => {
    const successAt = provider.diagnostics.lastSuccessAt ? Date.parse(provider.diagnostics.lastSuccessAt) : Number.NaN;
    const recentSuccess = provider.credentialConfigured &&
      ["success", "success_empty", "partial"].includes(provider.diagnostics.state) &&
      Number.isFinite(successAt) && now - successAt >= 0 && now - successAt <= 6 * 60 * 60 * 1000;
    return {
      name: provider.name,
      priority: provider.priority,
      credentialConfigured: provider.credentialConfigured,
      state: provider.diagnostics.state,
      recentSuccess,
      lastSuccessAt: provider.diagnostics.lastSuccessAt ?? null,
      lastRecordCount: provider.diagnostics.lastRecordCount,
      lastAcceptedCount: provider.diagnostics.lastAcceptedCount ?? null,
      lastRejectedCount: provider.diagnostics.lastRejectedCount ?? null,
      lastErrorCode: provider.diagnostics.lastErrorCode ?? null
    };
  });
  const observationCount = observations.state === "ready" ? observations.totalObservations ?? null : null;
  const fixtureCount = canonical.state === "ready" ? canonical.corroboratedFixtureCount ?? null : null;
  const resultCount = canonical.state === "ready" ? canonical.verifiedSettledResultCount ?? null : null;
  const mappingCount = mappings.state === "ready" ? mappings.mappings.length : null;
  const stages = {
    providers: {
      state: providerSummary.some(p => p.recentSuccess) ? "recent_success" :
        providerSummary.some(p => p.credentialConfigured) ? "configured_but_not_recently_verified" : "no_credentials_configured",
      recentSuccessCount: providerSummary.filter(p => p.recentSuccess).length,
      configuredCount: providerSummary.filter(p => p.credentialConfigured).length,
      providers: providerSummary
    },
    rawObservations: {
      state: observations.state === "error" ? "error" :
        observations.state === "not_configured" ? "not_configured" :
        observationCount === null ? "unknown" : observationCount > 0 ? "available" : "empty",
      count: observationCount,
      lastObservedAt: observations.state === "ready" ? observations.lastObservedAt ?? null : null,
      errorCode: observations.state === "error" ? observations.errorCode ?? null : null
    },
    canonicalFixtures: {
      state: canonical.state === "error" ? "error" :
        canonical.state === "not_configured" ? "not_configured" :
        fixtureCount === null ? "unknown" : fixtureCount > 0 ? "available" : "empty",
      corroboratedCount: fixtureCount,
      conflictedCount: canonical.state === "ready" ? canonical.conflictedFixtureCount ?? null : null,
      errorCode: canonical.state === "error" ? canonical.errorCode ?? null : null
    },
    verifiedResults: {
      state: canonical.state === "error" ? "error" :
        canonical.state === "not_configured" ? "not_configured" :
        resultCount === null ? "unknown" : resultCount > 0 ? "available" : "empty",
      count: resultCount
    },
    reviewedTeamMappings: {
      state: mappings.state,
      count: mappingCount,
      errorCode: mappings.state === "error" ? mappings.errorCode ?? null : null
    },
    predictionStorage: {
      state: prediction.state,
      savedForecastCount: prediction.state === "ready" ? prediction.saved_forecasts : null,
      calibratedForBetting: false
    }
  };
  const blockers: string[] = [];
  if (!stages.providers.recentSuccessCount) blockers.push("no_provider_success_in_last_6_hours");
  if (stages.rawObservations.state !== "available") blockers.push("raw_provider_observations_unavailable");
  if (stages.canonicalFixtures.state !== "available") blockers.push("corroborated_canonical_fixtures_unavailable");
  if (stages.verifiedResults.state !== "available") blockers.push("verified_historical_results_unavailable");
  if (stages.reviewedTeamMappings.state !== "ready" || !mappingCount) blockers.push("reviewed_prediction_team_mappings_unavailable");
  if (stages.predictionStorage.state !== "ready") blockers.push("prediction_storage_not_ready");
  const dataPresent = blockers.length === 0;
  return res.status([observations.state, canonical.state, prediction.state, mappings.state].includes("error") ? 503 : 200).json({
    state: dataPresent ? "data_present_for_fixture_specific_checks" : "insufficient_or_unverified_data",
    stages,
    blockers,
    important: "This endpoint diagnoses pipeline stages only. It does not assert that any particular fixture has enough team history, that its forecast is calibrated, or that betting recommendations are enabled.",
    bettingRecommendationsEnabled: false
  });
});

app.get("/api/automation/provider-poll/status", (_req: Request, res: Response) => {
  return res.json({
    ...automaticPollStatus,
    enabled: autoPollingEnabled && Number.isInteger(autoPollingMinutes) && autoPollingMinutes >= 5 && autoPollingMinutes <= 60,
    intervalMinutes: autoPollingMinutes,
    databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    note: "A completed cycle only confirms the poll ran. Candidate counts and corroborated/verified evidence counts are separate; zero results never implies fabricated data. Provider-level diagnostics show adapter failures."
  });
});

app.get("/api/providers/status", (_req: Request, res: Response) => {
  const providers = providerStatus();
  res.json({ ...aggregateProviderStatus(providers.map(p => p.diagnostics)), providers });
});

app.get("/api/providers/history", async (req: Request, res: Response) => {
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
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const todayUtc = new Date().toISOString().slice(0, 10);
  const range = validateHistoricalDateRange(from, to, todayUtc, 7);
  if (range.state !== "valid") return res.status(400).json({ state: "invalid_request", reason: range.reason });

  const query = { dateFromUtc: range.from, dateToUtc: range.to };
  const [sportApiAi, sportmonks, apiFootball] = await Promise.all([
    sportApiAiProvider.fetchFixtures(query),
    sportmonksProvider.fetchFixtures(query),
    apiFootballProvider.fetchFixtures(query)
  ]);
  const candidates = [...sportApiAi, ...sportmonks, ...apiFootball];
  const persistence = await persistProviderObservations(candidates);
  const canonicalEvidence = await persistCanonicalEvidence(candidates);
  const ticketSettlement = await reconcilePendingTickets();
  const reviewedTeamIds = await getReviewedProviderTeamIdentityMap();
  const reconciliationPreview = previewCandidateReconciliation(candidates, 5 * 60_000, Date.now(), reviewedTeamIds);
  const unmappedProviderIdentityCandidates = candidates.filter(candidate =>
    !hasCompleteReviewedProviderTeamIdentityCoverage([candidate], reviewedTeamIds)
  ).length;
  const candidateCountsByStatus: Record<string, number> = {};
  for (const candidate of candidates) {
    candidateCountsByStatus[candidate.status] = (candidateCountsByStatus[candidate.status] ?? 0) + 1;
  }
  return res.json({
    state: "historical_ingestion_completed",
    range: { from: range.from, to: range.to, daysInclusive: range.daysInclusive },
    candidateCount: candidates.length,
    candidateCountsByProvider: { "sportapi-ai": sportApiAi.length, sportmonks: sportmonks.length, "api-football": apiFootball.length },
    candidateCountsByStatus,
    corroboratedFixtures: canonicalEvidence.corroboratedFixtures,
    verifiedSettledResults: canonicalEvidence.verifiedResults,
    conflictedGroups: canonicalEvidence.conflictedGroups,
    ticketSettlement,
    persistence,
    canonicalEvidence,
    reconciliation: {
      groups: reconciliationPreview.length,
      unmappedProviderIdentityCandidates,
      corroborated: reconciliationPreview.filter(item => item.state === "corroborated").length,
      conflicted: reconciliationPreview.filter(item => item.state === "conflicted").length,
      singleSource: reconciliationPreview.filter(item => item.state === "single_source").length
    },
    note: "Only finished scores corroborated by at least two providers are promoted to verified settled results. A successful request or nonzero candidate count does not guarantee verified history was created."
  });
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
  // Re-evaluate pending tickets after each fresh provider result-ingestion cycle.
  // Settlement uses only the canonical verified-result table, never raw observations.
  const ticketSettlement = await reconcilePendingTickets();
  const reviewedTeamIds = await getReviewedProviderTeamIdentityMap();
  const reconciliationPreview = previewCandidateReconciliation(candidates, 5 * 60_000, Date.now(), reviewedTeamIds);
  const unmappedProviderIdentityCandidates = candidates.filter(candidate =>
    !hasCompleteReviewedProviderTeamIdentityCoverage([candidate], reviewedTeamIds)
  ).length;
  const byStatus: Record<string, number> = {};
  for (const candidate of candidates) byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
  const payload = {
    state: "provider_ingestion_completed", date,
    canonicalFixturesCorroborated: canonicalEvidence.corroboratedFixtures,
    verifiedResultsCreatedOrConfirmed: canonicalEvidence.verifiedResults,
    ticketSettlement,
    conflictedGroups: canonicalEvidence.conflictedGroups,
    note: "Raw observations remain unverified. Canonical fixture evidence is stored separately and only cross-provider corroborated finished scores can enter the verified-result ledger. Single-source or conflicted evidence is never promoted.",
    persistence,
    canonicalEvidence,
    candidateCount: candidates.length,
    candidateCountsByProvider: { "sportapi-ai": sportApiAi.length, sportmonks: sportmonks.length, "api-football": apiFootball.length },
    candidateCountsByStatus: byStatus,
    reconciliationSummary: {
      groups: reconciliationPreview.length,
      unmappedProviderIdentityCandidates,
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
    if (!/^(0|[1-9]\d*)$/.test(batchRaw)) return res.status(400).json({ state: "invalid_request", reason: "provide_teamIds_or_batch_index_starting_at_zero" });
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
    providers: await searchTeamAcrossProviders(team.canonicalName, undefined, undefined, curatedTeamSearchAliases(team), { country: team.country, league: team.league, teamCategory: team.teamCategory })
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
    team.providers.filter(provider => provider.provider !== "sportapi-ai").length < 2 ||
    team.providers.filter(provider => provider.provider !== "sportapi-ai").some(provider =>
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
    providers: await searchTeamAcrossProviders(team.canonicalName, undefined, undefined, curatedTeamSearchAliases(team), { country: team.country, league: team.league, teamCategory: team.teamCategory })
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
  const providerCoverage = (["api-football", "sportmonks", "sportapi-ai"] as const).map(provider => {
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


app.post("/api/teams/provider-search/review-sportapi", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const reviewed = await saveReviewedSportApiTeamIdentityMapping({
    trackedTeamId: typeof body.trackedTeamId === "string" ? body.trackedTeamId : "",
    providerTeamId: typeof body.providerTeamId === "string" ? body.providerTeamId : "",
    reviewedBy: typeof body.reviewedBy === "string" ? body.reviewedBy : ""
  }, teamSeed.teams);
  const statusCode = reviewed.state === "saved" ? 200
    : reviewed.state === "invalid_input" ? 400
    : reviewed.state === "candidate_not_found" ? 404
    : reviewed.state === "unsafe_candidate" ? 422
    : reviewed.state === "conflict" ? 409
    : 503;
  return res.status(statusCode).json({
    ...reviewed,
    note: "An operator-reviewed SportAPI.ai provider ID may be used for canonical fixture identity matching only. The reviewedBy value is an operator-supplied audit label, not an independently authenticated account identity. This action does not verify any fixture, result, historical sample, forecast or ticket."
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

app.get("/api/predictions/ledger", async (req: Request, res: Response) => {
  const rawLimit = req.query.limit == null ? 20 : Number(req.query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    return res.status(400).json({ state: "invalid_request", reason: "limit_must_be_integer_1_to_100" });
  }
  const result = await listSavedPredictions(rawLimit);
  return res.status(result.state === "error" ? 503 : 200).json({
    ...result,
    note: "Ledger entries are immutable exploratory forecasts. current_identity_status distinguishes identity-gated records from legacy unreviewed or missing fixture identities; identity-gate eligibility is not model calibration or betting approval."
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
  const statusCode = result.state === "saved" ? 201 : result.state === "conflict" ? 409 : result.state === "error" ? 503 : 400;
  return res.status(statusCode).json(result);
});

app.get("/api/predictions/team-aliases", async (_req: Request, res: Response) => {
  const result = await listReviewedTeamAliases();
  return res.status(result.state === "error" ? 503 : 200).json({
    ...result,
    note: "Aliases are explicitly reviewed exact-name variants. Matching is case-insensitive with whitespace collapsed; ambiguous names are withheld."
  });
});

app.post("/api/predictions/team-aliases", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const body = req.body ?? {};
  const result = await saveReviewedTeamAlias({
    teamId: typeof body.teamId === "string" ? body.teamId : "",
    alias: typeof body.alias === "string" ? body.alias : "",
    reviewedBy: typeof body.reviewedBy === "string" ? body.reviewedBy : ""
  });
  const statusCode = result.state === "saved" ? 201 : result.state === "conflict" ? 409 : result.state === "error" ? 503 : 400;
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

app.post("/api/tickets", async (req: Request, res: Response) => {
  if (!ticketAccessAllowed(req, res)) return;
  const body = req.body ?? {};
  const result = await createTicket({
    ticketId: typeof body.ticketId === "string" ? body.ticketId : "",
    stakeAmount: typeof body.stakeAmount === "number" ? body.stakeAmount : Number.NaN,
    potentialPayout: typeof body.potentialPayout === "number" ? body.potentialPayout : Number.NaN,
    selections: Array.isArray(body.selections) ? body.selections : []
  });
  const code = result.state === "saved" ? 201 : result.state === "conflict" ? 409 :
    result.state === "invalid_input" ? 400 : 503;
  return res.status(code).json(result);
});

app.post("/api/tickets/import-betmatrix", async (req: Request, res: Response) => {
  if (!ticketAccessAllowed(req, res)) return;
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  if (!Array.isArray(body.tickets) || body.tickets.length === 0 || body.tickets.length > 50) {
    return res.status(400).json({
      state: "invalid_input",
      reason: "tickets_array_required_with_1_to_50_entries"
    });
  }

  const results: Array<{ sourceTicketId?: string; state: string; reason?: string; ticketId?: string }> = [];
  let imported = 0;
  let alreadyImported = 0;
  let skippedNonPending = 0;
  let rejected = 0;

  for (const rawTicket of body.tickets) {
    const parsed = parseBetMatrixTicket(rawTicket);
    if (parsed.state === "not_pending") {
      skippedNonPending++;
      results.push({ state: "skipped", reason: parsed.reason });
      continue;
    }
    if (parsed.state === "invalid") {
      rejected++;
      results.push({ state: "rejected", reason: parsed.reason });
      continue;
    }

    const ticket = parsed.ticket;
    const refs = ticket.selections.flatMap(selection => selection.refs);
    const resolved = await resolveCanonicalFixtureProviderRefs(refs);
    if (resolved.state !== "ready") {
      rejected++;
      results.push({ sourceTicketId: ticket.sourceTicketId, state: "rejected", reason: resolved.errorCode ?? resolved.state });
      continue;
    }
    const byRef = new Map(resolved.mappings.map(mapping => [
      `${mapping.provider}:${mapping.providerFixtureId}`, mapping
    ]));
    let unresolvedReason: string | undefined;
    const selections = ticket.selections.map(selection => {
      const mappings = selection.refs.map(ref => byRef.get(`${ref.provider}:${ref.providerFixtureId}`));
      if (mappings.some(mapping => !mapping || mapping.state !== "resolved" || !mapping.canonicalKey)) {
        unresolvedReason = "provider_fixture_id_not_linked_to_a_current_corroborated_canonical_fixture";
        return null;
      }
      const keys = new Set(mappings.map(mapping => mapping!.canonicalKey));
      if (keys.size !== 1) {
        unresolvedReason = "provider_fixture_ids_resolve_to_conflicting_canonical_fixtures";
        return null;
      }
      return {
        selectionId: selection.selectionId,
        fixtureId: [...keys][0]!,
        market: selection.market,
        pick: selection.pick,
        ...(selection.line !== undefined ? { line: selection.line } : {})
      };
    });
    if (unresolvedReason || selections.some(selection => selection === null)) {
      rejected++;
      results.push({ sourceTicketId: ticket.sourceTicketId, state: "rejected", reason: unresolvedReason ?? "ticket_selection_unresolved" });
      continue;
    }
    const resolvedSelections = selections.filter(
      (selection): selection is NonNullable<typeof selection> => selection !== null
    );

    const saved = await createTicket({
      ticketId: `betmatrix:${ticket.sourceTicketId}`,
      stakeAmount: ticket.stakeAmount,
      potentialPayout: ticket.potentialPayout,
      selections: resolvedSelections
    });
    if (saved.state === "saved") {
      imported++;
      results.push({ sourceTicketId: ticket.sourceTicketId, ticketId: `betmatrix:${ticket.sourceTicketId}`, state: "imported" });
    } else if (saved.state === "conflict") {
      const existing = await getTicketById(`betmatrix:${ticket.sourceTicketId}`);
      const existingSelections = existing.state === "ready" && existing.ticket && Array.isArray(existing.ticket.selections)
        ? existing.ticket.selections as Array<Record<string, unknown>> : [];
      const sameSelections = existingSelections.length === resolvedSelections.length && resolvedSelections.every((selection, index) => {
        const prior = existingSelections[index];
        return Boolean(prior) &&
          prior.selectionId === selection.selectionId &&
          prior.fixtureId === selection.fixtureId &&
          prior.market === selection.market &&
          prior.pick === selection.pick &&
          (prior.line === undefined ? undefined : Number(prior.line)) === selection.line;
      });
      if (existing.state === "ready" && existing.ticket &&
          Number(existing.ticket.stake_amount) === ticket.stakeAmount &&
          Number(existing.ticket.potential_payout) === ticket.potentialPayout &&
          sameSelections) {
        alreadyImported++;
        results.push({ sourceTicketId: ticket.sourceTicketId, ticketId: `betmatrix:${ticket.sourceTicketId}`, state: "already_imported" });
      } else {
        rejected++;
        results.push({
          sourceTicketId: ticket.sourceTicketId,
          ticketId: `betmatrix:${ticket.sourceTicketId}`,
          state: "rejected",
          reason: existing.state === "ready" && existing.ticket
            ? "source_ticket_id_reused_with_different_ticket_contents"
            : "existing_ticket_conflict_could_not_be_verified"
        });
      }
    } else {
      rejected++;
      results.push({ sourceTicketId: ticket.sourceTicketId, state: "rejected", reason: "ticket_store_unavailable_or_validation_failed" });
    }
  }

  return res.status(200).json({
    state: "completed",
    received: body.tickets.length,
    imported,
    alreadyImported,
    skippedNonPending,
    rejected,
    results,
    note: "Only pending BetMatrix tickets with supported markets and provider fixture IDs linked to current corroborated canonical fixtures are imported. Source settlement statuses, odds and model claims are not trusted; imported tickets settle only against Unified Football Intelligence verified results."
  });
});

app.get("/api/tickets", async (req: Request, res: Response) => {
  if (!ticketAccessAllowed(req, res)) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const result = await listTickets(limit);
  return res.status(result.state === "error" || result.state === "not_configured" ? 503 : 200).json(result);
});

app.post("/api/tickets/reconcile", async (req: Request, res: Response) => {
  if (!ticketAccessAllowed(req, res)) return;
  const result = await reconcilePendingTickets();
  return res.status(result.state === "ready" ? 200 : 503).json(result);
});

app.get("/api/evaluation/out-of-sample", async (_req: Request, res: Response) => {
  const storage = await predictionStorageStatus();
  if (storage.state !== "ready") {
    return res.status(503).json({
      state: "unavailable",
      reason: storage.state === "not_configured" ? "database_not_configured" : "prediction_storage_not_ready",
      metrics: null
    });
  }
  const result = await loadOutOfSampleEvaluation(30);
  return res.status(result.state === "ready" ? 200 : 503).json(result);
});

app.get("/", (_req: Request, res: Response) => res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unified Football Intelligence</title>
<style>body{margin:0;background:#0b1220;color:#e8eef9;font:16px system-ui}main{max-width:1000px;margin:auto;padding:32px 20px}h1{margin-bottom:6px}.muted{color:#9baac2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:24px 0}.card{background:#121e31;border:1px solid #2a3a54;border-radius:12px;padding:18px}.status{font-weight:700;color:#f2c879}.row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #2a3a54;padding:12px 0}.small{font-size:13px;color:#9baac2}code{color:#9ed7ff}</style></head>
<body><main><p class="small">GREENFIELD PLATFORM · FOUNDATION BUILD</p><h1>Unified Football Intelligence</h1><p class="muted">Broad fixture monitoring. Deep team histories. Evidence-first forecasts. Selective betting only when the evidence justifies it.</p>
<div class="grid"><section class="card"><div class="small">LIVE FIXTURES</div><h2 id="fixtures">Not connected</h2><p class="muted">No placeholder fixtures are shown.</p></section><section class="card"><div class="small">VERIFIED HISTORY</div><h2 id="history">Not loaded</h2><p class="muted">Counts will only include reconciled settled results.</p></section><section class="card"><div class="small">DURABLE STORAGE</div><h2 id="storage">Checking…</h2><p class="muted" id="storage-detail">Checking PostgreSQL observation storage.</p></section><section class="card"><div class="small">MODEL READINESS</div><h2>Not calibrated</h2><p class="muted">Baseline code is not a proven betting model.</p></section></div>
<section class="card"><h2>Provider connections</h2><p class="muted">A configured secret is not proof that an API call works. Each provider remains disconnected until its contract, live response and data validation pass.</p><div id="providers">Loading provider status…</div></section>
<section class="card" style="margin-top:14px"><h2>Run live fixture check</h2><p class="muted">This makes on-demand calls to SportAPI.ai, Sportmonks and API-Football if credentials are configured. Returned records remain unverified until canonical identity checks and persistence are connected.</p><div class="row"><label for="fixture-date">UTC calendar date</label><input id="fixture-date" type="date"><label for="provider-token">Diagnostics token (when configured)</label><input id="provider-token" type="password" autocomplete="off"><button id="fetch-fixtures">Check providers</button></div><pre id="fixture-check" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No provider check run yet.</pre></section>
<section class="card" style="margin-top:14px"><h2>Historical results backfill</h2>
<p class="muted">Fetch past fixtures/results from all configured providers. Each request is limited to seven completed UTC calendar days. Only finished scores independently corroborated by at least two providers are promoted to verified history. This can use provider quota.</p>
<div class="row"><label for="history-from">From (UTC)</label><input id="history-from" type="date"><label for="history-to">To (UTC)</label><input id="history-to" type="date"><button id="fetch-history">Backfill range</button></div>
<pre id="history-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No historical backfill run yet.</pre>
</section>
<section class="card" style="margin-top:14px"><h2>Import pending BetMatrix tickets</h2>
<p class="muted">Paste a pending-ticket export from BetMatrix as one ticket object, an array, or an object containing a <code>tickets</code> array. This is a controlled import, not an automatic connection to BetMatrix. Tickets are imported only when every provider fixture ID resolves to the same current corroborated canonical fixture. Source result status and odds are not trusted.</p>
<textarea id="betmatrix-json" rows="8" style="width:100%;box-sizing:border-box;font-family:monospace" placeholder='Paste BetMatrix JSON here — no example ticket is preloaded.'></textarea>
<div class="row"><button id="import-betmatrix-tickets">Validate and import pending tickets</button><button id="refresh-tickets">Refresh saved tickets</button><button id="reconcile-tickets">Reconcile pending tickets now</button></div>
<pre id="betmatrix-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No BetMatrix import run yet.</pre>
<h3>Saved tickets and settlement</h3>
<pre id="tickets-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No saved tickets loaded yet.</pre>
</section>
<section class="card" style="margin-top:14px"><h2>Favourite-team identity discovery</h2><p class="muted">Searches the 80 saved favourites in small, rate-limited batches. Exact name/alias plus matching country from both providers is required before a provider identity is confirmed. This does not create historical match results.</p><div class="row"><button id="discover-teams">Discover favourite teams</button><span id="team-discovery-progress" class="small">Not started</span></div><pre id="team-discovery-log" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">Ready when PostgreSQL and provider credentials are configured.</pre></section>
<section class="card" style="margin-top:14px"><h2>Review SportAPI.ai team identities</h2>
<p class="muted">SportAPI.ai catalogue candidates are not auto-confirmed. Load the latest saved candidates, check the name, country and squad category, and explicitly approve one identity. This only enables fixture identity matching; it does not verify results or calibrate forecasts.</p>
<div class="row"><label for="sportapi-review-team">Favourite team</label><select id="sportapi-review-team">${teamSeed.teams.map(team => '<option value="' + escapeHtml(team.id) + '">' + escapeHtml(team.canonicalName) + ' — ' + escapeHtml(team.country ?? "Country unknown") + '</option>').join("")}</select><button id="load-sportapi-candidates">Load saved candidates</button><button id="replay-reviewed-observations">Replay stored observations</button></div>
<div class="row"><label for="sportapi-review-candidate">SportAPI.ai candidate</label><select id="sportapi-review-candidate"><option value="">Load candidates first</option></select><label for="sportapi-reviewer">Reviewer audit label</label><input id="sportapi-reviewer" type="text" maxlength="160" placeholder="Your initials or reviewer ID"><button id="confirm-sportapi-candidate">Confirm identity</button></div>
<pre id="sportapi-review-log" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No SportAPI identity review loaded yet.</pre></section>
<section class="card" style="margin-top:14px"><h2>Prediction engine</h2>
<p class="muted">Select a canonical fixture key from <code>/api/fixtures</code>. The engine reads only verified historical results from PostgreSQL; it does not accept manually supplied statistics. Any missing evidence is reported as a withheld forecast.</p>
<div class="row"><label for="prediction-fixture-key">Canonical fixture key</label><input id="prediction-fixture-key" type="text" placeholder="Paste canonical_key from /api/fixtures"><button id="run-prediction">Run forecast</button></div>
<pre id="prediction-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No prediction requested.</pre>
<p class="small">Team mappings must be reviewed and saved before forecasting. Enter the exact canonical fixture team name and a stable team ID that you have verified.</p>
<div class="row"><label for="mapping-team-id">Reviewed team ID</label><input id="mapping-team-id" type="text" placeholder="Verified stable ID"><label for="mapping-canonical-name">Exact canonical name</label><input id="mapping-canonical-name" type="text" placeholder="Exact name from fixture"><label for="mapping-reviewed-by">Reviewed by</label><input id="mapping-reviewed-by" type="text" placeholder="Reviewer identifier"><button id="save-team-mapping">Save mapping</button></div>
<pre id="mapping-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">Mappings require the diagnostics token in production.</pre>
<p class="small">If a provider spells the same club differently, add the variant only after you have verified that it is the same team. Aliases are exact reviewed mappings, not fuzzy guesses.</p>
<div class="row"><label for="alias-team-id">Existing reviewed team ID</label><input id="alias-team-id" type="text" placeholder="Same stable team ID"><label for="alias-name">Verified name variant</label><input id="alias-name" type="text" placeholder="Exact provider variant"><label for="alias-reviewed-by">Reviewed by</label><input id="alias-reviewed-by" type="text" placeholder="Reviewer identifier"><button id="save-team-alias">Save alias</button><button id="list-team-aliases">List aliases</button></div>
<pre id="alias-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No reviewed aliases loaded.</pre>
</section>
<section class="card" style="margin-top:14px"><h2>Chronological model evaluation</h2>
<p class="muted">Evaluates saved pre-kickoff forecasts against later verified results. It reports no performance metrics until at least 30 eligible fixture/model samples exist. These metrics do not approve betting recommendations.</p>
<div class="row"><button id="refresh-evaluation">Check evaluation readiness</button><span id="evaluation-state" class="status">Not checked</span></div>
<pre id="evaluation-output" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No evaluation check run yet.</pre>
</section>
<section class="card" style="margin-top:14px"><h2>Integrity rules</h2><ul><li>Unknown data stays unknown; it is never replaced with zero or a guess.</li><li>Conflicting fixture identity or results are flagged, not silently selected.</li><li>Forecast probabilities and betting decisions are separate.</li><li>No recommendations until verified data, calibration, fresh odds and risk gates pass.</li></ul><p class="small">This foundation is not yet a live prediction service. Status is intentionally honest.</p></section>
<script>async function load(){try{const [p,f,h,s]=await Promise.all([fetch('/api/providers/status').then(r=>r.json()),fetch('/api/fixtures').then(r=>r.json()),fetch('/api/history/status').then(r=>r.json()),fetch('/api/storage/status').then(r=>r.json()).catch(()=>({state:'error',errorCode:'status_unavailable'}))]);document.getElementById('fixtures').textContent=f.count+' corroborated fixtures';document.getElementById('history').textContent=h.seededTeamNames+' teams · '+(h.canonicalTeamMappings||0)+' mapped · '+h.verifiedSettledResults+' verified results';document.getElementById('storage').textContent=s.state==='ready'?'Connected':s.state==='not_configured'?'Not configured':'Unavailable';document.getElementById('storage-detail').textContent=s.state==='ready'?s.observationCount+' observations saved':(s.errorCode||'Configure DATABASE_URL to persist observations');const discovery=h.teamSearchProgress||{};const discoveryProgress=document.getElementById('team-discovery-progress');const discoveryLog=document.getElementById('team-discovery-log');if(discovery.state==='ready'){const searched=Number(discovery.searchedTeams)||0,total=Number(discovery.totalTeams)||Number(h.seededTeamNames)||80,candidates=Number(discovery.candidateCount)||0;discoveryProgress.textContent=searched===0?'Not started':searched+'/'+total+' searched';discoveryLog.textContent=searched===0?'No saved team-search results yet. Start discovery to search favourites in rate-limited batches.':searched+' of '+total+' favourites have saved search records; '+candidates+' provider candidates found. This is saved discovery progress, not confirmation of every team identity or verified match history.'}else{discoveryProgress.textContent='Unavailable';discoveryLog.textContent='Saved discovery status is unavailable ('+(discovery.state||'unknown')+'). Check database configuration before starting another search.'}document.getElementById('providers').innerHTML=p.providers.map(x=>'<div class="row"><span><strong>'+x.name+'</strong><br><span class="small">'+x.priority+' · credential '+(x.credentialConfigured?'configured':'missing')+' · '+x.integrationState+'</span></span><span class="status">'+x.diagnostics.state+'</span></div>').join('')}catch(e){document.getElementById('providers').textContent='Status API unavailable.'}}document.getElementById('fixture-date').value=new Date().toISOString().slice(0,10);
document.getElementById('history-to').value=new Date(Date.now()-86400000).toISOString().slice(0,10);
document.getElementById('history-from').value=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
document.getElementById('fetch-history').addEventListener('click',async()=>{
 const from=document.getElementById('history-from').value,to=document.getElementById('history-to').value;
 const out=document.getElementById('history-output'),button=document.getElementById('fetch-history'),token=document.getElementById('provider-token').value;
 if(!from||!to){out.textContent='Choose both a start and end date.';return}
 button.disabled=true;out.textContent='Fetching historical observations and reconciling verified results…';
 try{
  const r=await fetch('/api/providers/history?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to),{headers:token?{'x-provider-diagnostics-token':token}:{}});
  const data=await r.json();
  out.textContent=JSON.stringify({state:data.state,range:data.range,candidateCount:data.candidateCount,candidateCountsByProvider:data.candidateCountsByProvider,candidateCountsByStatus:data.candidateCountsByStatus,corroboratedFixtures:data.corroboratedFixtures,verifiedSettledResults:data.verifiedSettledResults,conflictedGroups:data.conflictedGroups,ticketSettlement:data.ticketSettlement,persistence:data.persistence,canonicalEvidence:data.canonicalEvidence,reconciliation:data.reconciliation,reason:data.reason},null,2);
  if(r.ok)load();
 }catch(e){out.textContent='Historical backfill request failed. No data is assumed to have been saved.'}
 finally{button.disabled=false}
});
async function refreshSavedTickets(){
 const out=document.getElementById('tickets-output'),token=document.getElementById('provider-token').value;
 out.textContent='Loading saved tickets and settlement states…';
 try{
  const response=await fetch('/api/tickets?limit=50',{headers:token?{'x-provider-diagnostics-token':token}:{}});
  const data=await response.json();
  out.textContent=JSON.stringify({
   state:data.state,
   count:(data.tickets||[]).length,
   tickets:(data.tickets||[]).map(ticket=>({
    ticket_id:ticket.ticket_id,status:ticket.status,stake_amount:ticket.stake_amount,
    potential_payout:ticket.potential_payout,selections:ticket.selections,
    settlement:ticket.settlement,updated_at:ticket.updated_at
   })),
   reason:data.reason,
   note:'Ticket states use verified settled results only. A lost selection makes an accumulator lost immediately; unresolved or unverified selections remain pending.'
  },null,2);
 }catch(error){out.textContent='Could not load saved tickets. No settlement is assumed: '+String(error)}
}
document.getElementById('refresh-tickets').addEventListener('click',async()=>{
 const button=document.getElementById('refresh-tickets');button.disabled=true;
 try{await refreshSavedTickets()}finally{button.disabled=false}
});
document.getElementById('import-betmatrix-tickets').addEventListener('click',async()=>{
 const button=document.getElementById('import-betmatrix-tickets'),out=document.getElementById('betmatrix-output');
 const token=document.getElementById('provider-token').value,source=document.getElementById('betmatrix-json').value.trim();
 if(!source){out.textContent='Paste the BetMatrix pending-ticket JSON first. Nothing was sent.';return}
 let parsed;
 try{parsed=JSON.parse(source)}catch{out.textContent='The pasted content is not valid JSON. Nothing was sent.';return}
 const tickets=Array.isArray(parsed)?parsed:(parsed&&typeof parsed==='object'&&Array.isArray(parsed.tickets)?parsed.tickets:(parsed&&typeof parsed==='object'?[parsed]:null));
 if(!tickets||tickets.length===0){out.textContent='JSON must contain at least one ticket object. Nothing was sent.';return}
 if(tickets.length>50){out.textContent='Import is limited to 50 tickets per request. Split the export into smaller batches.';return}
 button.disabled=true;out.textContent='Validating pending tickets against reviewed canonical fixture references…';
 try{
  const response=await fetch('/api/tickets/import-betmatrix',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-provider-diagnostics-token':token}:{})},body:JSON.stringify({tickets})});
  const data=await response.json();
  out.textContent=JSON.stringify(data,null,2);
  if(response.ok&&data.state==='completed'){
   await refreshSavedTickets();
  }
 }catch(error){out.textContent='BetMatrix import request failed. Check the response before retrying to avoid duplicate submissions: '+String(error)}
 finally{button.disabled=false}
});
document.getElementById('reconcile-tickets').addEventListener('click',async()=>{
 const button=document.getElementById('reconcile-tickets'),out=document.getElementById('betmatrix-output');
 const token=document.getElementById('provider-token').value;
 button.disabled=true;out.textContent='Reconciling pending tickets against verified settled results only…';
 try{
  const response=await fetch('/api/tickets/reconcile',{method:'POST',headers:token?{'x-provider-diagnostics-token':token}:{}});
  const data=await response.json();
  out.textContent=JSON.stringify(data,null,2);
  if(response.ok)await refreshSavedTickets();
 }catch(error){out.textContent='Ticket reconciliation request failed; no result is assumed: '+String(error)}
 finally{button.disabled=false}
});
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
document.getElementById('save-team-alias').addEventListener('click',async()=>{
 const out=document.getElementById('alias-output'),token=document.getElementById('provider-token').value;
 const body={teamId:document.getElementById('alias-team-id').value.trim(),alias:document.getElementById('alias-name').value.trim(),reviewedBy:document.getElementById('alias-reviewed-by').value.trim()};
 out.textContent='Saving explicitly reviewed alias…';
 try{
  const response=await fetch('/api/predictions/team-aliases',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-provider-diagnostics-token':token}:{})},body:JSON.stringify(body)});
  out.textContent=JSON.stringify(await response.json(),null,2);
 }catch(e){out.textContent='Alias request failed. No alias was confirmed.'}
});
document.getElementById('list-team-aliases').addEventListener('click',async()=>{
 const out=document.getElementById('alias-output');out.textContent='Loading reviewed aliases…';
 try{const response=await fetch('/api/predictions/team-aliases');out.textContent=JSON.stringify(await response.json(),null,2)}
 catch(e){out.textContent='Could not load reviewed aliases.'}
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
document.getElementById('fetch-fixtures').addEventListener('click',async()=>{const date=document.getElementById('fixture-date').value;const out=document.getElementById('fixture-check');out.textContent='Checking providers…';try{const token=document.getElementById('provider-token').value;const r=await fetch('/api/providers/fixtures?date='+encodeURIComponent(date),{headers:token?{'x-provider-diagnostics-token':token}:{}});const data=await r.json();if(data.candidateCount!==undefined){out.textContent=JSON.stringify({state:data.state,date:data.date,candidateCount:data.candidateCount,canonicalFixturesCorroborated:data.canonicalFixturesCorroborated,verifiedResultsCreatedOrConfirmed:data.verifiedResultsCreatedOrConfirmed,conflictedGroups:data.conflictedGroups,canonicalEvidence:data.canonicalEvidence,persistence:data.persistence,cache:data.cache,cachedAt:data.cachedAt,retrievedAt:data.retrievedAt,candidateCountsByProvider:data.candidateCountsByProvider,candidateCountsByStatus:data.candidateCountsByStatus,reconciliationSummary:data.reconciliationSummary,providers:(data.providers||[]).map(p=>({name:p.name,state:p.diagnostics?.state,attemptedAt:p.diagnostics?.lastAttemptAt,succeededAt:p.diagnostics?.lastSuccessAt,records:p.diagnostics?.lastRecordCount,accepted:p.diagnostics?.lastAcceptedCount,rejected:p.diagnostics?.lastRejectedCount,rejectionReasons:p.diagnostics?.lastRejectionReasons,httpStatus:p.diagnostics?.lastHttpStatus,responseShape:p.diagnostics?.lastResponseShape,error:p.diagnostics?.lastErrorCode})),sampleCandidates:(data.sampleCandidates||[]).slice(0,5)},null,2);try{const s=await fetch('/api/storage/status').then(r=>r.json());document.getElementById('storage').textContent=s.state==='ready'?'Connected':s.state==='not_configured'?'Not configured':'Unavailable';document.getElementById('storage-detail').textContent=s.state==='ready'?s.observationCount+' observations saved':(s.errorCode||'Configure DATABASE_URL to persist observations')}catch{document.getElementById('storage-detail').textContent='Could not refresh storage status'}}else{out.textContent=JSON.stringify(data,null,2)}}catch(e){out.textContent='Provider check failed. Inspect server diagnostics.'}});document.getElementById('refresh-evaluation').addEventListener('click',async()=>{
 const button=document.getElementById('refresh-evaluation'),state=document.getElementById('evaluation-state'),out=document.getElementById('evaluation-output');
 button.disabled=true;state.textContent='Checking';out.textContent='Loading saved forecasts and verified outcomes…';
 try{
  const r=await fetch('/api/evaluation/out-of-sample'),data=await r.json();
  state.textContent=data.state==='ready'?(data.evaluation?.state==='evaluated'?'Evaluated':'Insufficient sample'):String(data.state||'Unavailable');
  const evaluation=data.evaluation;
  out.textContent=JSON.stringify({
   state:data.state,evaluationState:evaluation?.state,method:evaluation?.method,
   storedForecastCount:data.storedForecastCount,joinedSettledCandidateCount:data.joinedSettledCandidateCount,
   sampleSize:evaluation?.sampleSize,minimumSampleSize:evaluation?.minimumSampleSize,
   brierScore:evaluation?.brierScore??null,logLoss:evaluation?.logLoss??null,accuracy:evaluation?.accuracy??null,
   recommendationEnabled:data.recommendationEnabled,note:data.note||evaluation?.note,reason:data.reason
  },null,2);
 }catch(e){state.textContent='Unavailable';out.textContent='Evaluation endpoint unavailable. No performance metrics are inferred.'}
 finally{button.disabled=false}
});
document.getElementById('load-sportapi-candidates').addEventListener('click',async()=>{
 const button=document.getElementById('load-sportapi-candidates'),teamId=document.getElementById('sportapi-review-team').value;
 const candidateSelect=document.getElementById('sportapi-review-candidate'),out=document.getElementById('sportapi-review-log'),token=document.getElementById('provider-token').value;
 button.disabled=true;out.textContent='Loading saved SportAPI.ai candidates…';
 try{
  const response=await fetch('/api/teams/provider-search/results',{headers:token?{'x-provider-diagnostics-token':token}:{}});
  const data=await response.json();
  if(!response.ok||data.state!=='ready')throw new Error(data.reason||data.errorCode||data.state||'provider_search_results_unavailable');
  const team=(data.teams||[]).find(item=>item.trackedTeamId===teamId);
  const provider=(team?.providers||[]).find(item=>item.provider==='sportapi-ai');
  const review=(data.candidateReview||[]).find(item=>item.trackedTeamId===teamId);
  const assessments=review?.assessments||[];
  candidateSelect.innerHTML='';
  const candidates=provider?.candidates||[];
  if(!candidates.length){
   const option=document.createElement('option');option.value='';option.textContent='No saved candidates for this team';candidateSelect.appendChild(option);
   out.textContent=JSON.stringify({state:'no_candidates',trackedTeamId:teamId,providerState:provider?.state||'never_searched',note:'Run favourite-team discovery first. An empty search is not proof the team is invalid.'},null,2);return;
  }
  for(const candidate of candidates){
   const assessment=assessments.find(item=>item.provider==='sportapi-ai'&&item.providerTeamId===candidate.providerTeamId);
   const option=document.createElement('option');option.value=candidate.providerTeamId;
   option.dataset.reviewState=assessment?.reviewState||'needs_review';
   option.textContent=[candidate.name,candidate.country||'country unknown',candidate.league||'league unknown',candidate.gender||candidate.teamType||'',assessment?.reviewState||'needs_review',candidate.providerTeamId].filter(Boolean).join(' | ');
   candidateSelect.appendChild(option);
  }
  out.textContent=JSON.stringify({trackedTeamId:teamId,canonicalName:team.canonicalName,providerState:provider?.state,candidates:candidates.map(candidate=>({providerTeamId:candidate.providerTeamId,name:candidate.name,country:candidate.country||null,league:candidate.league||null,gender:candidate.gender||null,teamType:candidate.teamType||null,assessment:assessments.find(item=>item.provider==='sportapi-ai'&&item.providerTeamId===candidate.providerTeamId)||null}))},null,2);
 }catch(error){out.textContent='Could not load saved candidates: '+String(error)}
 finally{button.disabled=false}
});
document.getElementById('replay-reviewed-observations').addEventListener('click',async()=>{
 const button=document.getElementById('replay-reviewed-observations'),out=document.getElementById('sportapi-review-log'),token=document.getElementById('provider-token').value;
 button.disabled=true;out.textContent='Replaying stored observations. This makes no provider API calls…';
 try{
  const response=await fetch('/api/history/replay',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-provider-diagnostics-token':token}:{})},body:'{}'});
  const data=await response.json();out.textContent=JSON.stringify(data,null,2);
  if(response.ok)await load();
 }catch(error){out.textContent='Stored-observation replay failed. No provider API calls were made: '+String(error)}
 finally{button.disabled=false}
});
document.getElementById('confirm-sportapi-candidate').addEventListener('click',async()=>{
 const button=document.getElementById('confirm-sportapi-candidate'),teamId=document.getElementById('sportapi-review-team').value;
 const candidateSelect=document.getElementById('sportapi-review-candidate'),providerTeamId=candidateSelect.value;
 const reviewer=document.getElementById('sportapi-reviewer').value.trim(),out=document.getElementById('sportapi-review-log'),token=document.getElementById('provider-token').value;
 if(!providerTeamId||!reviewer){out.textContent='Select a saved candidate and enter a reviewer identifier. No mapping was saved.';return}
 const selected=candidateSelect.options[candidateSelect.selectedIndex];
 if(selected?.dataset.reviewState!=='candidate_matches_watchlist_context'){
  out.textContent='This candidate does not have a confirmed name/country/squad-category match. Review the assessment and do not force an unsafe identity. No mapping was saved.';return;
 }
 button.disabled=true;out.textContent='Saving explicit SportAPI identity review…';
 try{
  const response=await fetch('/api/teams/provider-search/review-sportapi',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-provider-diagnostics-token':token}:{})},body:JSON.stringify({trackedTeamId:teamId,providerTeamId,reviewedBy:reviewer})});
  const data=await response.json();out.textContent=JSON.stringify(data,null,2);
  if(response.ok){await load();await document.getElementById('load-sportapi-candidates').click()}
 }catch(error){out.textContent='Identity review request failed. No mapping is assumed to have been saved: '+String(error)}
 finally{button.disabled=false}
});
load();</script>
</main></body></html>`));

/**
 * Optional bounded background ingestion keeps verified result evidence current so
 * pending tickets can settle without someone manually opening the provider page.
 * The status endpoint reports execution separately from evidence availability.
 */
const autoPollingEnabled = process.env.AUTO_PROVIDER_POLLING_ENABLED?.trim().toLowerCase() === "true";
const autoPollingMinutes = Number(process.env.AUTO_PROVIDER_POLL_INTERVAL_MINUTES ?? 10);
type AutomaticPollState = "disabled" | "not_started" | "running" | "completed" | "completed_empty" | "partial" | "error";
const automaticPollStatus: {
  state: AutomaticPollState;
  startedAt: string | null;
  completedAt: string | null;
  cyclesCompleted: number;
  datesChecked: string[];
  candidateCount: number | null;
  corroboratedFixtures: number | null;
  verifiedResults: number | null;
  observationPersistenceState: string | null;
  canonicalPersistenceState: string | null;
  ticketSettlementState: string | null;
  failedDateCount: number;
  lastErrorCode: string | null;
} = {
  state: autoPollingEnabled ? "not_started" : "disabled",
  startedAt: null, completedAt: null, cyclesCompleted: 0, datesChecked: [],
  candidateCount: null, corroboratedFixtures: null, verifiedResults: null,
  observationPersistenceState: null, canonicalPersistenceState: null, ticketSettlementState: null,
  failedDateCount: 0, lastErrorCode: null
};
let automaticPollInProgress = false;

async function runAutomaticProviderPoll(): Promise<void> {
  if (automaticPollInProgress) return;
  automaticPollInProgress = true;
  automaticPollStatus.state = "running";
  automaticPollStatus.startedAt = new Date().toISOString();
  automaticPollStatus.completedAt = null;
  automaticPollStatus.datesChecked = [];
  automaticPollStatus.candidateCount = 0;
  automaticPollStatus.corroboratedFixtures = 0;
  automaticPollStatus.verifiedResults = 0;
  automaticPollStatus.observationPersistenceState = null;
  automaticPollStatus.canonicalPersistenceState = null;
  automaticPollStatus.ticketSettlementState = null;
  automaticPollStatus.failedDateCount = 0;
  automaticPollStatus.lastErrorCode = null;
  try {
    if (!process.env.DATABASE_URL?.trim()) {
      automaticPollStatus.state = "error";
      automaticPollStatus.lastErrorCode = "database_not_configured";
      return;
    }
    const dates = new Set<string>();
    const now = new Date();
    for (const offset of [0, 1]) {
      const day = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
      dates.add(day.toISOString().slice(0, 10));
    }
    for (const date of dates) {
      automaticPollStatus.datesChecked.push(date);
      try {
        const query = { dateFromUtc: date, dateToUtc: date };
        const batches = await Promise.all([
          sportApiAiProvider.fetchFixtures(query),
          sportmonksProvider.fetchFixtures(query),
          apiFootballProvider.fetchFixtures(query)
        ]);
        const candidates = batches.flat();
        automaticPollStatus.candidateCount = (automaticPollStatus.candidateCount ?? 0) + candidates.length;
        if (candidates.length > 0) {
          const persistence = await persistProviderObservations(candidates);
          const canonical = await persistCanonicalEvidence(candidates);
          automaticPollStatus.observationPersistenceState = persistence.state;
          automaticPollStatus.canonicalPersistenceState = canonical.state;
          automaticPollStatus.corroboratedFixtures = (automaticPollStatus.corroboratedFixtures ?? 0) + canonical.corroboratedFixtures;
          automaticPollStatus.verifiedResults = (automaticPollStatus.verifiedResults ?? 0) + canonical.verifiedResults;
          if (!["saved", "connected_empty"].includes(persistence.state) || !["saved", "connected_empty"].includes(canonical.state)) {
            automaticPollStatus.failedDateCount += 1;
            automaticPollStatus.lastErrorCode = "provider_poll_persistence_not_ready";
          }
        }
        // Empty responses can still reconcile tickets against previously verified results.
        const settlement = await reconcilePendingTickets();
        automaticPollStatus.ticketSettlementState = typeof settlement === "object" && settlement !== null && "state" in settlement
          ? String((settlement as { state: unknown }).state) : "completed";
      } catch {
        automaticPollStatus.failedDateCount += 1;
        automaticPollStatus.lastErrorCode = "provider_poll_date_failed";
      }
    }
    automaticPollStatus.state = automaticPollStatus.failedDateCount > 0
      ? (automaticPollStatus.failedDateCount === automaticPollStatus.datesChecked.length ? "error" : "partial")
      : (automaticPollStatus.candidateCount === 0 ? "completed_empty" : "completed");
    automaticPollStatus.cyclesCompleted += 1;
  } catch {
    automaticPollStatus.state = "error";
    automaticPollStatus.lastErrorCode = automaticPollStatus.lastErrorCode ?? "provider_poll_cycle_failed";
  } finally {
    automaticPollStatus.completedAt = new Date().toISOString();
    automaticPollInProgress = false;
  }
}

if (autoPollingEnabled && (!Number.isInteger(autoPollingMinutes) || autoPollingMinutes < 5 || autoPollingMinutes > 60)) {
  automaticPollStatus.state = "disabled";
  automaticPollStatus.lastErrorCode = "invalid_poll_interval";
  console.error("Automatic provider polling disabled: AUTO_PROVIDER_POLL_INTERVAL_MINUTES must be an integer from 5 to 60.");
}
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Unified Football Intelligence listening on ${port}`);
  if (autoPollingEnabled && Number.isInteger(autoPollingMinutes) && autoPollingMinutes >= 5 && autoPollingMinutes <= 60) {
    console.log(`Automatic provider polling enabled with a ${autoPollingMinutes}-minute interval.`);
    void runAutomaticProviderPoll();
    setInterval(() => { void runAutomaticProviderPoll(); }, autoPollingMinutes * 60_000).unref();
  }
});
