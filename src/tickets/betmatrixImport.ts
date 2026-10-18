import type { TicketMarket, TicketPick } from "./settlement.js";

export interface ExternalFixtureRef {
  provider: "api-football" | "sportmonks" | "sportapi-ai";
  providerFixtureId: string;
}

export interface BetMatrixSelectionCandidate {
  selectionId: string;
  refs: ExternalFixtureRef[];
  market: TicketMarket;
  pick: TicketPick;
  line?: number;
}

export interface BetMatrixTicketCandidate {
  sourceTicketId: string;
  stakeAmount: number;
  potentialPayout: number;
  selections: BetMatrixSelectionCandidate[];
}

export type BetMatrixTicketParseResult =
  | { state: "ready"; ticket: BetMatrixTicketCandidate }
  | { state: "not_pending"; reason: "source_ticket_not_pending" }
  | { state: "invalid"; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function normalise(value: unknown): string {
  return text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9.]+/g, " ").trim().replace(/\s+/g, " ");
}

function parseMarketPick(leg: Record<string, unknown>): { market: TicketMarket; pick: TicketPick; line?: number } | null {
  const market = normalise(leg.market);
  const selectionText = text(leg.selection ?? leg.targetTeam ?? leg.pick);
  const pick = normalise(selectionText);
  const combined = `${market} ${pick}`;
  const home = normalise(leg.homeTeam);
  const away = normalise(leg.awayTeam);

  if (/both teams to score|\bbtts\b/.test(combined)) {
    if (/\b(yes|true|btts yes)\b/.test(pick)) return { market: "btts", pick: "yes" };
    if (/\b(no|false|btts no)\b/.test(pick)) return { market: "btts", pick: "no" };
    return null;
  }

  if (/over.?under|total goals|goals over|goals under|\bo\/u\b/.test(combined)) {
    const lineMatch = combined.match(/(?:over|under|o\/u|total goals|goals over|goals under)[^0-9]{0,8}(\d+(?:\.\d+)?)/)
      || combined.match(/(\d+(?:\.\d+)?)[^a-z]{0,5}(?:over|under)/);
    const line = lineMatch ? Number(lineMatch[1]) : Number.NaN;
    if (!Number.isFinite(line) || line < 0) return null;
    if (/\bover\b/.test(pick) || (/\bover\b/.test(market) && !/\bunder\b/.test(pick))) {
      return { market: "total_goals", pick: "over", line };
    }
    if (/\bunder\b/.test(pick) || (/\bunder\b/.test(market) && !/\bover\b/.test(pick))) {
      return { market: "total_goals", pick: "under", line };
    }
    return null;
  }

  if (/double chance/.test(market)) {
    if (/\b(1x|home or draw|home draw|home\/draw|1 or x)\b/.test(pick)) return { market: "double_chance", pick: "home_draw" };
    if (/\b(x2|draw or away|draw away|draw\/away|x or 2)\b/.test(pick)) return { market: "double_chance", pick: "draw_away" };
    if (/\b(12|home or away|home away|home\/away|1 or 2)\b/.test(pick)) return { market: "double_chance", pick: "home_away" };
    return null;
  }

  if (/draw no bet|\bdnb\b/.test(market)) {
    if (pick === "home" || pick === "1" || (home && pick === home)) return { market: "draw_no_bet", pick: "home" };
    if (pick === "away" || pick === "2" || (away && pick === away)) return { market: "draw_no_bet", pick: "away" };
    return null;
  }

  if (/1x2|match result|full time result|match winner|moneyline|winner|\bresult\b/.test(market)) {
    if (pick === "home" || pick === "1" || (home && pick === home)) return { market: "1x2", pick: "home" };
    if (pick === "draw" || pick === "x" || pick === "tie") return { market: "1x2", pick: "draw" };
    if (pick === "away" || pick === "2" || (away && pick === away)) return { market: "1x2", pick: "away" };
    return null;
  }
  return null;
}

function fixtureRefs(leg: Record<string, unknown>): ExternalFixtureRef[] {
  const refs: ExternalFixtureRef[] = [];
  const add = (provider: ExternalFixtureRef["provider"], value: unknown) => {
    const providerFixtureId = text(value);
    if (providerFixtureId && !refs.some(ref => ref.provider === provider && ref.providerFixtureId === providerFixtureId)) {
      refs.push({ provider, providerFixtureId });
    }
  };
  add("api-football", leg.apiFootballFixtureId);
  add("sportapi-ai", leg.sportApiFixtureId);
  add("sportmonks", leg.sportmonksFixtureId);

  const provider = normalise(leg.provider);
  const genericId = leg.providerFixtureId ?? leg.fixtureId;
  if (/api football|api football|api football/.test(provider) || provider === "api football") add("api-football", genericId);
  else if (/sportmonks/.test(provider)) add("sportmonks", genericId);
  else if (/sportapi/.test(provider)) add("sportapi-ai", genericId);
  return refs;
}

export function parseBetMatrixTicket(value: unknown): BetMatrixTicketParseResult {
  const ticket = record(value);
  if (!ticket) return { state: "invalid", reason: "ticket_must_be_an_object" };
  if (normalise(ticket.status) !== "pending") return { state: "not_pending", reason: "source_ticket_not_pending" };

  const sourceTicketId = text(ticket.id ?? ticket.ticketId);
  if (!sourceTicketId || sourceTicketId.length > 180) return { state: "invalid", reason: "ticket_id_missing_or_too_long" };
  const stakeAmount = Number(ticket.stakeZar ?? ticket.stakeAmount);
  const potentialPayout = Number(ticket.potentialPayoutZar ?? ticket.potentialPayout);
  if (!Number.isFinite(stakeAmount) || stakeAmount < 0 || !Number.isFinite(potentialPayout) || potentialPayout < 0) {
    return { state: "invalid", reason: "ticket_stake_or_potential_payout_invalid" };
  }
  if (!Array.isArray(ticket.legs) || ticket.legs.length === 0 || ticket.legs.length > 100) {
    return { state: "invalid", reason: "ticket_legs_missing_or_out_of_range" };
  }

  const selections: BetMatrixSelectionCandidate[] = [];
  const selectionIds = new Set<string>();
  for (let index = 0; index < ticket.legs.length; index++) {
    const leg = record(ticket.legs[index]);
    if (!leg) return { state: "invalid", reason: `leg_${index + 1}_must_be_an_object` };
    const selectionId = text(leg.id ?? leg.selectionId);
    if (!selectionId || selectionId.length > 160 || selectionIds.has(selectionId)) {
      return { state: "invalid", reason: `leg_${index + 1}_selection_id_missing_or_duplicate` };
    }
    selectionIds.add(selectionId);
    const refs = fixtureRefs(leg);
    if (refs.length === 0) return { state: "invalid", reason: `leg_${index + 1}_has_no_supported_provider_fixture_id` };
    const normalized = parseMarketPick(leg);
    if (!normalized) return { state: "invalid", reason: `leg_${index + 1}_market_or_pick_unsupported_or_ambiguous` };
    selections.push({ selectionId, refs, ...normalized });
  }

  return { state: "ready", ticket: { sourceTicketId, stakeAmount, potentialPayout, selections } };
}
