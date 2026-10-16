# Build plan and acceptance gates

## Phase 0 — source audit and product contract — partial

- [x] Confirm three source repositories and provider priority.
- [x] Inspect source manifests, provider adapter entry points, persistence approach, and the original 80-team list.
- [x] Record initial source audit findings and the current PR #32 state.
- [ ] Complete line-by-line review of adapter pagination, authentication, parsing, every prediction rule, every write route and all source tests.
- [ ] Record exact commit SHAs for every source file included in the final audit snapshot.

**Gate:** complete feature-by-feature reuse/rewrite/exclude matrix and approved architecture decisions.

## Phase 1 — canonical domain and quality foundation — partial

- [x] Canonical team, competition, fixture, result, odds and forecast types.
- [x] Validation for timestamps, probability sums, result scores and odds.
- [x] Provider observations remain separate from canonical fixtures.
- [x] Exact/provider-ID team and competition resolution; unresolved and ambiguous identities are blocked.
- [x] Conflict-aware settled-result reconciliation.
- [x] Seed the 80 original team names verbatim with unresolved provider mappings.
- [x] Persist strict cross-provider team identity decisions separately from raw search observations.
- [ ] Add explicit reviewed alias-management workflow and complete duplicate, postponement, abandonment, provider-ID reuse and correction migration tests against PostgreSQL.
- [ ] Complete duplicate, postponement, abandonment, provider-ID reuse and correction migration tests against PostgreSQL.

**Gate:** no silent identity merges; every stored fact has provenance; unresolved records cannot enter model history.

## Phase 2 — broad fixture monitoring — adapter foundation implemented, live validation pending

- [x] SportAPI.ai and Sportmonks on-demand adapters with schema validation and explicit diagnostics.
- [x] Distinguish valid empty response, partial response, rate limit, auth failure and network error.
- [x] Expose `/api/providers/fixtures?date=YYYY-MM-DD` for on-demand provider diagnostics.
- [ ] Verify live calls and coverage with authorized credentials; source code is CI-verified but no live provider call has yet been verified.
- [x] Add persisted raw evidence, persisted team-search results, conservative identity reconciliation and a rate-limited next-batch endpoint.
- [ ] Add a scheduled production worker, durable job state, caching/backoff telemetry and live integration tests.
- [ ] Implement TheRundown as secondary adapter; keep API-Football optional.

**Gate:** live provider checks pass, no secrets leak, and each candidate is reconciled or explicitly unresolved.

## Phase 3 — deep tracked-team history — list seeded, data not loaded

- [x] Import the original 80 names verbatim from `LOCKED_80_TEAMS` with source blob reference.
- [x] Search provider team catalogues directly and persist candidates for the original 80 names.
- [x] Automatically confirm only unique exact/curated-name matches across API-Football and Sportmonks when country metadata agrees.
- [ ] Review unresolved/ambiguous provider IDs and complete competition/season mappings for every team.
- [ ] Backfill historical results with source IDs and retrieval/effective timestamps.
- [ ] Build per-team sample counts, date ranges, competition breakdown and missingness reports.

**Gate:** only distinct verified settled results count; no guessed aliases or default zero history.

## Phase 4 — statistical analysis — baseline implemented, exploratory only

- [x] Transparent Poisson score-distribution baseline.
- [x] Use only verified results with settled and kickoff timestamps strictly before the prediction cutoff.
- [x] Abstain when minimum history or league baseline is missing.
- [x] Validate output probabilities and record model version/cutoff.
- [ ] Persist immutable forecast snapshots and exact feature snapshots.
- [ ] Add league-specific baselines and out-of-sample comparison with naive baselines.

**Gate:** deterministic repeatability, no temporal leakage and correct abstention.

## Phase 5 — validation and calibration — not implemented

- [ ] Chronological train/validation/holdout splits.
- [ ] Brier score, log loss, calibration curves, confidence intervals and sample counts.
- [ ] Model approval and rollback workflow.

**Gate:** no model may be marked approved for betting without independent holdout evidence and review.

## Phase 6 — odds, value and risk — gate foundation only

- [x] Separate odds quotes from forecasts; validate quote freshness and fixture identity.
- [x] Withhold value assessments by default unless model approval is explicitly passed.
- [ ] Implement authorized odds ingestion, market settlement semantics, de-vigging, limits and risk policies.

**Gate:** no betting recommendation without valid fresh odds, calibrated approved model, uncertainty checks and risk controls.

## Phase 7 — unified UI and explanations — initial status dashboard only

- [x] Honest dashboard with empty states and provider status.
- [ ] Fixture monitor, team profiles, evidence detail, prediction history and market analysis UI.
- [ ] Optional local Ollama explanations grounded in approved structured evidence.

**Gate:** every displayed number traces to evidence or a documented calculation; core app works without Gemini.

## Phase 8 — production hardening — not implemented

- [x] Draft PostgreSQL schema and CI workflow.
- [ ] PostgreSQL repository, migrations, durable hosting, backups and restore tests.
- [ ] Authentication/roles, rate limiting, secret management, dependency/security checks, observability and rollback.
- [ ] Verify persistence across restart and redeploy.

**Gate:** production persistence and deployment are verified against the intended host.

Do not skip gates to make the app appear complete. The current build is a foundation, not a production betting service.
