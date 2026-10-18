# Verified ticket settlement

The app now has a PostgreSQL-backed ticket store and an authenticated settlement API. This is a first integration slice; it is not yet a connection to BetMatrix's existing ticket database and does not run a background polling worker.

## Rules

- Only a result marked `verified`, with matching canonical fixture identity, corroborated fixture evidence, finished status, valid score, and a settlement timestamp at/after kickoff can settle a selection.
- A single verified losing selection makes the whole ticket `lost` immediately, even while other fixtures remain pending.
- Missing, conflicted, unverified, or mismatched results stay pending; they are never treated as wins.
- Supported markets: 1X2, both-teams-to-score, total goals, double chance, and draw-no-bet.
- Draw-no-bet draws and totals exactly equal to the selected line are treated as void.
- A ticket is `won` only when every selection is resolved as won or void and at least one selection won. An all-void ticket is `void`.
- Invalid ticket identity or unsupported market/pick combinations are withheld.

## Authenticated API

All ticket endpoints require `x-provider-diagnostics-token` matching the server's `PROVIDER_DIAGNOSTICS_TOKEN`. In production, ticket endpoints are disabled if that token is not configured.

- `POST /api/tickets`: create a pending ticket. Body fields: `ticketId`, numeric `stakeAmount`, numeric `potentialPayout`, and `selections`. Each selection contains `selectionId`, exact `fixtureId` (the canonical key), `market`, `pick`, and `line` for total-goals markets.
- `GET /api/tickets?limit=50`: list stored tickets (limit is bounded to 1–100).
- `POST /api/tickets/reconcile`: manually re-evaluate pending tickets against the verified result store.

After each fresh provider fixture/result ingestion cycle, the server also re-evaluates pending tickets against `verified_settled_results`. Raw provider observations are never sufficient to settle a ticket. If the provider request is served from cache, no new result evidence is promoted in that request.

Every state change writes a `ticket_settlement_events` audit row containing the previous/next status, a compact evidence snapshot, reason, and evaluation timestamp.

## Integration boundary

This adds persistent ticket records to Unified Football Intelligence. It does **not** import tickets automatically from BetMatrix or prove live provider/database operation. Tickets must be submitted to the API, the server must have a working PostgreSQL database and provider credentials, and real verified result ingestion must be live-tested before describing settlement as operational in production.

Run `npm run typecheck`, `npm test`, and `npm run build` for code checks.
