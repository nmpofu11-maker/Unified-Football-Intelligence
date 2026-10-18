# Delivery status — 2026-10-18

## Current main

Latest verified main commit at the time of this update: `87b720610885c640644fa4fe3b42b997ccce9bb9`.

Post-merge GitHub Actions CI passed on that exact SHA: [workflow run 39116082475](https://github.com/nmpofu11-maker/Unified-Football-Intelligence/actions/runs/39116082475). CI includes typecheck, unit tests, a PostgreSQL 16 integration service, persistence and ticket-settlement integration tests, and the production build.

## Implemented

- SportAPI.ai, Sportmonks and API-Football fixture adapters with sanitized provider diagnostics.
- Append-only PostgreSQL raw-observation storage, deduplication, persistence diagnostics, canonical evidence reconciliation and verified settled-result storage.
- Saved discovery progress for the original 80 favourite teams; provider search candidates remain separate from verified identities.
- Cross-provider identity resolution that requires exact/curated names and matching country context for API-Football/Sportmonks mappings. Supplied provider IDs do not fall back to display-name matching when unresolved.
- Canonical fixture rows now carry an `identity_reviewed` gate. Existing rows are migrated with the flag set to false, and are excluded from public canonical fixture summaries, forecast inputs, historical evaluation, readiness counts and ticket settlement until rebuilt through the identity-safe path.
- Full replay does not delete the existing canonical snapshot while supplied provider IDs remain unresolved; it reports `snapshotReplacementSkipped`. Raw observations remain immutable.
- Evidence-gated Poisson forecasts, freshness checks, prediction ledger and evidence hashes. Insufficient history or unresolved identity results in withheld/null probabilities rather than invented percentages.
- Persistent pending tickets and audited settlement events. A PostgreSQL integration test verifies that a ticket becomes lost when one verified leg loses, while a leg without verified evidence remains pending.
- Chronological out-of-sample evaluation that excludes unreviewed fixtures and withholds metrics until the configured minimum sample is met.
- Betting recommendations remain disabled; no bookmaker odds are used as a substitute for independent team-performance evidence.

## CI coverage and limits

The PostgreSQL integration tests use a clean, ephemeral PostgreSQL database in GitHub Actions. They verify application database behaviour, not the live production database or provider credentials.

## Not yet verified in a live environment

- No deployment URL or production database connection has been independently verified in this workflow.
- Provider credentials, rate limits, competition coverage and actual live fixture ingestion have not been confirmed.
- The original 80 favourite-team identities, provider mappings and competition coverage are not yet proven complete.
- A complete historical-results backfill, genuine out-of-sample model calibration, current odds integration, BetMatrix ticket import, and end-to-end production ticket settlement remain unverified.
- Existing canonical rows that predate the identity gate will remain hidden from forecasts and settlement until safely regenerated. This can reduce available fixture/history counts; do not weaken the gate to increase counts.

## Go/no-go

**Not yet suitable for betting recommendations or a production-ready claim.** Code and CI are stronger, but live storage, provider ingestion, identity coverage, verified history, out-of-sample calibration and production ticket settlement must be proven independently. Betting recommendations remain disabled.
