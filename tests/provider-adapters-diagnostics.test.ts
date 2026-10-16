import test from "node:test";
import assert from "node:assert/strict";
import { SportApiAiProvider, mapSportApiAiFixture } from "../src/providers/adapters/sportApiAi.js";
import { SportmonksProvider } from "../src/providers/adapters/sportmonks.js";

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


test("Sportmonks uses documented auth and falls back from an empty date endpoint to date range", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.SPORTMONKS_API_KEY;
  const previousBase = process.env.SPORTMONKS_BASE_URL;
  process.env.SPORTMONKS_API_KEY = "test-key-not-a-real-secret";
  delete process.env.SPORTMONKS_BASE_URL;
  const requestedUrls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    const payload = url.pathname.includes("/fixtures/between/")
      ? {
          data: [{
            id: 321,
            starting_at: "2026-10-13 17:00:00",
            state: { id: 1, state: "NS", name: "Not Started", short_name: "NS" },
            league: { id: 8, name: "Example League" },
            participants: [
              { id: 1, name: "Home FC", meta: { location: "home" } },
              { id: 2, name: "Away FC", meta: { location: "away" } }
            ],
            scores: []
          }]
        }
      : { data: [], message: "No result(s) found matching your request." };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = new SportmonksProvider();
    const rows = await provider.fetchFixtures({ dateFromUtc: "2026-10-13", dateToUtc: "2026-10-13" });
    assert.equal(requestedUrls.length, 2);
    assert.equal(requestedUrls[0]?.pathname, "/v3/football/fixtures/date/2026-10-13");
    assert.equal(requestedUrls[1]?.pathname, "/v3/football/fixtures/between/2026-10-13/2026-10-13");
    assert.equal(requestedUrls[0]?.searchParams.get("api_token"), "test-key-not-a-real-secret");
    assert.equal(requestedUrls[1]?.searchParams.get("per_page"), "50");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.home.name, "Home FC");
    assert.equal(provider.diagnostics().state, "success");
    assert.equal(provider.diagnostics().lastResponseShape?.uriPath, "fixtures/between/{start_date}/{end_date}");
    assert.equal(JSON.stringify(provider.diagnostics()).includes("test-key-not-a-real-secret"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SPORTMONKS_API_KEY;
    else process.env.SPORTMONKS_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.SPORTMONKS_BASE_URL;
    else process.env.SPORTMONKS_BASE_URL = previousBase;
  }
});

test("Sportmonks records a clear diagnostic when both documented fixture endpoints return empty data", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.SPORTMONKS_API_KEY;
  process.env.SPORTMONKS_API_KEY = "test-key-not-a-real-secret";
  const requestedPaths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedPaths.push(new URL(String(input)).pathname);
    return new Response(JSON.stringify({ data: [], message: "No results for this subscription/date" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const provider = new SportmonksProvider();
    assert.deepEqual(await provider.fetchFixtures({ dateFromUtc: "2026-10-13", dateToUtc: "2026-10-13" }), []);
    assert.equal(requestedPaths.length, 2);
    assert.equal(provider.diagnostics().state, "success_empty");
    assert.equal(provider.diagnostics().lastErrorCode, "empty_date_and_date_range_results");
    assert.equal(provider.diagnostics().lastResponseShape?.uriPath, "fixtures/between/{start_date}/{end_date}");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SPORTMONKS_API_KEY;
    else process.env.SPORTMONKS_API_KEY = previousKey;
  }
});

test("SportAPI.ai requests the documented fixtures-by-date route", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.SPORTAPI_AI_KEY;
  const previousBase = process.env.SPORTAPI_AI_BASE_URL;
  process.env.SPORTAPI_AI_KEY = "test-key-not-a-real-secret";
  delete process.env.SPORTAPI_AI_BASE_URL;
  let requestedUrl: URL | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = new URL(String(input));
    return new Response(JSON.stringify({
      success: true,
      date: "2026-10-13",
      data: [{
        id: 123,
        datetime: "2026-10-13T17:00:00Z",
        status: "Scheduled",
        league_name: "Example League",
        home_team: "Home FC",
        away_team: "Away FC"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = new SportApiAiProvider();
    const rows = await provider.fetchFixtures({ dateFromUtc: "2026-10-13", dateToUtc: "2026-10-13" });
    assert.equal(requestedUrl?.pathname, "/api/fixtures/date/2026-10-13");
    assert.equal(requestedUrl?.search, "");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.home.name, "Home FC");
    assert.equal(provider.diagnostics().state, "success");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SPORTAPI_AI_KEY;
    else process.env.SPORTAPI_AI_KEY = previousKey;
    if (previousBase === undefined) delete process.env.SPORTAPI_AI_BASE_URL;
    else process.env.SPORTAPI_AI_BASE_URL = previousBase;
  }
});


test("SportAPI.ai rejects timezone-naive kickoff values instead of guessing UTC", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.SPORTAPI_AI_KEY;
  process.env.SPORTAPI_AI_KEY = "test-key-not-a-real-secret";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    success: true,
    date: "2026-10-13",
    data: [{
      id: 991,
      datetime: "2026-10-13 17:00:00",
      status: "Scheduled",
      league_name: "Example League",
      home_team: "Home FC",
      away_team: "Away FC"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const provider = new SportApiAiProvider();
    assert.deepEqual(await provider.fetchFixtures({ dateFromUtc: "2026-10-13", dateToUtc: "2026-10-13" }), []);
    assert.equal(provider.diagnostics().state, "partial");
    assert.equal(provider.diagnostics().lastRejectedCount, 1);
    assert.deepEqual(provider.diagnostics().lastRejectionReasons, { invalid_kickoff: 1 });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SPORTAPI_AI_KEY;
    else process.env.SPORTAPI_AI_KEY = previousKey;
  }
});
