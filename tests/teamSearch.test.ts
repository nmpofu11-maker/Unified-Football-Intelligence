import test from "node:test";
import assert from "node:assert/strict";
import { searchTeamAcrossProviders } from "../src/providers/teamSearch.js";

test("provider team search fails safely when credentials are absent", async () => {
  const oldApi = process.env.API_FOOTBALL_KEY;
  const oldSportmonks = process.env.SPORTMONKS_API_KEY;
  const oldSportmonksToken = process.env.SPORTMONKS_API_TOKEN;
  delete process.env.API_FOOTBALL_KEY;
  delete process.env.SPORTMONKS_API_KEY;
  delete process.env.SPORTMONKS_API_TOKEN;
  try {
    const result = await searchTeamAcrossProviders("Club name");
    assert.deepEqual(result.map(item => item.state), ["unavailable", "unavailable"]);
    assert.ok(result.every(item => item.candidates.length === 0));
  } finally {
    if (oldApi === undefined) delete process.env.API_FOOTBALL_KEY; else process.env.API_FOOTBALL_KEY = oldApi;
    if (oldSportmonks === undefined) delete process.env.SPORTMONKS_API_KEY; else process.env.SPORTMONKS_API_KEY = oldSportmonks;
    if (oldSportmonksToken === undefined) delete process.env.SPORTMONKS_API_TOKEN; else process.env.SPORTMONKS_API_TOKEN = oldSportmonksToken;
  }
});

test("invalid or excessively long names do not make network requests", async () => {
  const result = await searchTeamAcrossProviders("x".repeat(121));
  assert.ok(result.every(item => item.errorCode === "invalid_team_name"));
});

test("Sportmonks team search sends api_token and parses team/country candidates", async () => {
  const oldApi = process.env.API_FOOTBALL_KEY;
  const oldSportmonks = process.env.SPORTMONKS_API_KEY;
  process.env.API_FOOTBALL_KEY = "";
  process.env.SPORTMONKS_API_KEY = "test-sportmonks-token";
  let observedUrl = "";
  const fakeFetch: typeof fetch = async (input) => {
    observedUrl = String(input);
    return new Response(JSON.stringify({
      data: [{ id: 123, name: "St Patrick's Athletic", country: { name: "Ireland" }, short_code: "STP" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await searchTeamAcrossProviders("St Patrick's Athletic", undefined, fakeFetch);
    assert.equal(new URL(observedUrl).searchParams.get("api_token"), "test-sportmonks-token");
    assert.equal(result[1]?.state, "success");
    assert.deepEqual(result[1]?.candidates.map(candidate => ({
      providerTeamId: candidate.providerTeamId, name: candidate.name, country: candidate.country
    })), [{ providerTeamId: "123", name: "St Patrick's Athletic", country: "Ireland" }]);
  } finally {
    if (oldApi === undefined) delete process.env.API_FOOTBALL_KEY; else process.env.API_FOOTBALL_KEY = oldApi;
    if (oldSportmonks === undefined) delete process.env.SPORTMONKS_API_KEY; else process.env.SPORTMONKS_API_KEY = oldSportmonks;
  }
});

test("provider error payloads receive a safe actionable category without leaking raw text", async () => {
  const oldApi = process.env.API_FOOTBALL_KEY;
  const oldSportmonks = process.env.SPORTMONKS_API_KEY;
  process.env.API_FOOTBALL_KEY = "test-api-football-key";
  process.env.SPORTMONKS_API_KEY = "";
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
    errors: { token: "Invalid API key: secret-account-detail" }, response: []
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await searchTeamAcrossProviders("St Johnstone", undefined, fakeFetch);
    assert.equal(result[0]?.state, "auth_error");
    assert.equal(result[0]?.errorCode, "provider_auth_error");
    assert.ok(!JSON.stringify(result).includes("secret-account-detail"));
  } finally {
    if (oldApi === undefined) delete process.env.API_FOOTBALL_KEY; else process.env.API_FOOTBALL_KEY = oldApi;
    if (oldSportmonks === undefined) delete process.env.SPORTMONKS_API_KEY; else process.env.SPORTMONKS_API_KEY = oldSportmonks;
  }
});


test("team search retries an empty canonical query with the supplied curated alias", async () => {
  const oldApi = process.env.API_FOOTBALL_KEY;
  const oldSportmonks = process.env.SPORTMONKS_API_KEY;
  process.env.API_FOOTBALL_KEY = "test-api-football-key";
  process.env.SPORTMONKS_API_KEY = "";
  const observedQueries: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("search") ?? "";
    observedQueries.push(query);
    const response = query === "Nantes"
      ? [{ team: { id: 12, name: "Nantes", country: "France" } }]
      : [];
    return new Response(JSON.stringify({ errors: [], response }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await searchTeamAcrossProviders("FC Nantes", undefined, fakeFetch, ["Nantes"]);
    assert.deepEqual(observedQueries, ["FC Nantes", "Nantes"]);
    assert.equal(result[0]?.state, "success");
    assert.deepEqual(result[0]?.candidates.map(candidate => ({
      providerTeamId: candidate.providerTeamId, name: candidate.name, country: candidate.country
    })), [{ providerTeamId: "12", name: "Nantes", country: "France" }]);
  } finally {
    if (oldApi === undefined) delete process.env.API_FOOTBALL_KEY; else process.env.API_FOOTBALL_KEY = oldApi;
    if (oldSportmonks === undefined) delete process.env.SPORTMONKS_API_KEY; else process.env.SPORTMONKS_API_KEY = oldSportmonks;
  }
});

test("empty canonical and curated queries receive a completion marker to prevent endless retries", async () => {
  const oldApi = process.env.API_FOOTBALL_KEY;
  const oldSportmonks = process.env.SPORTMONKS_API_KEY;
  process.env.API_FOOTBALL_KEY = "test-api-football-key";
  process.env.SPORTMONKS_API_KEY = "";
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ errors: [], response: [] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await searchTeamAcrossProviders("No Such Club", undefined, fakeFetch, ["No Such Alias"]);
    assert.equal(calls, 2);
    assert.equal(result[0]?.state, "success_empty");
    assert.equal(result[0]?.errorCode, "team_search_strategy_v1_exhausted");
  } finally {
    if (oldApi === undefined) delete process.env.API_FOOTBALL_KEY; else process.env.API_FOOTBALL_KEY = oldApi;
    if (oldSportmonks === undefined) delete process.env.SPORTMONKS_API_KEY; else process.env.SPORTMONKS_API_KEY = oldSportmonks;
  }
});
