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
