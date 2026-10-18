# Delivery status — 2026-10-17

## Implemented on `main`

- Canonical domain contracts, validation and conflict-aware reconciliation.
- SportAPI.ai, Sportmonks and API-Football fixture adapters with explicit diagnostics.
- PostgreSQL append-only provider observations and canonical evidence tables.
- The original 80 favourite-team names remain seeded verbatim; they are not silently rewritten.
- Prediction identity resolution now supports explicitly reviewed exact-name aliases to bridge verified provider spelling variants; normalized collisions are marked ambiguous and withhold forecasts rather than choosing a team.
- Provider-native team catalogue search, persisted candidates, conservative cross-provider identity review, paced discovery and watchlist diagnostics.
- Evidence-gated prediction pipeline that requires a corroborated future fixture, explicitly reviewed team mappings, and verified settled results from the same competition before kickoff.
- Saved exploratory forecasts include an evidence hash and model diagnostics in a persistent prediction ledger.
- `GET /api/predictions/status` reports database schema readiness and counts for corroborated upcoming fixtures, verified settled results, provider observations, reviewed mappings and saved forecasts.
- `GET /api/predictions/ledger?limit=20` returns a bounded read-only view of recent forecast records.
- `GET /api/status` now reflects the current storage/prediction implementation rather than incorrectly claiming the ledger is not implemented.
- Forecast generation fails closed when canonical fixture evidence is stale (default maximum age 180 minutes; configurable with `FIXTURE_EVIDENCE_MAX_AGE_MINUTES`).
- Persistent ticket records and audited settlement events are available through authenticated APIs; pending tickets are re-evaluated after fresh result ingestion and lose immediately when a verified leg loses.
- A bounded historical results ingestion endpoint accepts past UTC date ranges up to seven days and promotes only cross-provider-agreed finished scores.
- An abstained forecast now returns `null` probabilities instead of misleading `0 / 0 / 0`; validation rejects partial-null probability triplets.
- Chronological evaluation is available at `/api/evaluation/out-of-sample`; Brier score, log loss and accuracy stay null until at least 30 eligible pre-kickoff forecasts can be joined to later verified outcomes. This is descriptive evaluation, not calibration approval.

## CI verification

The readiness and ledger API change was merged as `6e2d464eedfaae5532bce6944666cec7c0065154`. The status-contract correction was merged as `4065a8f8eef7c0880c1d18673c2db8a2a0b231fc`. The stale-fixture freshness gate was merged as `1e621263e169a36638a92a345e55fd953cbb4a7b`; its PR-head CI passed typecheck, tests and build. Null probabilities for abstentions were merged as `a0d8dbc4d03092734efa87452faaf6c4acbcfcbe`; PR-head CI run 530 passed typecheck, tests and build. Separate post-merge CI runs on the squash commits have not been confirmed here.

## Not yet verified in a live environment

- No confirmed deployment URL or live deployment of the latest `main` revision has been established in this workflow.
- Production PostgreSQL connectivity, evidence-table compatibility and persistence across restart/redeploy still require live checks.
- Provider credentials, quota/competition coverage, and actual fixture ingestion have not been tested here.
- The 80 favourite-team identities and competition mappings need review; search candidates are not verified match history.
- A full historical-result backfill, team/competition-season completeness, chronological out-of-sample backtesting, calibration, odds ingestion, automatic BetMatrix ticket import, and live settlement verification remain outstanding.

## Go/no-go

**Not suitable for betting recommendations or a production-ready claim yet.** The evidence-gated pipeline and forecast ledger are implemented, but deployment connectivity, verified historical data, calibration, fresh odds and risk controls must be proven independently. Betting recommendations remain disabled.


## Runtime health semantics

`/health` reports actual provider diagnostics, database state, and corroborated-fixture counts. HTTP 200 indicates process liveness only. Unavailable evidence counts remain `null`; calibrated predictions and betting recommendations remain disabled.
