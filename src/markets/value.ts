import type { OddsQuote, ProbabilityForecast } from "../domain/types.js";

export interface ValueAssessment {
  state: "withheld" | "requires_manual_risk_review";
  selection: string;
  decimalOdds: number | null;
  impliedProbability: number | null;
  modelProbability: number | null;
  rawExpectedReturn: number | null;
  reasons: string[];
}

/** Decision-support only: never upgrades an uncalibrated forecast to a bet recommendation. */
export function assessValue(forecast: ProbabilityForecast, quote: OddsQuote | null, nowUtc: string, maxAgeMinutes = 15, modelApprovedForBetting = false): ValueAssessment {
  const reasons: string[] = [];
  if (forecast.evidenceState !== "verified") reasons.push("forecast_not_verified_and_calibrated");
  if (forecast.abstentionReasons.length) reasons.push("forecast_has_abstention_reasons");
  if (!modelApprovedForBetting) reasons.push("model_not_approved_for_betting");
  if (!quote) reasons.push("odds_missing");
  if (quote && quote.provenance.evidenceState !== "verified") reasons.push("odds_not_verified");
  if (quote && (!Number.isFinite(Date.parse(quote.observedAt)) || !Number.isFinite(Date.parse(nowUtc)))) reasons.push("invalid_odds_timestamp");
  if (quote && Date.parse(nowUtc) - Date.parse(quote.observedAt) > maxAgeMinutes * 60_000) reasons.push("odds_stale");
  if (quote && quote.fixtureId !== forecast.fixtureId) reasons.push("fixture_identity_mismatch");
  const probability = quote ? ({home: forecast.homeWin, draw: forecast.draw, away: forecast.awayWin} as Record<string, number>)[quote.selection] : undefined;
  if (quote && probability === undefined) reasons.push("unsupported_selection");
  const validOdds = quote && Number.isFinite(quote.decimalOdds) && quote.decimalOdds > 1;
  const impliedProbability = validOdds ? 1 / quote.decimalOdds : null;
  const rawExpectedReturn = validOdds && probability !== undefined ? probability * quote.decimalOdds - 1 : null;
  return {
    state: reasons.length ? "withheld" : "requires_manual_risk_review",
    selection: quote?.selection ?? "unknown", decimalOdds: validOdds ? quote!.decimalOdds : null,
    impliedProbability, modelProbability: probability ?? null, rawExpectedReturn,
    reasons: reasons.length ? reasons : ["independent_risk_review_required"]
  };
}
