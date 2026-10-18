export type TicketMarket = "1x2" | "btts" | "total_goals" | "double_chance" | "draw_no_bet";
export type TicketPick =
  | "home" | "draw" | "away"
  | "yes" | "no"
  | "over" | "under"
  | "home_draw" | "home_away" | "draw_away";
export type SelectionState = "pending" | "won" | "lost" | "void" | "withheld";
export type TicketState = "pending" | "won" | "lost" | "void" | "withheld";

export interface VerifiedSettledResult {
  fixtureId: string;
  kickoffUtc: string;
  settledAt: string;
  homeGoals: number;
  awayGoals: number;
  evidenceState: "verified" | "unverified" | "conflicted";
  fixtureStatus: "finished" | "scheduled" | "live" | "postponed" | "cancelled" | "abandoned" | "unknown";
}

export interface TicketSelection {
  selectionId: string;
  fixtureId: string;
  market: TicketMarket;
  pick: TicketPick;
  /** Required only for total_goals; e.g. 2.5. */
  line?: number;
}

export interface SelectionSettlement extends TicketSelection {
  state: SelectionState;
  reason?: string;
}

export interface TicketSettlement {
  state: TicketState;
  selections: SelectionSettlement[];
  reason: string;
}

function validResult(result: VerifiedSettledResult, expectedFixtureId: string): boolean {
  const kickoff = Date.parse(result.kickoffUtc);
  const settled = Date.parse(result.settledAt);
  return result.fixtureId === expectedFixtureId &&
    result.evidenceState === "verified" &&
    result.fixtureStatus === "finished" &&
    Number.isFinite(kickoff) && Number.isFinite(settled) &&
    settled >= kickoff &&
    Number.isInteger(result.homeGoals) && result.homeGoals >= 0 &&
    Number.isInteger(result.awayGoals) && result.awayGoals >= 0;
}

function selectionOutcome(selection: TicketSelection, result: VerifiedSettledResult): SelectionState {
  const { homeGoals, awayGoals } = result;
  const outcome = homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw";

  switch (selection.market) {
    case "1x2":
      if (selection.pick !== "home" && selection.pick !== "draw" && selection.pick !== "away") return "withheld";
      return selection.pick === outcome ? "won" : "lost";
    case "btts": {
      if (selection.pick !== "yes" && selection.pick !== "no") return "withheld";
      const bothScore = homeGoals > 0 && awayGoals > 0;
      return (selection.pick === "yes") === bothScore ? "won" : "lost";
    }
    case "total_goals": {
      if ((selection.pick !== "over" && selection.pick !== "under") ||
          typeof selection.line !== "number" || !Number.isFinite(selection.line) || selection.line < 0) return "withheld";
      const total = homeGoals + awayGoals;
      if (total === selection.line) return "void";
      return selection.pick === "over" ? (total > selection.line ? "won" : "lost") : (total < selection.line ? "won" : "lost");
    }
    case "double_chance":
      if (selection.pick !== "home_draw" && selection.pick !== "home_away" && selection.pick !== "draw_away") return "withheld";
      if (selection.pick === "home_draw") return outcome === "home" || outcome === "draw" ? "won" : "lost";
      if (selection.pick === "home_away") return outcome === "draw" ? "lost" : "won";
      return outcome === "draw" || outcome === "away" ? "won" : "lost";
    case "draw_no_bet":
      if (selection.pick !== "home" && selection.pick !== "away") return "withheld";
      if (outcome === "draw") return "void";
      return selection.pick === outcome ? "won" : "lost";
    default:
      return "withheld";
  }
}

/**
 * Evaluate a multi-selection ticket from verified settled results only.
 * A single verified losing selection immediately makes the ticket lost, even
 * when other fixtures remain pending. Missing/conflicted results never count
 * as wins or losses and therefore cannot fabricate a settlement.
 */
export function settleTicket(
  selections: TicketSelection[],
  resultsByFixture: ReadonlyMap<string, VerifiedSettledResult>
): TicketSettlement {
  if (!Array.isArray(selections) || selections.length === 0) {
    return { state: "withheld", selections: [], reason: "ticket_requires_at_least_one_selection" };
  }
  const ids = new Set<string>();
  for (const selection of selections) {
    if (!selection.selectionId.trim() || !selection.fixtureId.trim() || ids.has(selection.selectionId)) {
      return { state: "withheld", selections: [], reason: "invalid_or_duplicate_selection_identity" };
    }
    ids.add(selection.selectionId);
  }

  const evaluated: SelectionSettlement[] = selections.map(selection => {
    const result = resultsByFixture.get(selection.fixtureId);
    if (!result) return { ...selection, state: "pending", reason: "verified_settled_result_not_available" };
    if (!validResult(result, selection.fixtureId)) {
      return { ...selection, state: "pending", reason: "result_not_verified_or_fixture_identity_invalid" };
    }
    const state = selectionOutcome(selection, result);
    return { ...selection, state, ...(state === "withheld" ? { reason: "unsupported_or_invalid_market_pick" } : {}) };
  });

  if (evaluated.some(selection => selection.state === "lost")) {
    return { state: "lost", selections: evaluated, reason: "at_least_one_selection_lost_on_verified_result" };
  }
  if (evaluated.some(selection => selection.state === "withheld")) {
    return { state: "withheld", selections: evaluated, reason: "one_or_more_selections_cannot_be_evaluated" };
  }
  if (evaluated.some(selection => selection.state === "pending")) {
    return { state: "pending", selections: evaluated, reason: "awaiting_verified_settled_results_for_remaining_selections" };
  }
  if (evaluated.every(selection => selection.state === "void")) {
    return { state: "void", selections: evaluated, reason: "all_selections_void" };
  }
  return { state: "won", selections: evaluated, reason: "all_selections_won_or_void_and_at_least_one_won" };
}
