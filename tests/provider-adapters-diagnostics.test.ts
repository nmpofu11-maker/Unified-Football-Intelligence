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
  const withoutHomeProviderId = mapSportApiAiFixture({ ...fixture, home_team: { name: "Home FC" } });
  assert.equal(withoutHomeProviderId?.home.name, "Home FC");
  assert.equal(withoutHomeProviderId?.home.providerTeamId, undefined);
  const withoutCompetitionProviderId = mapSportApiAiFixture({ ...fixture, league: { name: "Example League" } });
  assert.equal(withoutCompetitionProviderId?.competition.name, "Example League");
  assert.equal(withoutCompetitionProviderId?.competition.providerCompetitionId, undefined);
});

test("SportAPI.ai accepts documented SportAPI fixture shape with string team and league names", async () => {
  const documented = { id: 45821, date: "2026-06-14", datetime: "2026-06-14T18:00:00Z", status: "Scheduled", league: "FIFA World Cup", home_team: "Brazil", away_team: "Mexico" };
  await withMockedFetch({ success: true, fixtures: [documented] }, async provider => {
    const results = await provider.fetchFixtures({ dateFromUtc: "2026-10-17", dateToUtc: "2026-10-17" });
    assert.equal(results.length, 1);
    assert.equal(provider.diagnostics().lastAcceptedCount, 1);
    assert.equal(provider.diagnostics().lastRejectedCount, 0);
  });
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

test("SportAPI.ai explains non-fixture message envelopes without exposing URI query secrets", async () => {
  await withMockedFetch({ message: "Endpoint requires a different plan", uri: "https://sportapi.ai/api/fixtures?token=do-not-expose" }, async provider => {
    assert.deepEqual(await provider.fetchFixtures({ dateFromUtc: "2026-10-17", dateToUtc: "2026-10-17" }), []);
    const diagnostic = provider.diagnostics();
    assert.equal(diagnostic.state, "schema_error");
    assert.equal(diagnostic.lastErrorCode, "provider_message_response");
    assert.equal(diagnostic.lastResponseShape?.message, "Endpoint requires a different plan");
    assert.equal(diagnostic.lastResponseShape?.uriPath, "/api/fixtures");
    assert.equal(JSON.stringify(diagnostic).includes("do-not-expose"), false);
  });
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

test("concurrent SportAPI.ai calls both settle with terminal diagnostics", async () => {
  await withMockedFetch({ data: [fixture] }, async provider => {
    const query = { dateFromUtc: "2026-10-17", dateToUtc: "2026-10-17" };
    const [first, second] = await Promise.all([provider.fetchFixtures(query), provider.fetchFixtures(query)]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(provider.diagnostics().state, "requesting");
  });
});
