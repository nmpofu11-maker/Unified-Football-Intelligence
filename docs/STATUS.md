# Delivery status — 2026-10-16

## Implemented and CI-verified on `feature/canonical-evidence-pipeline`

- Canonical domain contracts, validation and conflict-aware reconciliation.
- SportAPI.ai, Sportmonks and API-Football fixture adapters with explicit diagnostics.
- PostgreSQL append-only provider observations and canonical evidence tables.
- The original 80 favourite-team names remain seeded verbatim; they are not silently rewritten.
- Provider-native team catalogue search across API-Football and Sportmonks, returning provider IDs and available country/category metadata.
- Persisted team-search observations and a read-only review endpoint.
- A separate persistent team identity mapping table. A mapping is confirmed only when each of API-Football and Sportmonks returns one exact/curated-name candidate and both country values agree. Multiple exact candidates become ambiguous; missing country or insufficient coverage remains unresolved.
- Watchlist response includes search candidates, discovery progress and canonical mapping state.
- Protected next-batch endpoint processes up to five unsearched/retryable teams, with two team-search requests per minute per client and never-searched teams prioritized before retries.
- A paced local runner, `npm run discover:favourite-teams`, and README setup instructions for processing batches without manually supplying IDs.
- Betting recommendations remain disabled pending verified historical evidence, model calibration, fresh odds and risk gates.

## CI verification

The latest completed checks on this feature line passed:
- `npm run typecheck`
- `npm test`
- `npm run build`

These are GitHub Actions checks on source revisions, not a live deployment or provider/database integration test.

## Still not verified

- No live deployment of the latest feature branch has been performed.
- No live API-Football or Sportmonks team search has been run here; provider credentials and the deployed service environment are not accessible through this code-edit workflow.
- PostgreSQL connectivity and persistence/restart durability must be verified on the actual target deployment.
- Search candidates and strict identity mappings do not constitute historical match results. Backfill, verified settled-result ingestion, team/competition-season completeness, immutable prediction ledger, chronological backtesting and calibration remain outstanding.
- The runner requires the updated server to be deployed, PostgreSQL ready, provider keys configured server-side, and `PROVIDER_DIAGNOSTICS_TOKEN` configured.

## Go/no-go

**Not yet suitable for betting recommendations or a production-ready claim.** The identity-discovery and persistence code is in place and CI-verified, but live provider coverage, database durability, historical evidence and model calibration must be verified before predictions can be treated as calibrated.
