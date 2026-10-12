import test from "node:test";
import assert from "node:assert/strict";
import { mapSportApiAiFixture } from "../src/providers/adapters/sportApiAi.js";
import { mapSportmonksFixture } from "../src/providers/adapters/sportmonks.js";

test("SportAPI.ai mapping requires provider IDs and timezone-explicit kickoff", () => {
  const base = { id: 123, date: "2026-10-17T16:30:00Z", status: "SCHEDULED", league: {id: 8, name: "Example League"}, home_team: {id: 1, name: "Home FC"}, away_team: {id: 2, name: "Away FC"} };
  const mapped = mapSportApiAiFixture(base, "2026-10-12T12:00:00.000Z");
  assert.equal(mapped?.providerFixtureId, "123");
  assert.equal(mapped?.kickoffUtc, "2026-10-17T16:30:00.000Z");
  assert.equal(mapped?.evidenceState, "unverified");
  assert.equal(mapSportApiAiFixture({...base, home_team:{id:1,name:"Home FC",score:2}, away_team:{id:2,name:"Away FC",score:0}})?.score, undefined);
  assert.equal(mapSportApiAiFixture({...base, date:"2026-10-17", kickoff_time:"16:30"}), null);
  assert.equal(mapSportApiAiFixture({...base, home_team:{name:"Home FC"}}), null);
});

test("Sportmonks mapping preserves provider IDs and never treats scheduled scores as final", () => {
  const raw = {id:55, starting_at:"2026-10-17 16:30:00", league:{id:9,name:"Example League"}, state:{short_name:"NS"}, participants:[{id:1,name:"Home FC",meta:{location:"home"}},{id:2,name:"Away FC",meta:{location:"away"}}], scores:[{participant_id:1,score:{goals:2,participant:"home"}},{participant_id:2,score:{goals:0,participant:"away"}}]};
  const mapped = mapSportmonksFixture(raw,"2026-10-12T12:00:00.000Z");
  assert.equal(mapped?.providerFixtureId,"55");
  assert.equal(mapped?.kickoffUtc,"2026-10-17T16:30:00.000Z");
  assert.equal(mapped?.status,"scheduled");
  assert.equal(mapped?.score,undefined);
  assert.equal(mapped?.evidenceState,"unverified");
  assert.equal(mapSportmonksFixture({...raw,participants:[]}),null);
});

test("Sportmonks accepts a score only when status is finished and both scores are valid", () => {
  const raw = {id:56,starting_at:"2026-10-10 16:30:00",league:{id:9,name:"Example League"},state:{short_name:"FT"},participants:[{id:1,name:"Home FC",meta:{location:"home"}},{id:2,name:"Away FC",meta:{location:"away"}}],scores:[{participant_id:1,description:"CURRENT",score:{goals:2,participant:"home"}},{participant_id:2,description:"CURRENT",score:{goals:1,participant:"away"}}]};
  assert.deepEqual(mapSportmonksFixture(raw)?.score,{home:2,away:1});
});
