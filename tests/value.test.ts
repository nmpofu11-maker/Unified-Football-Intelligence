import test from "node:test";
import assert from "node:assert/strict";
import { assessValue } from "../src/markets/value.js";
import type { OddsQuote, ProbabilityForecast } from "../src/domain/types.js";
const forecast: ProbabilityForecast = {fixtureId:"fx",modelId:"baseline",modelVersion:"0.1",generatedAt:"2026-01-01T12:00:00.000Z",featureCutoffAt:"2026-01-01T12:00:00.000Z",homeWin:.5,draw:.25,awayWin:.25,evidenceState:"unverified",abstentionReasons:["baseline_not_yet_calibrated_for_betting"]};
const quote: OddsQuote = {fixtureId:"fx",bookmaker:"book",market:"1x2",selection:"home",decimalOdds:2.5,observedAt:"2026-01-01T12:00:00.000Z",provenance:{provider:"book",retrievedAt:"2026-01-01T12:00:00.000Z",evidenceState:"verified"}};
test("withholds recommendations from uncalibrated forecasts", () => {
  const out = assessValue(forecast, quote, "2026-01-01T12:01:00.000Z");
  assert.equal(out.state,"withheld"); assert.ok(out.reasons.includes("forecast_not_verified_and_calibrated"));
});
test("withholds stale odds", () => {
  const trusted = {...forecast,evidenceState:"verified" as const,abstentionReasons:[]};
  const out = assessValue(trusted, quote, "2026-01-01T13:00:00.000Z");
  assert.ok(out.reasons.includes("odds_stale"));
});

test("even a manually approved model produces a review candidate, not an automatic bet", () => {
  const trusted = {...forecast,evidenceState:"verified" as const,abstentionReasons:[]};
  const out = assessValue(trusted, quote, "2026-01-01T12:01:00.000Z", 15, true);
  assert.equal(out.state,"requires_manual_risk_review");
  assert.ok(out.reasons.includes("independent_risk_review_required"));
});
