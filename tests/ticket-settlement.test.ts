import { test } from "node:test";
import assert from "node:assert/strict";
import { settleTicket, type TicketSelection, type VerifiedSettledResult } from "../src/tickets/settlement.js";

const result = (fixtureId: string, homeGoals: number, awayGoals: number): VerifiedSettledResult => ({
  fixtureId,
  kickoffUtc: "2026-10-17T12:00:00.000Z",
  settledAt: "2026-10-17T14:00:00.000Z",
  homeGoals, awayGoals,
  evidenceState: "verified",
  fixtureStatus: "finished"
});

const selections: TicketSelection[] = [
  { selectionId: "s1", fixtureId: "f1", market: "1x2", pick: "home" },
  { selectionId: "s2", fixtureId: "f2", market: "1x2", pick: "away" }
];

test("ticket becomes lost immediately when any verified selection loses, even if another is pending", () => {
  const settled = settleTicket(selections, new Map([["f1", result("f1", 0, 2)]]));
  assert.equal(settled.state, "lost");
  assert.equal(settled.selections[0]?.state, "lost");
  assert.equal(settled.selections[1]?.state, "pending");
});

test("ticket remains pending when results are missing and no verified selection has lost", () => {
  const settled = settleTicket(selections, new Map());
  assert.equal(settled.state, "pending");
  assert.ok(settled.selections.every(s => s.state === "pending"));
});

test("unverified or mismatched results cannot settle a selection", () => {
  const unverified = { ...result("f1", 0, 2), evidenceState: "unverified" as const };
  const mismatched = result("another-fixture", 0, 2);
  assert.equal(settleTicket(selections, new Map([["f1", unverified]])).state, "pending");
  assert.equal(settleTicket(selections, new Map([["f1", mismatched]])).state, "pending");
});

test("settles a winning accumulator only when every selection is resolved", () => {
  const settled = settleTicket(selections, new Map([
    ["f1", result("f1", 2, 0)],
    ["f2", result("f2", 0, 1)]
  ]));
  assert.equal(settled.state, "won");
});

test("draw-no-bet draw and exact total line are void, not losses", () => {
  const ticket: TicketSelection[] = [
    { selectionId: "s1", fixtureId: "f1", market: "draw_no_bet", pick: "home" },
    { selectionId: "s2", fixtureId: "f2", market: "total_goals", pick: "over", line: 2 }
  ];
  const settled = settleTicket(ticket, new Map([
    ["f1", result("f1", 1, 1)],
    ["f2", result("f2", 1, 1)]
  ]));
  assert.equal(settled.state, "void");
  assert.ok(settled.selections.every(s => s.state === "void"));
});
