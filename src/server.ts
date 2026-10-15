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
import { getCanonicalEvidenceSummary, getObservationStoreStatus, getObservationStoreSummary, getTeamRegistrySummary, persistCanonicalEvidence, persistProviderObservations, replayStoredProviderObservations, saveProviderTeamMapping, syncTrackedTeamRegistry } from "./storage/postgresObservations.js";

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


app.get("/api/teams/registry", async (_req: Request, res: Response) => {
  const seeded = await syncTrackedTeamRegistry(teamSeed.teams);
  const summary = seeded.state === "ready" ? seeded : await getTeamRegistrySummary();
  return res.status(summary.state === "error" ? 503 : 200).json({
    ...summary,
    note: "Only explicitly reviewed provider IDs count as mappings. Seeded names and unreviewed aliases are not proof of identity."
  });
});

app.post("/api/teams/mappings", async (req: Request, res: Response) => {
  const configuredToken = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim() ?? "";
  const providedToken = req.get("x-provider-diagnostics-token") ?? "";
  if (!configuredToken && !["development", "test"].includes(process.env.NODE_ENV ?? "")) {
    return res.status(503).json({ state: "disabled", reason: "provider_diagnostics_token_not_configured" });
  }
  if (configuredToken && !safeTokenEquals(providedToken, configuredToken)) {
    return res.status(401).json({ state: "unauthorized", reason: "provider_diagnostics_token_required" });
  }
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object" ||
      typeof body.teamId !== "string" || typeof body.provider !== "string" ||
      typeof body.providerTeamId !== "string" || typeof body.providerTeamName !== "string" ||
      (body.confirmAlias !== undefined && typeof body.confirmAlias !== "boolean")) {
    return res.status(400).json({ state: "invalid", errorCode: "invalid_mapping_request" });
  }
  const seeded = await syncTrackedTeamRegistry(teamSeed.teams);
  if (seeded.state !== "ready") {
    return res.status(503).json({ state: seeded.state, errorCode: seeded.errorCode ?? "team_registry_unavailable" });
  }
  const result = await saveProviderTeamMapping({
    teamId: body.teamId, provider: body.provider, providerTeamId: body.providerTeamId,
    providerTeamName: body.providerTeamName, confirmAlias: body.confirmAlias === true
  });
  const status = result.state === "saved" ? 200 :
    result.state === "invalid" ? 400 : result.state === "conflict" ? 409 : 503;
  return res.status(status).json(result);
});

app.get("/api/teams/watchlist", (_req: Request, res: Response) => res.json({
  source: teamSeed.source,
  count: teamSeed.count,
  mappingState: "unresolved",
  note: teamSeed.warning,
  teams: teamSeed.teams
}));

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
  const [evidence, seededRegistry] = await Promise.all([
    getCanonicalEvidenceSummary(), syncTrackedTeamRegistry(teamSeed.teams)
  ]);
  const registry = seededRegistry.state === "ready" ? seededRegistry : await getTeamRegistrySummary();
  const reasons = [
    ...(evidence.state === "ready" ? [] : [evidence.errorCode ?? "canonical_evidence_store_not_ready"]),
    ...(registry.state === "ready" ? [] : [registry.errorCode ?? "team_registry_store_not_ready"])
  ];
  return res.status(evidence.state === "error" || registry.state === "error" ? 503 : 200).json({
    state: evidence.state === "ready" ? "canonical_evidence" : evidence.state,
    seededTeamNames: teamSeed.count,
    canonicalTeamMappings: registry.providerMappings,
    mappedTeams: registry.mappedTeams,
    unresolvedTeams: registry.unresolvedTeams,
    teamMappingState: registry.state === "ready" ? (registry.providerMappings ? "partially_mapped" : "awaiting_review") : registry.state,
    canonicalFixtures: evidence.corroboratedFixtureCount ?? 0,
    verifiedSettledResults: evidence.verifiedSettledResultCount ?? 0,
    conflictedFixtures: evidence.conflictedFixtureCount ?? 0,
    staleLiveFixtures: evidence.staleLiveFixtureCount ?? 0,
    reasons
  });
});

