import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeFixtureCandidate, resolveTeamIdentity } from "../src/reconciliation/identity.js";
import type { Competition, Team } from "../src/domain/types.js";
import type { ProviderFixtureCandidate } from "../src/providers/provider.js";
const teams: Team[] = [
  {id:"home",canonicalName:"Home FC",aliases:["Home"],providerIds:{sportmonks:"10"}},
  {id:"away",canonicalName:"Away FC",aliases:[],providerIds:{sportmonks:"20"}}
];
const competitions: Competition[] = [{id:"league",canonicalName:"Example League",providerIds:{sportmonks:"5"}}];
const candidate: ProviderFixtureCandidate = {
  provider:"sportmonks",providerFixtureId:"fx1",kickoffUtc:"2026-10-17T16:30:00.000Z",
  home:{providerTeamId:"10",name:"Home FC"},away:{providerTeamId:"20",name:"Away FC"},
  competition:{providerCompetitionId:"5",name:"Example League"},status:"scheduled",observedAt:"2026-10-12T12:00:00.000Z",
  evidenceState:"unverified",rawStatus:"NS",provenance:{provider:"sportmonks",providerRecordId:"fx1",retrievedAt:"2026-10-12T12:00:00.000Z",evidenceState:"unverified"}
};
test("provider IDs must agree with canonical names", () => {
  assert.equal(resolveTeamIdentity("sportmonks","10","Away FC",teams).state,"conflict");
});
test("canonical fixture is created only after all identities resolve", () => {
  const result = canonicalizeFixtureCandidate(candidate,teams,competitions);
  assert.equal(result.state,"resolved");
  if (result.state === "resolved") { assert.equal(result.fixture.homeTeamId,"home"); assert.equal(result.fixture.awayTeamId,"away"); assert.equal(result.fixture.provenance[0]?.evidenceState,"unverified"); }
});
test("unknown team remains blocked instead of fuzzy-matching", () => {
  const result = canonicalizeFixtureCandidate({...candidate,home:{providerTeamId:"999",name:"Home City FC"}},teams,competitions);
  assert.equal(result.state,"blocked");
  if (result.state === "blocked") assert.ok(result.reasons.some(r=>r.includes("home_team_unresolved")));
});
