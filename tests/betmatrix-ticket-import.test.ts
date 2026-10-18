import test from "node:test";
import assert from "node:assert/strict";
import { parseBetMatrixTicket } from "../src/tickets/betmatrixImport.js";

test("normalizes a pending BetMatrix accumulator without trusting its result status", () => {
  const result = parseBetMatrixTicket({
    id: "HB-TEST-001",
    status: "pending",
    stakeZar: 25,
    potentialPayoutZar: 250,
    legs: [
      {
        id: "leg-home",
        market: "Match Result",
        targetTeam: "Home FC",
        homeTeam: "Home FC",
        awayTeam: "Away FC",
        apiFootballFixtureId: 1234
      },
      {
        id: "leg-btts",
        market: "Both Teams to Score",
        targetTeam: "Yes",
        homeTeam: "Alpha",
        awayTeam: "Beta",
        sportApiFixtureId: "fixture-567"
      },
      {
        id: "leg-total",
        market: "Over/Under 2.5 Goals",
        targetTeam: "Over 2.5",
        homeTeam: "Gamma",
        awayTeam: "Delta",
        sportmonksFixtureId: "sm-890"
      }
    ]
  });
  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.equal(result.ticket.sourceTicketId, "HB-TEST-001");
  assert.equal(result.ticket.stakeAmount, 25);
  assert.equal(result.ticket.potentialPayout, 250);
  assert.deepEqual(result.ticket.selections.map(item => [item.market, item.pick, item.line]), [
    ["1x2", "home", undefined],
    ["btts", "yes", undefined],
    ["total_goals", "over", 2.5]
  ]);
  assert.deepEqual(result.ticket.selections.map(item => item.refs[0]?.provider), [
    "api-football", "sportapi-ai", "sportmonks"
  ]);
});

test("does not import settled source tickets as pending", () => {
  assert.deepEqual(parseBetMatrixTicket({ id: "settled-1", status: "lost", legs: [] }), {
    state: "not_pending",
    reason: "source_ticket_not_pending"
  });
});

test("rejects legs with no supported provider fixture ID instead of matching by names", () => {
  const result = parseBetMatrixTicket({
    id: "HB-TEST-002",
    status: "pending",
    stakeZar: 10,
    potentialPayoutZar: 20,
    legs: [{
      id: "leg-1",
      market: "Match Result",
      targetTeam: "Home FC",
      homeTeam: "Home FC",
      awayTeam: "Away FC",
      theRundownId: "rundown-123"
    }]
  });
  assert.equal(result.state, "invalid");
  if (result.state === "invalid") assert.equal(result.reason, "leg_1_has_no_supported_provider_fixture_id");
});

test("rejects ambiguous markets and invalid amounts", () => {
  const unsupportedMarket = parseBetMatrixTicket({
    id: "HB-TEST-003", status: "pending", stakeZar: 10, potentialPayoutZar: 30,
    legs: [{ id: "leg-1", market: "Correct Score", targetTeam: "2-1", apiFootballFixtureId: 1 }]
  });
  assert.equal(unsupportedMarket.state, "invalid");
  if (unsupportedMarket.state === "invalid") assert.equal(unsupportedMarket.reason, "leg_1_market_or_pick_unsupported_or_ambiguous");

  const invalidAmount = parseBetMatrixTicket({
    id: "HB-TEST-004", status: "pending", stakeZar: -1, potentialPayoutZar: 30,
    legs: [{ id: "leg-1", market: "Match Result", targetTeam: "Home FC", homeTeam: "Home FC", awayTeam: "Away FC", apiFootballFixtureId: 1 }]
  });
  assert.equal(invalidAmount.state, "invalid");
  if (invalidAmount.state === "invalid") assert.equal(invalidAmount.reason, "ticket_stake_or_potential_payout_invalid");
});
