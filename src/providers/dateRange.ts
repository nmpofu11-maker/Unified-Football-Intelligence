export type HistoricalDateRangeResult =
  | { state: "valid"; from: string; to: string; daysInclusive: number }
  | { state: "invalid"; reason: string };

function parseUtcDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

/** Validates a strictly historical, bounded provider backfill range. */
export function validateHistoricalDateRange(from: string, to: string, todayUtc: string, maxDays = 7): HistoricalDateRangeResult {
  const start = parseUtcDate(from);
  const end = parseUtcDate(to);
  const today = parseUtcDate(todayUtc);
  if (start === null || end === null || today === null) {
    return { state: "invalid", reason: "dates_must_be_real_utc_calendar_dates_in_YYYY_MM_DD_format" };
  }
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 31) {
    return { state: "invalid", reason: "historical_range_policy_invalid" };
  }
  if (start > end) return { state: "invalid", reason: "from_must_not_be_after_to" };
  if (end >= today) return { state: "invalid", reason: "historical_backfill_must_end_before_today_utc" };
  const daysInclusive = Math.floor((end - start) / 86_400_000) + 1;
  if (daysInclusive > maxDays) return { state: "invalid", reason: "historical_range_exceeds_max_days" };
  return { state: "valid", from, to, daysInclusive };
}
