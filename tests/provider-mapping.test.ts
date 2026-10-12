import test from "node:test";
import assert from "node:assert/strict";
import { mapSportApiAiFixture } from "../src/providers/adapters/sportApiAi.js";
import { mapSportmonksFixture } from "../src/providers/adapters/sportmonks.js";

test("SportAPI.ai maps documented string teams and league when provider IDs are not supplied", () => {
  const documented = { id: 45821, date: "2026-06-14", datetime: "2026-06-14T18:00:00Z", status: "Scheduled", league: "FIFA World Cup", home_team: "Brazil", away_team: "Mexico" };
  const mappedDocumented = mapSportApiAiFixture(documented, "2026-10-12T12:00:00.000Z");
  assert.equal(mappedDocumented?.home.name, "Brazil");
  assert.equal(mappedDocumented?.away.name, "Mexico");
  assert.equal(mappedDocumented?.competition.name, "FIFA World Cup");
  assert.equal(mappedDocumented?.kickoffUtc, "2026-06-14T18:00:00.000Z");
  assert.equal(mappedDocumented?.home.providerTeamId, undefined);
  assert.equal(mappedDocumented?.competition.providerCompetitionId, undefined);
});

test("SportAPI.ai mapping requires timezone-explicit kickoff", () => {
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

test("Sportmonks halftime observation remains live and never settled", () => {
  const raw = {
    id: 19713909,
    starting_at: "2026-10-12 17:00:00",
    league: { id: 271, name: "Superliga" },
    state: { short_name: "HT" },
    participants: [
      { id: 2905, name: "AGF", meta: { location: "home" } },
      { id: 390, name: "Sønderjyske Fodbold", meta: { location: "away" } }
    ],
    scores: [
      { participant_id: 2905, score: { goals: 1, participant: "home" } },
      { participant_id: 390, score: { goals: 0, participant: "away" } }
    ]
  };
  const mapped = mapSportmonksFixture(raw, "2026-10-12T18:04:25.867Z");
  assert.equal(mapped?.providerFixtureId, "19713909");
  assert.equal(mapped?.home.providerTeamId, "2905");
  assert.equal(mapped?.away.providerTeamId, "390");
  assert.equal(mapped?.competition.providerCompetitionId, "271");
  assert.equal(mapped?.status, "live");
  assert.equal(mapped?.score, undefined);
  assert.equal(mapped?.evidenceState, "unverified");
});
