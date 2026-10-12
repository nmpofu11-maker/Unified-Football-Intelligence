import type { SettledResult } from "../domain/types.js";
export interface Reconciliation<T> { state: "verified" | "conflicted" | "unverified"; selected?: T; candidates: T[]; reasons: string[]; }
/** Conservative reconciliation: never resolves disagreements by provider order. */
export function reconcileSettledResults(results: SettledResult[]): Reconciliation<SettledResult> {
  if (!results.length) return { state: "unverified", candidates: [], reasons: ["no_result_evidence"] };
  if (new Set(results.map(r => r.fixtureId)).size !== 1)
    return { state: "conflicted", candidates: results, reasons: ["fixture_identity_mismatch"] };
  if (new Set(results.map(r => `${r.homeGoals}-${r.awayGoals}`)).size > 1)
    return { state: "conflicted", candidates: results, reasons: ["provider_score_conflict"] };
  const verified = results.filter(r => r.reconciliationState === "verified");
  if (!verified.length) return { state: "unverified", candidates: results, reasons: ["no_verified_result_source"] };
  return { state: "verified", selected: verified[0]!, candidates: results, reasons: [] };
}
