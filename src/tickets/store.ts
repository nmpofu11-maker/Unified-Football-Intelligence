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
  return typeof s.selectionId === "string" && Boolean(s.selectionId.trim()) && s.selectionId.length <= 160 &&
    typeof s.fixtureId === "string" && Boolean(s.fixtureId.trim()) && s.fixtureId.length <= 500 &&
    typeof s.market === "string" && markets.includes(s.market) &&
    typeof s.pick === "string" && picks.includes(s.pick) &&
    (s.market !== "total_goals" || (typeof s.line === "number" && Number.isFinite(s.line) && s.line >= 0));
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

export async function getTicketById(ticketId: string) {
  if (!process.env.DATABASE_URL?.trim()) {
    return { state: "not_configured" as const, ticket: null, reason: "database_not_configured" };
  }
  const id = ticketId.trim();
  if (!id || id.length > 200) {
    return { state: "invalid_input" as const, ticket: null, reason: "ticket_id_invalid" };
  }
  try {
    await ensureTicketSchema();
    const result = await pool.query(
      `SELECT ticket_id, stake_amount, potential_payout, status, selections, settlement, created_at, updated_at
       FROM ticket_records WHERE ticket_id = $1 LIMIT 1`,
      [id]
    );
    return { state: "ready" as const, ticket: result.rows[0] ?? null };
  } catch {
    return { state: "error" as const, ticket: null, reason: "ticket_store_unavailable" };
  }
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
