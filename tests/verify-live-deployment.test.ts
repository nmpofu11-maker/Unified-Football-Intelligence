import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLiveVerification, fetchLiveEndpoints } from "../scripts/verify-live-deployment.js";

const paths = [
  "/health",
  "/api/storage/status",
  "/api/storage/observations/summary",
  "/api/data-pipeline/status",
  "/api/predictions/status",
  "/api/history/status",
  "/api/teams/watchlist"
];

function healthyEndpoints() {
  const data: Record<string, unknown> = {
    "/health": { readiness: { database: true }, calibratedPredictionsAvailable: false, bettingRecommendationsEnabled: false },
    "/api/storage/status": { state: "ready" },
    "/api/storage/observations/summary": { state: "ready", totalObservations: 42 },
    "/api/data-pipeline/status": { stages: {
      providers: { state: "recent_success" },
      canonicalFixtures: { state: "available", corroboratedCount: 10 },
      verifiedResults: { state: "available", count: 12 },
      reviewedTeamMappings: { state: "ready", count: 8 }
    }},
    "/api/predictions/status": { state: "ready", teamMappingsState: "ready", calibratedForBetting: false, bettingRecommendationsEnabled: false },
    "/api/history/status": { state: "canonical_evidence", seededTeamNames: 80, canonicalFixtures: 10, verifiedSettledResults: 12 },
    "/api/teams/watchlist": { count: 80, teams: Array.from({length:80}, (_,i)=>({id:String(i+1)})) }
  };
  return paths.map(path => ({ path, httpStatus: 200, ok: true, data: data[path] }));
}

test("live verifier passes only when operational evidence stages are available and betting remains disabled", () => {
  const report = evaluateLiveVerification("https://example.test", healthyEndpoints());
  assert.equal(report.overall, "PASS");
  assert.equal(report.evidencePipelineReady, true);
  assert.equal(report.bettingRecommendationsEnabled, false);
});

test("live verifier warns when deployment is reachable but verified results are absent", () => {
  const endpoints = healthyEndpoints();
  const pipeline = endpoints.find(item => item.path === "/api/data-pipeline/status")!;
  (pipeline.data as any).stages.verifiedResults = { state: "empty", count: 0 };
  const report = evaluateLiveVerification("https://example.test", endpoints);
  assert.equal(report.overall, "WARN");
  assert.equal(report.evidencePipelineReady, false);
  assert.ok(report.nextActions.some(action => action.includes("historical results")));
});

test("live verifier fails when the authoritative watchlist count changes", () => {
  const endpoints = healthyEndpoints();
  const watchlist = endpoints.find(item => item.path === "/api/teams/watchlist")!;
  (watchlist.data as any).count = 79;
  const report = evaluateLiveVerification("https://example.test", endpoints);
  assert.equal(report.overall, "FAIL");
  assert.ok(report.checks.some(item => item.name === "authoritative-watchlist" && item.state === "fail"));
});

test("live endpoint fetch refuses non-local HTTP and never follows redirects", async () => {
  await assert.rejects(() => fetchLiveEndpoints("http://example.test"));
  let requested = 0;
  const results = await fetchLiveEndpoints("http://localhost:3000", (async (_input, init) => {
    requested++;
    assert.equal(init?.redirect, "error");
    return new Response("{}", {status:200,headers:{"content-type":"application/json"}});
  }) as typeof fetch);
  assert.equal(requested, paths.length);
  assert.ok(results.every(result => result.ok));
});
