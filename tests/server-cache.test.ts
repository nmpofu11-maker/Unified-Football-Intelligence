import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Test server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child server may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not become ready");
}

test("fixture endpoint distinguishes fresh provider checks from cache hits", { timeout: 15000 }, async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      // This endpoint test verifies cache semantics, not external PostgreSQL connectivity.
      // Isolate it from a developer .env so an unreachable remote DB cannot stall the test.
      DATABASE_URL: "",
      SPORTAPI_AI_KEY: "",
      SPORTAPI_API_KEY: "",
      SPORTMONKS_API_KEY: "",
      SPORTMONKS_API_TOKEN: "",
      API_FOOTBALL_KEY: ""
    },
    stdio: "ignore"
  });
  try {
    await waitForHealth(`${baseUrl}/health`, child);
    const dashboardResponse = await fetch(baseUrl);
    const dashboardHtml = await dashboardResponse.text();
    assert.equal(dashboardResponse.status, 200);
    assert.ok(dashboardHtml.includes("saved discovery progress"), "dashboard should hydrate saved favourite-team search progress");

    // Batch indices above zero must pass input validation; with isolated storage,
    // the expected failure is the later database-readiness check, not invalid batch syntax.
    const batchResponse = await fetch(`${baseUrl}/api/teams/provider-search?batch=1`);
    const batchResult = await batchResponse.json() as Record<string, unknown>;
    assert.equal(batchResponse.status, 503);
    assert.notEqual(batchResult.reason, "provide_teamIds_or_batch_index_starting_at_zero");

    const endpoint = `${baseUrl}/api/providers/fixtures?date=2099-01-01`;
    const firstResponse = await fetch(endpoint);
    const first = await firstResponse.json() as Record<string, unknown>;
    assert.equal(firstResponse.status, 200);
    assert.equal(first.cache, "miss");
    assert.equal(first.cached, false);
    assert.equal(typeof first.retrievedAt, "string");

    const secondResponse = await fetch(endpoint);
    const second = await secondResponse.json() as Record<string, unknown>;
    assert.equal(secondResponse.status, 200);
    assert.equal(second.cache, "hit");
    assert.equal(second.cached, true);
    assert.equal(typeof second.cachedAt, "string");
    assert.equal(second.candidateCount, 0);
  } finally {
    child.kill("SIGTERM");
  }
});
