import test from "node:test";
import assert from "node:assert/strict";
import { SportApiAiProvider, mapSportApiAiFixture } from "../src/providers/adapters/sportApiAi.js";

const fixture = {
  id: 123,
  date: "2026-10-17T16:30:00Z",
  status: "SCHEDULED",
  league: { id: 8, name: "Example League" },
  home_team: { id: 1, name: "Home FC" },
  away_team: { id: 2, name: "Away FC" }
};

async function withMockedFetch(payload: unknown, fn: (provider: SportApiAiProvider) => Promise<void>, status = 200) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.SPORTAPI_AI_KEY;
  process.env.SPORTAPI_AI_KEY = "test-key-not-a-real-secret";
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
    status, headers: { "content-type": "application/json" }
  })) as typeof fetch;
  try {
    await fn(new SportApiAiProvider());
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SPORTAPI_AI_KEY;
    else process.env.SPORTAPI_AI_KEY = previousKey;
  }
}

test("SportAPI.ai maps an observed fixture and never fabricates missing values", () => {
  assert.equal(mapSportApiAiFixture(fixture)?.providerFixtureId, "123");
  assert.equal(mapSportApiAiFixture({ ...fixture, date: "2026-10-17T16:30:00" }), null);
  assert.equal(mapSportApiAiFixture({ ...fixture, home_team: { name: "Home FC" } }), null);
  assert.equal(mapSportApiAiFixture({ ...fixture, league: { name: "Example League" } }), null);
});

test("SportAPI.ai accepts supported envelope variants and records sanitized response shape", async () => {
  for (const payload of [
    [fixture],
    { data: [fixture] },
    { fixtures: [fixture] },
    { data: { fixtures: [fixture] } },
    { data: { records: [fixture] } },
    { records: [fixture] }
  ]) {
    await withMockedFetch(payload, async provider => {
      const results = await provider.fetchFixtures({ dateFromUtc: "2026-10-17", dateToUtc: "2026-10-17" });
      assert.equal(results.length, 1);
      assert.equal(provider.diagnostics().lastAcceptedCount, 1);
      assert.equal(provider.diagnostics().lastRejectedCount, 0);
    });
  }
});

test("SportAPI.ai distinguishes empty responses from rejected records", async () => {
  await withMockedFetch({ data: [] }, async provider => {
    assert.deepEqual(await provider.fetchFixtures({ dateFromUtc: "2026-10-17", dateToUtc: "2026-10-17" }), []);
    assert.equal(provider.diagnostics().state, "success_empty");
    assert.equal(provider.diagnostics().lastRejectedCount, 0);
  });
  await withMockedFetch({ data: [{ id: 8, date: "not-a-date" }] }, async provider => {
    assert.deepEqual(await provider.fetchFixtures({ dateFromUtc: "2026-10-17", dateToUtc: "2026-10-17" }), []);
    assert.equal(provider.diagnostics().state, "partial");
    assert.equal(provider.diagnostics().lastRejectedCount, 1);
    assert.deepEqual(provider.diagnostics().lastRejectionReasons, { missing_team: 1 });
  });
});

test("SportAPI.ai HTTP failures end in a terminal diagnostic state", async () => {
  await withMockedFetch({ message: "unauthorized" }, async provider => {
    assert.deepEqual(await provider.fetchFixtures({ dateFromUtc: "2026-10-17", dateToUtc: "2026-10-17" }), []);
    assert.equal(provider.diagnostics().state, "auth_error");
    assert.equal(provider.diagnostics().lastHttpStatus, 401);
  }, 401);
});
