# Delivery status — 2026-10-17

## Implemented on `main`

- Canonical domain contracts, validation and conflict-aware reconciliation.
- SportAPI.ai, Sportmonks and API-Football fixture adapters with explicit diagnostics.
- PostgreSQL append-only provider observations and canonical evidence tables.
- The original 80 favourite-team names remain seeded verbatim; they are not silently rewritten.
- Provider-native team catalogue search, persisted candidates, conservative cross-provider identity review, paced discovery and watchlist diagnostics.
- Evidence-gated prediction pipeline that requires a corroborated future fixture, explicitly reviewed team mappings, and verified settled results from the same competition before kickoff.
- Saved exploratory forecasts include an evidence hash and model diagnostics in a persistent prediction ledger.
- `GET /api/predictions/status` reports database schema readiness and counts for corroborated upcoming fixtures, verified settled results, provider observations, reviewed mappings and saved forecasts.
- `GET /api/predictions/ledger?limit=20` returns a bounded read-only view of recent forecast records.
- `GET /api/status` now reflects the current storage/prediction implementation rather than incorrectly claiming the ledger is not implemented.

## CI verification

The readiness and ledger API change was merged as `6e2d464eedfaae5532bce6944666cec7c0065154`. The status-contract correction was merged as `4065a8f8eef7c0880c1d18673c2db8a2a0b231fc`; the correction's pull-request head CI passed `npm run typecheck`, `npm test`, and `npm run build`. A separate CI result for the squash merge commit itself has not been confirmed here.

## Not yet verified in a live environment

- No confirmed deployment URL or live deployment of the latest `main` revision has been established in this workflow.
- Production PostgreSQL connectivity, evidence-table compatibility and persistence across restart/redeploy still require live checks.
- Provider credentials, quota/competition coverage, and actual fixture ingestion have not been tested here.
- The 80 favourite-team identities and competition mappings need review; search candidates are not verified match history.
- Verified historical-result backfill, team/competition-season completeness, chronological out-of-sample backtesting, calibration, odds ingestion and ticket settlement integration remain outstanding.

## Go/no-go

**Not suitable for betting recommendations or a production-ready claim yet.** The evidence-gated pipeline and forecast ledger are implemented, but deployment connectivity, verified historical data, calibration, fresh odds and risk controls must be proven independently. Betting recommendations remain disabled.
