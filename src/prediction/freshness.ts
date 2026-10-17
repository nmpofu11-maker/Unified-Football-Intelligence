export type FixtureFreshnessResult =
  | { state: "fresh"; ageMinutes: number; maxAgeMinutes: number }
  | { state: "stale"; ageMinutes: number; maxAgeMinutes: number }
  | { state: "invalid"; reason: "invalid_timestamp" | "invalid_max_age" | "timestamp_in_future"; ageMinutes?: number; maxAgeMinutes?: number };

/** Fail-closed freshness check for corroborated fixture evidence. */
export function checkFixtureFreshness(
  updatedAt: string | Date,
  generatedAt: string | Date,
  maxAgeMinutes: number,
  allowedClockSkewMinutes = 5
): FixtureFreshnessResult {
  const updatedMs = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  const generatedMs = generatedAt instanceof Date ? generatedAt.getTime() : Date.parse(generatedAt);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(generatedMs)) {
    return { state: "invalid", reason: "invalid_timestamp" };
  }
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0 || maxAgeMinutes > 10080) {
    return { state: "invalid", reason: "invalid_max_age" };
  }
  const ageMinutes = (generatedMs - updatedMs) / 60000;
  if (ageMinutes < -Math.max(0, allowedClockSkewMinutes)) {
    return { state: "invalid", reason: "timestamp_in_future", ageMinutes, maxAgeMinutes };
  }
  const nonNegativeAge = Math.max(0, ageMinutes);
  return nonNegativeAge > maxAgeMinutes
    ? { state: "stale", ageMinutes: nonNegativeAge, maxAgeMinutes }
    : { state: "fresh", ageMinutes: nonNegativeAge, maxAgeMinutes };
}
