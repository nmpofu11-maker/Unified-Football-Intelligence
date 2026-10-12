import test from "node:test";
import assert from "node:assert/strict";
import { reconcileSettledResults } from "../src/reconciliation/reconcile.js";
import type { SettledResult } from "../src/domain/types.js";
const result = (homeGoals: number, awayGoals: number): SettledResult => ({
  fixtureId: "fx", homeGoals, awayGoals, settledAt: "2026-01-01T00:00:00.000Z", reconciliationState: "verified",
  provenance: [{ provider: "source", retrievedAt: "2026-01-01T00:00:00.000Z", evidenceState: "verified" }]
});
test("empty result set stays unverified", () => assert.equal(reconcileSettledResults([]).state, "unverified"));
test("score disagreements are conflicted", () => {
  const r = reconcileSettledResults([result(2, 0), result(1, 0)]);
  assert.equal(r.state, "conflicted"); assert.ok(r.reasons.includes("provider_score_conflict"));
});
test("matching verified scores reconcile", () => {
  const r = reconcileSettledResults([result(2, 0), result(2, 0)]);
  assert.equal(r.state, "verified"); assert.equal(r.selected?.homeGoals, 2);
});
