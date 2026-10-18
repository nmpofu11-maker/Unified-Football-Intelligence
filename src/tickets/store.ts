import { Pool, type PoolClient } from "pg";
import { settleTicket, type TicketSelection, type VerifiedSettledResult } from "./settlement.js";
import { getCanonicalEvidenceSummary } from "../storage/postgresObservations.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  allowExitOnIdle: true
});
pool.on("error", () => { /* Do not log credentials or connection strings. */ });

export async function ensureTicketSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_records (
      ticket_id TEXT PRIMARY KEY,
      stake_amount NUMERIC(12,2) NOT NULL CHECK (stake_amount >= 0),
      potential_payout NUMERIC(12,2) NOT NULL CHECK (potential_payout >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending','won','lost','void','withheld')),
      selections JSONB NOT NULL,
      settlement JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (length(trim(ticket_id)) > 0)
    );
    CREATE TABLE IF NOT EXISTS ticket_settlement_events (
      id BIGSERIAL PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES ticket_records(ticket_id),
      previous_status TEXT NOT NULL,
      next_status TEXT NOT NULL,
      evidence_snapshot JSONB NOT NULL,
      reason TEXT NOT NULL,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ticket_records_status_idx ON ticket_records(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS ticket_settlement_events_ticket_idx ON ticket_settlement_events(ticket_id, evaluated_at DESC);
  `);
}

function isSelection(value: unknown): value is TicketSelection {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<TicketSelection>;
  const markets = ["1x2", "btts", "total_goals", "double_chance", "draw_no_bet"];
  const picks = ["home", "draw", "away", "yes", "no", "over", "under", "home_draw", "home_away", "draw_away"];
  const source = s.sourceMetadata;
  const sourceMetadataValid = source === undefined || (
    typeof source === "object" && source !== null &&
    source.sourceApp === "BetMatrix" &&
    typeof source.sourceTicketId === "string" && source.sourceTicketId.length <= 200 &&
    typeof source.sourceMarket === "string" && source.sourceMarket.length <= 160 &&
    typeof source.sourceHomeTeam === "string" && source.sourceHomeTeam.length <= 200 &&
    typeof source.sourceAwayTeam === "string" && source.sourceAwayTeam.length <= 200 &&
    (source.sourceOdds === undefined || (typeof source.sourceOdds === "number" && Number.isFinite(source.sourceOdds) && source.sourceOdds > 0))
  );
  return typeof s.selectionId === "string" && Boolean(s.selectionId.trim()) && s.selectionId.length <= 160 &&
    typeof s.fixtureId === "string" && Boolean(s.fixtureId.trim()) && s.fixtureId.length <= 500 &&
    typeof s.market === "string" && markets.includes(s.market) &&
    typeof s.pick === "string" && picks.includes(s.pick) &&
    (s.market !== "total_goals" || (typeof s.line === "number" && Number.isFinite(s.line) && s.line >= 0)) &&
    sourceMetadataValid;
}

export interface CreateTicketInput {
  ticketId: string;
  stakeAmount: number;
  potentialPayout: number;
  selections: TicketSelection[];
}

export async function createTicket(input: CreateTicketInput) {
  if (!process.env.DATABASE_URL?.trim()) return { state: "unavailable" as const, reason: "database_not_configured" };
  if (!input.ticketId.trim() || input.ticketId.length > 200 ||
      !Number.isFinite(input.stakeAmount) || input.stakeAmount < 0 ||
      !Number.isFinite(input.potentialPayout) || input.potentialPayout < 0 ||
      !Array.isArray(input.selections) || input.selections.length === 0 ||
      input.selections.length > 100 || !input.selections.every(isSelection)) {
    return { state: "invalid_input" as const, reason: "ticket_identity_amounts_and_valid_selections_required" };
  }
  if (new Set(input.selections.map(s => s.selectionId)).size !== input.selections.length) {
    return { state: "invalid_input" as const, reason: "duplicate_selection_id" };
  }
  try {
    await ensureTicketSchema();
    const result = await pool.query(
      `INSERT INTO ticket_records(ticket_id, stake_amount, potential_payout, status, selections)
       VALUES($1,$2,$3,'pending',$4::jsonb)
       ON CONFLICT(ticket_id) DO NOTHING
       RETURNING ticket_id, stake_amount, potential_payout, status, selections, created_at, updated_at`,
      [input.ticketId.trim(), input.stakeAmount, input.potentialPayout, JSON.stringify(input.selections)]
    );
    if (!result.rowCount) return { state: "conflict" as const, reason: "ticket_id_already_exists" };
    return { state: "saved" as const, ticket: result.rows[0] };
  } catch {
    return { state: "error" as const, reason: "ticket_store_unavailable" };
  }
}

type BetMatrixImportLeg = {
  id?: unknown; homeTeam?: unknown; awayTeam?: unknown; targetTeam?: unknown;
  market?: unknown; odds?: unknown; league?: unknown; kickoffISO?: unknown;
  apiFootballFixtureId?: unknown; sportApiFixtureId?: unknown; theRundownId?: unknown;
};
type BetMatrixImportTicket = {
  id?: unknown; placedAt?: unknown; type?: unknown; status?: unknown; platform?: unknown;
  stakeZar?: unknown; potentialPayoutZar?: unknown; actualPayoutZar?: unknown;
  totalOdds?: unknown; profitZar?: unknown; legs?: unknown;
};
type ImportableCanonicalFixture = {
  canonical_key: string; kickoff_utc: Date; home_name: string; away_name: string;
  competition_name: string; status: string;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function importString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normaliseImportLabel(value: string): string {
  return value.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase().replace(/\\b(fc|afc|sc|cf)\\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\\s+/g, " ");
}
function parseBetMatrixMarket(
  leg: BetMatrixImportLeg,
  sourceHomeTeam: string,
  sourceAwayTeam: string
): { market: TicketMarket; pick: TicketPick; line?: number } | { reason: string } {
  const market = importString(leg.market) ?? "";
  const target = importString(leg.targetTeam) ?? "";
  const raw = (market + " " + target).toLowerCase().replace(/[_-]+/g, " ");
  const marketNorm = normaliseImportLabel(market);
  const targetNorm = normaliseImportLabel(target);
  const cleanTarget = targetNorm.replace(/\\b(win|wins|winner|to win)\\b/g, " ").trim().replace(/\\s+/g, " ");

  if (/both teams to score|\\bbtts\\b/.test(raw)) {
    if (/\\b(no|not|false)\\b/.test(target.toLowerCase())) return { market: "btts", pick: "no" };
    if (/\\b(yes|true)\\b/.test(target.toLowerCase())) return { market: "btts", pick: "yes" };
    if (/\\bbtts no\\b/.test(raw)) return { market: "btts", pick: "no" };
    if (/\\bbtts yes\\b/.test(raw)) return { market: "btts", pick: "yes" };
    return { reason: "btts_selection_must_explicitly_say_yes_or_no" };
  }
  if (/double chance/.test(marketNorm)) {
    if (/\\b1x\\b|home or draw|home\\/draw|1 or x/.test(raw)) return { market: "double_chance", pick: "home_draw" };
    if (/\\bx2\\b|draw or away|draw\\/away|x or 2/.test(raw)) return { market: "double_chance", pick: "draw_away" };
    if (/\\b12\\b|home or away|home\\/away|1 or 2/.test(raw)) return { market: "double_chance", pick: "home_away" };
    const home = normaliseImportLabel(sourceHomeTeam);
    const away = normaliseImportLabel(sourceAwayTeam);
    if (targetNorm.includes(home) && /draw/.test(raw)) return { market: "double_chance", pick: "home_draw" };
    if (targetNorm.includes(away) && /draw/.test(raw)) return { market: "double_chance", pick: "draw_away" };
    if (targetNorm.includes(home) && targetNorm.includes(away)) return { market: "double_chance", pick: "home_away" };
    return { reason: "unsupported_or_ambiguous_double_chance_pick" };
  }
  if (/draw no bet/.test(marketNorm)) {
    if (/\\b(home|1)\\b/.test(target.toLowerCase()) || cleanTarget === normaliseImportLabel(sourceHomeTeam)) return { market: "draw_no_bet", pick: "home" };
    if (/\\b(away|2)\\b/.test(target.toLowerCase()) || cleanTarget === normaliseImportLabel(sourceAwayTeam)) return { market: "draw_no_bet", pick: "away" };
    return { reason: "draw_no_bet_pick_must_identify_home_or_away_team" };
  }
  if (/over.?under|total goals|goals over|goals under|\\bo\\/u\\b/.test(raw)) {
    const numbers = raw.match(/\\d+(?:\\.\\d+)?/g) ?? [];
    const line = numbers.length ? Number(numbers[numbers.length - 1]) : Number.NaN;
    if (!Number.isFinite(line) || line < 0) return { reason: "total_goals_line_missing_or_invalid" };
    const targetLower = target.toLowerCase();
    const over = /\\bover\\b/.test(targetLower) || (/\\bover\\b/.test(market.toLowerCase()) && !/\\bunder\\b/.test(market.toLowerCase()));
    const under = /\\bunder\\b/.test(targetLower) || (/\\bunder\\b/.test(market.toLowerCase()) && !/\\bover\\b/.test(market.toLowerCase()));
    if (over === under) return { reason: "total_goals_pick_must_explicitly_say_over_or_under" };
    return { market: "total_goals", pick: over ? "over" : "under", line };
  }
  if (/1x2|match result|full.?time result|match winner|moneyline|\\bwinner\\b|\\bresult\\b|\\bfull time\\b/.test(marketNorm)) {
    if (/\\b(draw|tie|x)\\b/.test(target.toLowerCase()) || targetNorm === "x") return { market: "1x2", pick: "draw" };
    if (/\\bhome\\b/.test(target.toLowerCase()) || cleanTarget === "1") return { market: "1x2", pick: "home" };
    if (/\\baway\\b/.test(target.toLowerCase()) || cleanTarget === "2") return { market: "1x2", pick: "away" };
    if (cleanTarget === normaliseImportLabel(sourceHomeTeam)) return { market: "1x2", pick: "home" };
    if (cleanTarget === normaliseImportLabel(sourceAwayTeam)) return { market: "1x2", pick: "away" };
    return { reason: "match_result_pick_does_not_match_either_fixture_team_or_draw" };
  }
  return { reason: "unsupported_betmatrix_market" };
}
function invertImportedPick(selection: { market: TicketMarket; pick: TicketPick; line?: number }): { market: TicketMarket; pick: TicketPick; line?: number } {
  if ((selection.market === "1x2" || selection.market === "draw_no_bet") && selection.pick === "home") return { ...selection, pick: "away" };
  if ((selection.market === "1x2" || selection.market === "draw_no_bet") && selection.pick === "away") return { ...selection, pick: "home" };
  if (selection.market === "double_chance" && selection.pick === "home_draw") return { ...selection, pick: "draw_away" };
  if (selection.market === "double_chance" && selection.pick === "draw_away") return { ...selection, pick: "home_draw" };
  return selection;
}

/** Import only BetMatrix tickets. Source odds/status and learned matrices are never model inputs or trusted settlement evidence. */
export async function importBetMatrixBackup(payload: unknown) {
  if (!process.env.DATABASE_URL?.trim()) return { state: "not_configured" as const, reason: "database_not_configured" };
  if (!isRecord(payload) || !Array.isArray(payload.tickets) || payload.tickets.length < 1 || payload.tickets.length > 500) {
    return { state: "invalid_input" as const, reason: "betmatrix_backup_must_contain_between_1_and_500_tickets" };
  }
  const canonicalState = await getCanonicalEvidenceSummary();
  if (canonicalState.state !== "ready") {
    return { state: canonicalState.state === "not_configured" ? "not_configured" as const : "error" as const, reason: canonicalState.errorCode ?? "canonical_evidence_not_ready" };
  }

  const tickets = payload.tickets as BetMatrixImportTicket[];
  const kickoffValues: string[] = [];
  let totalLegs = 0;
  for (const ticket of tickets) {
    if (!isRecord(ticket) || !Array.isArray(ticket.legs)) continue;
    totalLegs += ticket.legs.length;
    for (const rawLeg of ticket.legs) {
      if (!isRecord(rawLeg)) continue;
      const kickoff = importString(rawLeg.kickoffISO);
      if (kickoff && Number.isFinite(Date.parse(kickoff)) && /(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(kickoff)) kickoffValues.push(new Date(kickoff).toISOString());
    }
  }
  if (totalLegs > 5000) return { state: "invalid_input" as const, reason: "backup_exceeds_5000_total_legs" };
  const uniqueKickoffs = [...new Set(kickoffValues)];
  let fixtures: ImportableCanonicalFixture[] = [];
  if (uniqueKickoffs.length) {
    const fixtureRows = await pool.query<ImportableCanonicalFixture>(`
      SELECT canonical_key, kickoff_utc, home_name, away_name, competition_name, status
      FROM canonical_fixture_evidence f
      WHERE identity_reviewed = TRUE AND evidence_state = 'corroborated'
        AND status IN ('scheduled','live','finished')
        AND NOT (status = 'live' AND kickoff_utc < NOW() - INTERVAL '6 hours')
        AND EXISTS (
          SELECT 1 FROM unnest($1::timestamptz[]) AS requested(kickoff)
          WHERE f.kickoff_utc BETWEEN requested.kickoff - INTERVAL '36 hours'
                                  AND requested.kickoff + INTERVAL '36 hours'
        )
    `, [uniqueKickoffs]);
    fixtures = fixtureRows.rows;
  }

  const imported: Array<{ sourceTicketId: string; ticketId: string; selections: number; state: string }> = [];
  const rejected: Array<{ sourceTicketId?: string; reason: string; legIndex?: number }> = [];
  const skipped: Array<{ sourceTicketId: string; reason: string }> = [];
  const sourcePlatform = importString(payload.platform) ?? "Hollywoodbets BetMatrix AI";

  for (const ticket of tickets) {
    const sourceTicketId = importString(ticket?.id);
    if (!sourceTicketId || !Array.isArray(ticket?.legs) || ticket.legs.length === 0 || ticket.legs.length > 100) {
      rejected.push({ ...(sourceTicketId ? { sourceTicketId } : {}), reason: "ticket_id_and_1_to_100_legs_required" });
      continue;
    }
    if (typeof ticket.stakeZar !== "number" || !Number.isFinite(ticket.stakeZar) || ticket.stakeZar < 0 ||
        typeof ticket.potentialPayoutZar !== "number" || !Number.isFinite(ticket.potentialPayoutZar) || ticket.potentialPayoutZar < 0) {
      rejected.push({ sourceTicketId, reason: "valid_stake_and_potential_payout_required" });
      continue;
    }

    const selections: TicketSelection[] = [];
    let legFailure: { reason: string; legIndex: number } | undefined;
    for (let index = 0; index < ticket.legs.length; index++) {
      const rawLeg = ticket.legs[index];
      if (!isRecord(rawLeg)) { legFailure = { reason: "invalid_leg_shape", legIndex: index }; break; }
      const leg = rawLeg as BetMatrixImportLeg;
      const homeTeam = importString(leg.homeTeam);
      const awayTeam = importString(leg.awayTeam);
      const kickoffISO = importString(leg.kickoffISO);
      const market = importString(leg.market);
      const targetTeam = importString(leg.targetTeam) ?? "";
      const league = importString(leg.league);
      if (!homeTeam || !awayTeam || !market) { legFailure = { reason: "home_away_and_market_required", legIndex: index }; break; }
      if (!kickoffISO || !Number.isFinite(Date.parse(kickoffISO)) || !/(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(kickoffISO)) {
        legFailure = { reason: "fixture_kickoff_required_as_timezone_aware_iso", legIndex: index }; break;
      }

      const sourceKickoff = Date.parse(kickoffISO);
      const homeKey = normaliseImportLabel(homeTeam);
      const awayKey = normaliseImportLabel(awayTeam);
      const leagueKey = league ? normaliseImportLabel(league) : "";
      const matches = fixtures.flatMap(fixture => {
        const canonicalHome = normaliseImportLabel(fixture.home_name);
        const canonicalAway = normaliseImportLabel(fixture.away_name);
        const same = canonicalHome === homeKey && canonicalAway === awayKey;
        const reversed = canonicalHome === awayKey && canonicalAway === homeKey;
        const kickoff = Date.parse(fixture.kickoff_utc.toString());
        const leagueMatches = !leagueKey || normaliseImportLabel(fixture.competition_name) === leagueKey;
        return (same || reversed) && leagueMatches && Number.isFinite(kickoff) && Math.abs(kickoff - sourceKickoff) <= 36 * 60 * 60 * 1000
          ? [{ fixture, reversed }] : [];
      });
      if (matches.length === 0) { legFailure = { reason: "no_unique_identity_gated_fixture_matches_exact_teams_competition_and_kickoff", legIndex: index }; break; }
      if (matches.length > 1) { legFailure = { reason: "ambiguous_canonical_fixture_match", legIndex: index }; break; }

      const parsed = parseBetMatrixMarket(leg, homeTeam, awayTeam);
      if ("reason" in parsed) { legFailure = { reason: parsed.reason, legIndex: index }; break; }
      const mapped = matches[0]!.reversed ? invertImportedPick(parsed) : parsed;
      const odds = typeof leg.odds === "number" && Number.isFinite(leg.odds) && leg.odds > 0 ? leg.odds : undefined;
      selections.push({
        selectionId: sourceTicketId + ":" + (importString(leg.id) ?? String(index + 1)),
        fixtureId: matches[0]!.fixture.canonical_key,
        market: mapped.market,
        pick: mapped.pick,
        ...(mapped.market === "total_goals" && mapped.line !== undefined ? { line: mapped.line } : {}),
        sourceMetadata: {
          sourceApp: "BetMatrix",
          sourceTicketId,
          sourcePlatform: importString(ticket.platform) ?? sourcePlatform,
          ...(importString(ticket.status) ? { sourceTicketStatus: importString(ticket.status)! } : {}),
          ...(importString(ticket.type) ? { sourceTicketType: importString(ticket.type)! } : {}),
          ...(importString(ticket.placedAt) ? { sourcePlacedAt: importString(ticket.placedAt)! } : {}),
          ...(typeof ticket.totalOdds === "number" && Number.isFinite(ticket.totalOdds) ? { sourceTotalOdds: ticket.totalOdds } : {}),
          ...(typeof ticket.actualPayoutZar === "number" && Number.isFinite(ticket.actualPayoutZar) ? { sourceActualPayoutZar: ticket.actualPayoutZar } : {}),
          ...(typeof ticket.profitZar === "number" && Number.isFinite(ticket.profitZar) ? { sourceProfitZar: ticket.profitZar } : {}),
          ...(importString(leg.id) ? { sourceLegId: importString(leg.id)! } : {}),
          sourceMarket: market,
          ...(targetTeam ? { sourceTargetTeam: targetTeam } : {}),
          ...(odds !== undefined ? { sourceOdds: odds } : {}),
          sourceHomeTeam: homeTeam,
          sourceAwayTeam: awayTeam,
          ...(league ? { sourceLeague: league } : {}),
          sourceKickoffISO: kickoffISO,
          sourceProviderFixtureIds: {
            ...(leg.apiFootballFixtureId !== undefined ? { apiFootball: String(leg.apiFootballFixtureId) } : {}),
            ...(leg.sportApiFixtureId !== undefined ? { sportApi: String(leg.sportApiFixtureId) } : {}),
            ...(leg.theRundownId !== undefined ? { theRundown: String(leg.theRundownId) } : {})
          }
        }
      });
    }
    if (legFailure) { rejected.push({ sourceTicketId, ...legFailure }); continue; }

    const ticketId = "betmatrix:" + sourceTicketId;
    const saved = await createTicket({ ticketId, stakeAmount: ticket.stakeZar, potentialPayout: ticket.potentialPayoutZar, selections });
    if (saved.state === "saved") imported.push({ sourceTicketId, ticketId, selections: selections.length, state: "imported" });
    else if (saved.state === "conflict") skipped.push({ sourceTicketId, reason: "ticket_already_imported" });
    else rejected.push({ sourceTicketId, reason: saved.reason ?? "ticket_store_unavailable" });
  }

  const settlement = imported.length ? await reconcilePendingTickets() : undefined;
  return {
    state: "ready" as const, sourceApp: "BetMatrix",
    importedCount: imported.length, skippedCount: skipped.length, rejectedCount: rejected.length,
    imported, skipped, rejected, ...(settlement ? { settlement } : {}),
    note: "Imported source ticket statuses and odds are audit metadata only. Every imported ticket starts pending and is settled by this app only from identity-gated, verified canonical results. Unsupported markets or ambiguous fixtures are rejected, not guessed."
  };
}

export async function listTickets(limit = 50) {
  if (!process.env.DATABASE_URL?.trim()) return { state: "not_configured" as const, tickets: [] };
  const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50;
  try {
    await ensureTicketSchema();
    const result = await pool.query(
      `SELECT ticket_id, stake_amount, potential_payout, status, selections, settlement, created_at, updated_at
       FROM ticket_records ORDER BY updated_at DESC LIMIT $1`, [boundedLimit]
    );
    return { state: "ready" as const, tickets: result.rows };
  } catch {
    return { state: "error" as const, tickets: [], reason: "ticket_store_unavailable" };
  }
}

export async function reconcilePendingTickets() {
  if (!process.env.DATABASE_URL?.trim()) return { state: "not_configured" as const, checked: 0, updated: 0 };
  let client: PoolClient | undefined;
  try {
    const canonicalEvidence = await getCanonicalEvidenceSummary();
    if (canonicalEvidence.state !== "ready") {
      return { state: "error" as const, checked: 0, updated: 0, reason: "canonical_evidence_unavailable" };
    }
    await ensureTicketSchema();
    client = await pool.connect();
    await client.query("BEGIN");
    const pending = await client.query(
      "SELECT ticket_id, stake_amount, potential_payout, status, selections, settlement FROM ticket_records WHERE status = 'pending' FOR UPDATE"
    );
    const resultsQuery = await client.query(
      `SELECT r.canonical_key AS fixture_id, f.kickoff_utc, r.verified_at,
              r.home_goals, r.away_goals, r.evidence_state, f.status AS fixture_status
       FROM verified_settled_results r
       JOIN canonical_fixture_evidence f ON f.canonical_key = r.canonical_key
       WHERE r.evidence_state = 'verified' AND f.evidence_state = 'corroborated'
         AND f.identity_reviewed = TRUE
         AND f.status = 'finished' AND r.verified_at >= f.kickoff_utc`
    );
    const resultsByFixture = new Map<string, VerifiedSettledResult>();
    for (const row of resultsQuery.rows) {
      resultsByFixture.set(row.fixture_id, {
        fixtureId: row.fixture_id,
        kickoffUtc: new Date(row.kickoff_utc).toISOString(),
        settledAt: new Date(row.verified_at).toISOString(),
        homeGoals: Number(row.home_goals),
        awayGoals: Number(row.away_goals),
        evidenceState: row.evidence_state,
        fixtureStatus: row.fixture_status
      });
    }

    let updated = 0;
    for (const ticket of pending.rows) {
      const selections = ticket.selections as TicketSelection[];
      const settlement = settleTicket(selections, resultsByFixture);
      const nextStatus = settlement.state;
      const previousSettlement = ticket.settlement ? JSON.stringify(ticket.settlement) : "";
      const nextSettlement = JSON.stringify(settlement);
      if (nextStatus === ticket.status && previousSettlement === nextSettlement) continue;
      await client.query(
        `UPDATE ticket_records SET status=$2, settlement=$3::jsonb, updated_at=NOW() WHERE ticket_id=$1`,
        [ticket.ticket_id, nextStatus, nextSettlement]
      );
      await client.query(
        `INSERT INTO ticket_settlement_events(ticket_id, previous_status, next_status, evidence_snapshot, reason)
         VALUES($1,$2,$3,$4::jsonb,$5)`,
        [ticket.ticket_id, ticket.status, nextStatus, JSON.stringify({
          selections: settlement.selections.map(s => ({ selectionId: s.selectionId, fixtureId: s.fixtureId, state: s.state })),
          verifiedResultsUsed: [...new Set(settlement.selections.filter(s => s.state === "won" || s.state === "lost" || s.state === "void").map(s => s.fixtureId))]
        }), settlement.reason]
      );
      updated++;
    }
    await client.query("COMMIT");
    return { state: "ready" as const, checked: pending.rowCount ?? 0, updated, verifiedResultsAvailable: resultsByFixture.size };
  } catch {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    return { state: "error" as const, checked: 0, updated: 0, reason: "ticket_settlement_reconciliation_failed" };
  } finally {
    client?.release();
  }
}
