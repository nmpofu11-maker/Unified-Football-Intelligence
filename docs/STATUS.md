# Delivery status — 2026-10-18

## Current code revision

Runtime code revision verified before this documentation refresh: `6e4c308706e9a90a68a75ea7c2bd95e33dac0c8f`.

Post-merge GitHub Actions CI passed on that exact SHA: [workflow run 39120233916](https://github.com/nmpofu11-maker/Unified-Football-Intelligence/actions/runs/39120233916). CI includes typecheck, unit tests, PostgreSQL 16 integration tests, and the production build. This verifies the code and tests, not the live deployment or external provider credentials.

## Implemented

- SportAPI.ai, Sportmonks and API-Football fixture adapters with sanitized provider diagnostics.
- Append-only PostgreSQL raw-observation storage, deduplication, canonical evidence reconciliation and verified settled-result storage.
- Saved discovery progress for the original 80 favourite teams; provider search candidates remain separate from verified identities.
- Canonical reconciliation that requires supplied provider IDs to resolve to distinct tracked-team identities. API-Football/Sportmonks use the exact/country cross-provider resolver; SportAPI catalogue candidates require explicit operator approval through a protected dashboard workflow, with a persisted review audit event. An unresolved ID never falls back to display-name matching.
- Canonical fixture rows carry an `identity_reviewed` gate. Existing rows migrate with the flag false and are excluded from public canonical summaries, forecast inputs, historical evaluation, readiness counts and ticket settlement until safely rebuilt.
- Full replay preserves the current snapshot when canonicalization-eligible provider IDs are unresolved, and now also skips snapshot deletion when the incoming batch has no eligible canonical candidates (for example, a batch containing only unreviewed SportAPI IDs). Unreviewed SportAPI IDs do not permanently block safe cleanup when reviewed primary-provider candidates are present; operator-reviewed SportAPI IDs can participate in canonicalization.
- Forecast ledger entries remain immutable but expose `current_identity_status`: `identity_gate_passed`, `legacy_unreviewed_identity`, or `canonical_fixture_missing`. Legacy entries remain visible for audit but are not represented as currently identity-eligible.
- Evidence-gated Poisson forecasts, freshness checks and evidence hashes. Insufficient history or unresolved identity results in withheld/null probabilities rather than invented percentages.
- Persistent pending tickets and audited settlement events. PostgreSQL integration tests verify that a ticket becomes lost when one verified leg loses, while a leg without verified evidence remains pending.
- Dashboard workflow for controlled manual BetMatrix pending-ticket JSON import, saved-ticket refresh and explicit reconciliation. Duplicate imports are idempotent only when ticket content matches; a reused source ID with changed content is rejected. This is not a direct live BetMatrix/Hollywoodbets connection.
- Chronological out-of-sample evaluation excludes unreviewed fixtures and withholds metrics until the configured minimum sample is met.
- Betting recommendations remain disabled; bookmaker odds are not used as a substitute for independent team-performance evidence.

## CI coverage and limits

The PostgreSQL integration tests use a clean, ephemeral PostgreSQL database in GitHub Actions. They verify application persistence, replay, identity-gate and ticket/ledger behaviour, not the live production database or provider credentials.

## Not yet verified in a live environment

- No deployment URL or production database connection has been independently verified in this workflow.
- Provider credentials, rate limits, competition coverage and actual live fixture ingestion have not been confirmed.
- The original 80 favourite-team identities, provider mappings and competition coverage are not yet proven complete.
- A complete historical-results backfill, genuine out-of-sample model calibration, current odds integration, actual BetMatrix source export availability, and end-to-end production ticket settlement remain unverified. The manual import workflow is CI-tested, but live source-to-canonical resolution and production settlement have not been exercised.
- Existing canonical rows that predate the identity gate remain stored for audit but are hidden from forecasts and settlement until safely regenerated. This can reduce available fixture/history counts; do not weaken the gate to increase counts.

## Go/no-go

**Not yet suitable for betting recommendations or a production-ready claim.** Code and CI coverage are stronger, but live storage, provider ingestion, identity coverage, verified history, out-of-sample calibration and production ticket settlement must be proven independently. Betting recommendations remain disabled.
