import test from "node:test";
import assert from "node:assert/strict";
import { searchTeamAcrossProviders } from "../src/providers/teamSearch.js";

test("SportAPI catalogue discovery respects favourite country, league context and exact team names", async () => {
  const oldKey = process.env.SPORTAPI_AI_KEY;
  const oldAlt = process.env.SPORTAPI_API_KEY;
  process.env.SPORTAPI_AI_KEY = "test-key";
  delete process.env.SPORTAPI_API_KEY;
  const calls: Array<{url:string; headers:Record<string,string>}> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({url, headers: (init?.headers ?? {}) as Record<string,string>});
    if (url.endsWith("/leagues")) return new Response(JSON.stringify({success:true,data:[
      {country:"Angola",leagues:[{id:10,name:"Girabola",teams_count:16}]},
      {country:"Portugal",leagues:[{id:20,name:"Primeira Liga",teams_count:18}]}
    ]}), {status:200,headers:{"content-type":"application/json"}});
    if (url.endsWith("/leagues/10")) return new Response(JSON.stringify({success:true,id:10,name:"Girabola",country:"Angola",teams:[
      {id:501,name:"15 de Agosto"},{id:502,name:"15 de Agosto B"},{id:503,name:"Outra Equipa"}
    ]}), {status:200,headers:{"content-type":"application/json"}});
    throw new Error("Unexpected URL: "+url);
  };
  try {
    const results = await searchTeamAcrossProviders("15 de Agosto", undefined, fetchMock, [], {
      country:"Angola", league:"Angola Premier League", teamCategory:"senior"
    });
    const sportApi = results.find(result => result.provider === "sportapi-ai");
    assert.ok(sportApi);
    assert.equal(sportApi.state, "success");
    assert.deepEqual(sportApi.candidates.map(candidate => candidate.providerTeamId), ["501"]);
    assert.equal(sportApi.candidates[0]?.country, "Angola");
    assert.equal(sportApi.candidates[0]?.league, "Girabola");
    assert.ok(calls.every(call => call.headers["X-Api-Key"] === "test-key"));
    assert.ok(!calls.some(call => call.url.endsWith("/leagues/20")));
  } finally {
    if (oldKey === undefined) delete process.env.SPORTAPI_AI_KEY; else process.env.SPORTAPI_AI_KEY = oldKey;
    if (oldAlt === undefined) delete process.env.SPORTAPI_API_KEY; else process.env.SPORTAPI_API_KEY = oldAlt;
  }
});

test("SportAPI catalogue reports missing credentials without issuing requests", async () => {
  const oldKey = process.env.SPORTAPI_AI_KEY;
  const oldAlt = process.env.SPORTAPI_API_KEY;
  delete process.env.SPORTAPI_AI_KEY;
  delete process.env.SPORTAPI_API_KEY;
  let calls = 0;
  try {
    const results = await searchTeamAcrossProviders("Ahlafors IF", undefined, (async () => {
      calls++;
      return new Response("{}", {status:200});
    }) as typeof fetch, [], {country:"Sweden",league:"Division 2 Norra Götaland"});
    const sportApi = results.find(result => result.provider === "sportapi-ai");
    assert.equal(sportApi?.state, "unavailable");
    assert.equal(sportApi?.errorCode, "credential_not_configured");
    assert.equal(calls, 0);
  } finally {
    if (oldKey === undefined) delete process.env.SPORTAPI_AI_KEY; else process.env.SPORTAPI_AI_KEY = oldKey;
    if (oldAlt === undefined) delete process.env.SPORTAPI_API_KEY; else process.env.SPORTAPI_API_KEY = oldAlt;
  }
});
