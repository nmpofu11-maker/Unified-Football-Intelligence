import test from "node:test";
import assert from "node:assert/strict";
import { ApiFootballProvider, mapApiFootballFixture } from "../src/providers/adapters/apiFootball.js";

const fixture = {
  fixture: { id: 991, date: "2026-10-13T17:00:00+00:00", status: { short: "FT", long: "Match Finished" } },
  league: { id: 39, name: "Premier League", season: 2026 },
  teams: { home: { id: 10, name: "Home FC" }, away: { id: 20, name: "Away FC" } },
  goals: { home: 2, away: 1 }
};

test("API-Football maps fixture identity and only attaches scores to finished fixtures", () => {
  const mapped = mapApiFootballFixture(fixture, "2026-10-13T12:00:00.000Z");
  assert.equal(mapped?.provider, "api-football");
  assert.equal(mapped?.providerFixtureId, "991");
  assert.equal(mapped?.home.providerTeamId, "10");
  assert.equal(mapped?.away.providerTeamId, "20");
  assert.equal(mapped?.competition.providerCompetitionId, "39");
  assert.equal(mapped?.kickoffUtc, "2026-10-13T17:00:00.000Z");
  assert.equal(mapped?.status, "finished");
  assert.deepEqual(mapped?.score, { home: 2, away: 1 });
  assert.equal(mapped?.evidenceState, "unverified");

  const scheduled = mapApiFootballFixture({
    ...fixture,
    fixture: { ...fixture.fixture, status: { short: "NS" } }
  });
  assert.equal(scheduled?.status, "scheduled");
  assert.equal(scheduled?.score, undefined);
  assert.equal(mapApiFootballFixture({ ...fixture, fixture: { ...fixture.fixture, date: "2026-10-13T17:00:00" } }), null);
});

test("API-Football fetch uses documented key header and records a sanitized successful response", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.API_FOOTBALL_KEY;
  process.env.API_FOOTBALL_KEY = "test-key-not-a-real-secret";
  let requestUrl: URL | undefined;
  let requestHeaders: Headers | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = new URL(String(input));
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ get: "fixtures", parameters: { date: "2026-10-13" }, errors: [], results: 1, response: [fixture] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const provider = new ApiFootballProvider();
    const rows = await provider.fetchFixtures({ dateFromUtc: "2026-10-13", dateToUtc: "2026-10-13" });
    assert.equal(rows.length, 1);
    assert.equal(requestUrl?.pathname, "/fixtures");
    assert.equal(requestUrl?.searchParams.get("date"), "2026-10-13");
    assert.equal(requestHeaders?.get("x-apisports-key"), "test-key-not-a-real-secret");
    assert.equal(provider.diagnostics().state, "success");
    assert.equal(provider.diagnostics().lastAcceptedCount, 1);
    assert.equal(JSON.stringify(provider.diagnostics()).includes("test-key-not-a-real-secret"), false);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.API_FOOTBALL_KEY;
    else process.env.API_FOOTBALL_KEY = oldKey;
  }
});

test("API-Football reports authentication failures without exposing response secrets", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.API_FOOTBALL_KEY;
  process.env.API_FOOTBALL_KEY = "test-key-not-a-real-secret";
  globalThis.fetch = (async () => new Response(JSON.stringify({ errors: { token: "do-not-expose" } }), {
    status: 403, headers: { "content-type": "application/json" }
  })) as typeof fetch;
  try {
    const provider = new ApiFootballProvider();
    assert.deepEqual(await provider.fetchFixtures({ dateFromUtc: "2026-10-13", dateToUtc: "2026-10-13" }), []);
    assert.equal(provider.diagnostics().state, "auth_error");
    assert.equal(provider.diagnostics().lastHttpStatus, 403);
    assert.equal(JSON.stringify(provider.diagnostics()).includes("do-not-expose"), false);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.API_FOOTBALL_KEY;
    else process.env.API_FOOTBALL_KEY = oldKey;
  }
});