app.get("/", (_req: Request, res: Response) => res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unified Football Intelligence</title>
<style>body{margin:0;background:#0b1220;color:#e8eef9;font:16px system-ui}main{max-width:1000px;margin:auto;padding:32px 20px}h1{margin-bottom:6px}.muted{color:#9baac2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:24px 0}.card{background:#121e31;border:1px solid #2a3a54;border-radius:12px;padding:18px}.status{font-weight:700;color:#f2c879}.row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #2a3a54;padding:12px 0}.small{font-size:13px;color:#9baac2}code{color:#9ed7ff}</style></head>
<body><main><p class="small">GREENFIELD PLATFORM · FOUNDATION BUILD</p><h1>Unified Football Intelligence</h1><p class="muted">Broad fixture monitoring. Deep team histories. Evidence-first forecasts. Selective betting only when the evidence justifies it.</p>
<div class="grid"><section class="card"><div class="small">LIVE FIXTURES</div><h2 id="fixtures">Not connected</h2><p class="muted">No placeholder fixtures are shown.</p></section><section class="card"><div class="small">VERIFIED HISTORY</div><h2 id="history">Not loaded</h2><p class="muted">Counts will only include reconciled settled results.</p></section><section class="card"><div class="small">DURABLE STORAGE</div><h2 id="storage">Checking…</h2><p class="muted" id="storage-detail">Checking PostgreSQL observation storage.</p></section><section class="card"><div class="small">MODEL READINESS</div><h2>Not calibrated</h2><p class="muted">Baseline code is not a proven betting model.</p></section></div>
<section class="card"><h2>Provider connections</h2><p class="muted">A configured secret is not proof that an API call works. Each provider remains disconnected until its contract, live response and data validation pass.</p><div id="providers">Loading provider status…</div></section>
<section class="card" style="margin-top:14px"><h2>Run live fixture check</h2><p class="muted">This makes on-demand calls to SportAPI.ai, Sportmonks and API-Football if credentials are configured. Returned records remain unverified until canonical identity checks and persistence are connected.</p><div class="row"><label for="fixture-date">UTC calendar date</label><input id="fixture-date" type="date"><label for="provider-token">Diagnostics token (when configured)</label><input id="provider-token" type="password" autocomplete="off"><button id="fetch-fixtures">Check providers</button></div><pre id="fixture-check" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">No provider check run yet.</pre></section>
<section class="card" style="margin-top:14px"><h2>Integrity rules</h2><ul><li>Unknown data stays unknown; it is never replaced with zero or a guess.</li><li>Conflicting fixture identity or results are flagged, not silently selected.</li><li>Forecast probabilities and betting decisions are separate.</li><li>No recommendations until verified data, calibration, fresh odds and risk gates pass.</li></ul><p class="small">This foundation is not yet a live prediction service. Status is intentionally honest.</p></section>
<script>async function load(){try{const [p,f,h,s]=await Promise.all([fetch('/api/providers/status').then(r=>r.json()),fetch('/api/fixtures').then(r=>r.json()),fetch('/api/history/status').then(r=>r.json()),fetch('/api/storage/status').then(r=>r.json()).catch(()=>({state:'error',errorCode:'status_unavailable'}))]);document.getElementById('fixtures').textContent=f.count+' corroborated fixtures';document.getElementById('history').textContent=h.seededTeamNames+' team names · '+h.verifiedSettledResults+' verified results';document.getElementById('storage').textContent=s.state==='ready'?'Connected':s.state==='not_configured'?'Not configured':'Unavailable';document.getElementById('storage-detail').textContent=s.state==='ready'?s.observationCount+' observations saved':(s.errorCode||'Configure DATABASE_URL to persist observations');document.getElementById('providers').innerHTML=p.providers.map(x=>'<div class="row"><span><strong>'+x.name+'</strong><br><span class="small">'+x.priority+' · credential '+(x.credentialConfigured?'configured':'missing')+' · '+x.integrationState+'</span></span><span class="status">'+x.diagnostics.state+'</span></div>').join('')}catch(e){document.getElementById('providers').textContent='Status API unavailable.'}}document.getElementById('fixture-date').value=new Date().toISOString().slice(0,10);document.getElementById('fetch-fixtures').addEventListener('click',async()=>{const date=document.getElementById('fixture-date').value;const out=document.getElementById('fixture-check');out.textContent='Checking providers…';try{const token=document.getElementById('provider-token').value;const r=await fetch('/api/providers/fixtures?date='+encodeURIComponent(date),{headers:token?{'x-provider-diagnostics-token':token}:{}});const data=await r.json();if(data.candidateCount!==undefined){out.textContent=JSON.stringify({state:data.state,date:data.date,candidateCount:data.candidateCount,canonicalFixturesCorroborated:data.canonicalFixturesCorroborated,verifiedResultsCreatedOrConfirmed:data.verifiedResultsCreatedOrConfirmed,conflictedGroups:data.conflictedGroups,canonicalEvidence:data.canonicalEvidence,persistence:data.persistence,cache:data.cache,cachedAt:data.cachedAt,retrievedAt:data.retrievedAt,candidateCountsByProvider:data.candidateCountsByProvider,candidateCountsByStatus:data.candidateCountsByStatus,reconciliationSummary:data.reconciliationSummary,providers:(data.providers||[]).map(p=>({name:p.name,state:p.diagnostics?.state,attemptedAt:p.diagnostics?.lastAttemptAt,succeededAt:p.diagnostics?.lastSuccessAt,records:p.diagnostics?.lastRecordCount,accepted:p.diagnostics?.lastAcceptedCount,rejected:p.diagnostics?.lastRejectedCount,rejectionReasons:p.diagnostics?.lastRejectionReasons,httpStatus:p.diagnostics?.lastHttpStatus,responseShape:p.diagnostics?.lastResponseShape,error:p.diagnostics?.lastErrorCode})),sampleCandidates:(data.sampleCandidates||[]).slice(0,5)},null,2);try{const s=await fetch('/api/storage/status').then(r=>r.json());document.getElementById('storage').textContent=s.state==='ready'?'Connected':s.state==='not_configured'?'Not configured':'Unavailable';document.getElementById('storage-detail').textContent=s.state==='ready'?s.observationCount+' observations saved':(s.errorCode||'Configure DATABASE_URL to persist observations')}catch{document.getElementById('storage-detail').textContent='Could not refresh storage status'}}else{out.textContent=JSON.stringify(data,null,2)}}catch(e){out.textContent='Provider check failed. Inspect server diagnostics.'}});load();</script>
</main></body></html>`));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Unified Football Intelligence listening on ${port}`));
