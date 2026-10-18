export interface EvaluationCandidate {
  fixtureId: string;
  modelId: string;
  modelVersion: string;
  generatedAt: string;
  featureCutoffAt: string;
  kickoffUtc: string;
  probabilities: { homeWin: number | null; draw: number | null; awayWin: number | null };
  fixtureEvidenceState: "corroborated" | "conflicted";
  fixtureStatus: "finished" | "scheduled" | "live" | "postponed" | "cancelled" | "abandoned" | "unknown";
  resultEvidenceState: "verified" | "conflicted";
  resultVerifiedAt: string;
  homeGoals: number;
  awayGoals: number;
}

export type OutOfSampleEvaluation = {
  state: "insufficient";
  method: "latest_pre_kickoff_forecast_per_fixture";
  sampleSize: number;
  minimumSampleSize: number;
  brierScore: null;
  logLoss: null;
  accuracy: null;
  note: string;
} | {
  state: "evaluated";
  method: "latest_pre_kickoff_forecast_per_fixture";
  sampleSize: number;
  minimumSampleSize: number;
  brierScore: number;
  logLoss: number;
  accuracy: number;
  note: string;
};

function validProbabilityTriplet(p: EvaluationCandidate["probabilities"]): boolean {
  const values = [p.homeWin, p.draw, p.awayWin];
  return values.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) &&
    Math.abs((p.homeWin as number) + (p.draw as number) + (p.awayWin as number) - 1) <= 0.002;
}

/** Strict chronological evaluation; no in-sample or unresolved result enters the metrics. */
export function evaluateOutOfSample(candidates: EvaluationCandidate[], minimumSampleSize = 30): OutOfSampleEvaluation {
  if (!Number.isInteger(minimumSampleSize) || minimumSampleSize < 1 || minimumSampleSize > 100000) {
    return { state: "insufficient", method: "latest_pre_kickoff_forecast_per_fixture", sampleSize: 0,
      minimumSampleSize: 30, brierScore: null, logLoss: null, accuracy: null,
      note: "Invalid minimum sample policy; metrics withheld." };
  }
  const eligible = candidates.filter(c => {
    const generated = Date.parse(c.generatedAt), cutoff = Date.parse(c.featureCutoffAt);
    const kickoff = Date.parse(c.kickoffUtc), verified = Date.parse(c.resultVerifiedAt);
    return Boolean(c.fixtureId.trim() && c.modelId.trim() && c.modelVersion.trim()) &&
      Number.isFinite(generated) && Number.isFinite(cutoff) && Number.isFinite(kickoff) && Number.isFinite(verified) &&
      generated < kickoff && cutoff <= generated && verified >= kickoff &&
      c.fixtureEvidenceState === "corroborated" && c.fixtureStatus === "finished" &&
      c.resultEvidenceState === "verified" &&
      Number.isInteger(c.homeGoals) && c.homeGoals >= 0 &&
      Number.isInteger(c.awayGoals) && c.awayGoals >= 0 &&
      validProbabilityTriplet(c.probabilities);
  });

  // A fixture/model contributes at most once: use its latest eligible pre-kickoff snapshot.
  const latest = new Map<string, EvaluationCandidate>();
  for (const candidate of eligible) {
    const key = candidate.fixtureId + "|" + candidate.modelId + "|" + candidate.modelVersion;
    const prior = latest.get(key);
    if (!prior || Date.parse(candidate.generatedAt) > Date.parse(prior.generatedAt)) latest.set(key, candidate);
  }
  const rows = [...latest.values()];
  if (rows.length < minimumSampleSize) {
    return { state: "insufficient", method: "latest_pre_kickoff_forecast_per_fixture", sampleSize: rows.length,
      minimumSampleSize, brierScore: null, logLoss: null, accuracy: null,
      note: "Metrics are withheld until the minimum genuinely chronological, verified sample is available. No placeholder performance values are reported." };
  }

  let brierTotal = 0, logLossTotal = 0, correct = 0;
  const epsilon = 1e-15;
  for (const row of rows) {
    const actual: 0 | 1 | 2 = row.homeGoals > row.awayGoals ? 0 : row.homeGoals < row.awayGoals ? 2 : 1;
    const p: [number, number, number] = [row.probabilities.homeWin as number, row.probabilities.draw as number, row.probabilities.awayWin as number];
    brierTotal += p.reduce((sum, value, index) => sum + (value - (index === actual ? 1 : 0)) ** 2, 0);
    logLossTotal += -Math.log(Math.max(epsilon, p[actual]));
    if (p.indexOf(Math.max(...p)) === actual) correct++;
  }
  return { state: "evaluated", method: "latest_pre_kickoff_forecast_per_fixture", sampleSize: rows.length,
    minimumSampleSize, brierScore: brierTotal / rows.length, logLoss: logLossTotal / rows.length,
    accuracy: correct / rows.length,
    note: "Chronological evaluation only; it is not calibration approval or evidence that betting recommendations are safe." };
}
