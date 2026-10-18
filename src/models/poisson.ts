import type { ProbabilityForecast, SettledResult } from "../domain/types.js";

export interface HistoricalMatch {
  fixtureId: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffUtc: string;
  result: SettledResult;
}

export interface ForecastInput {
  fixtureId: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffUtc: string;
  generatedAt: string;
  matches: HistoricalMatch[];
  minimumTeamMatches?: number;
  maxGoals?: number;
}

export interface ForecastOutput {
  forecast: ProbabilityForecast;
  diagnostics: {
    homeSamples: number;
    awaySamples: number;
    leagueSamples: number;
    expectedHomeGoals: number | null;
    expectedAwayGoals: number | null;
    method: "poisson-baseline";
  };
}

const isUtc = (s: string) => s.endsWith("Z") && Number.isFinite(Date.parse(s));
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function poissonPmf(lambda: number, k: number): number {
  if (lambda < 0 || !Number.isFinite(lambda)) return 0;
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

/**
 * Transparent pre-match baseline. Only verified, non-conflicted, completed results
 * strictly before kickoff are eligible. This model is not advertised as calibrated.
 */
export function forecastPoisson(input: ForecastInput): ForecastOutput {
  const requestedMinimum = input.minimumTeamMatches ?? 5;
  const requestedMaxGoals = input.maxGoals ?? 10;
  // Invalid configuration must fail closed rather than silently lowering evidence requirements.
  const minimumPolicyValid = Number.isInteger(requestedMinimum) && requestedMinimum >= 5 && requestedMinimum <= 100;
  const maxGoalsPolicyValid = Number.isInteger(requestedMaxGoals) && requestedMaxGoals >= 5 && requestedMaxGoals <= 20;
  const minimum = minimumPolicyValid ? requestedMinimum : 5;
  const maxGoals = maxGoalsPolicyValid ? requestedMaxGoals : 10;
  const kickoffCutoff = Date.parse(input.kickoffUtc);
  const generatedCutoff = Date.parse(input.generatedAt);
  const cutoff = Math.min(kickoffCutoff, generatedCutoff);
  const eligible = input.matches.filter(m =>
    m.result.fixtureId === m.fixtureId &&
    m.result.reconciliationState === "verified" &&
    Number.isInteger(m.result.homeGoals) && m.result.homeGoals >= 0 &&
    Number.isInteger(m.result.awayGoals) && m.result.awayGoals >= 0 &&
    isUtc(m.kickoffUtc) && Date.parse(m.kickoffUtc) < cutoff &&
    isUtc(m.result.settledAt) && Date.parse(m.result.settledAt) < cutoff &&
    m.result.provenance.length > 0 &&
    m.result.provenance.every(p => p.evidenceState === "verified")
  );
  const homeMatches = eligible.filter(m => m.homeTeamId === input.homeTeamId || m.awayTeamId === input.homeTeamId);
  const awayMatches = eligible.filter(m => m.homeTeamId === input.awayTeamId || m.awayTeamId === input.awayTeamId);
  const reasons: string[] = [];
  if (!minimumPolicyValid) reasons.push("invalid_minimum_team_matches_policy");
  if (!maxGoalsPolicyValid) reasons.push("invalid_max_goals_policy");
  if (!isUtc(input.kickoffUtc)) reasons.push("invalid_fixture_kickoff_timestamp");
  if (!isUtc(input.generatedAt)) reasons.push("invalid_forecast_timestamp");
  if (isUtc(input.kickoffUtc) && isUtc(input.generatedAt) && generatedCutoff > kickoffCutoff) reasons.push("forecast_generated_after_kickoff");
  if (input.homeTeamId === input.awayTeamId) reasons.push("same_home_and_away_team");
  if (homeMatches.length < minimum) reasons.push("insufficient_home_team_history");
  if (awayMatches.length < minimum) reasons.push("insufficient_away_team_history");

  const leagueHome = mean(eligible.map(m => m.result.homeGoals));
  const leagueAway = mean(eligible.map(m => m.result.awayGoals));
  const homeScored = mean(homeMatches.map(m => m.homeTeamId === input.homeTeamId ? m.result.homeGoals : m.result.awayGoals));
  const homeConceded = mean(homeMatches.map(m => m.homeTeamId === input.homeTeamId ? m.result.awayGoals : m.result.homeGoals));
  const awayScored = mean(awayMatches.map(m => m.homeTeamId === input.awayTeamId ? m.result.homeGoals : m.result.awayGoals));
  const awayConceded = mean(awayMatches.map(m => m.homeTeamId === input.awayTeamId ? m.result.awayGoals : m.result.homeGoals));

  let lambdaHome: number | null = null, lambdaAway: number | null = null;
  if (leagueHome === null || leagueAway === null || leagueHome <= 0 || leagueAway <= 0) reasons.push("insufficient_league_goal_baseline");
  if (homeScored === null || homeConceded === null || awayScored === null || awayConceded === null) reasons.push("missing_team_goal_rates");
  if (!reasons.length) {
    // Blend team rates toward the league baseline to reduce small-sample extremes.
    const shrink = 5;
    const hAttack = ((homeScored! * homeMatches.length) + leagueHome! * shrink) / (homeMatches.length + shrink) / leagueHome!;
    const hDefence = ((homeConceded! * homeMatches.length) + leagueAway! * shrink) / (homeMatches.length + shrink) / leagueAway!;
    const aAttack = ((awayScored! * awayMatches.length) + leagueAway! * shrink) / (awayMatches.length + shrink) / leagueAway!;
    const aDefence = ((awayConceded! * awayMatches.length) + leagueHome! * shrink) / (awayMatches.length + shrink) / leagueHome!;
    lambdaHome = Math.min(4.5, Math.max(0.1, leagueHome! * hAttack * aDefence));
    lambdaAway = Math.min(4.5, Math.max(0.1, leagueAway! * aAttack * hDefence));
  }

  let homeWin = 0, draw = 0, awayWin = 0;
  if (!reasons.length && lambdaHome !== null && lambdaAway !== null) {
    const hp = Array.from({length: maxGoals + 1}, (_, g) => poissonPmf(lambdaHome!, g));
    const ap = Array.from({length: maxGoals + 1}, (_, g) => poissonPmf(lambdaAway!, g));
    for (let h = 0; h <= maxGoals; h++) for (let a = 0; a <= maxGoals; a++) {
      const p = hp[h]! * ap[a]!;
      if (h > a) homeWin += p; else if (h === a) draw += p; else awayWin += p;
    }
    const total = homeWin + draw + awayWin;
    if (total > 0) { homeWin /= total; draw /= total; awayWin /= total; }
  }

  const evidenceState = reasons.length ? "insufficient_evidence" : "unverified";
  return {
    forecast: {
      fixtureId: input.fixtureId, modelId: "poisson-baseline", modelVersion: "0.1.0",
      generatedAt: input.generatedAt, featureCutoffAt: input.generatedAt,
      homeWin: reasons.length ? null : homeWin, draw: reasons.length ? null : draw, awayWin: reasons.length ? null : awayWin,
      evidenceState, abstentionReasons: reasons.length ? reasons : ["baseline_not_yet_calibrated_for_betting"]
    },
    diagnostics: { homeSamples: homeMatches.length, awaySamples: awayMatches.length, leagueSamples: eligible.length,
      expectedHomeGoals: reasons.length ? null : lambdaHome, expectedAwayGoals: reasons.length ? null : lambdaAway, method: "poisson-baseline" }
  };
}
