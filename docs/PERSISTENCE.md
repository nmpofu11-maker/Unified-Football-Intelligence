# Persistence plan and current implementation

The application now has a PostgreSQL observation-store path in `src/storage/postgresObservations.ts`. It is initialized lazily when `DATABASE_URL` is present. The presence of the variable is not proof that the database is reachable: the live `/api/storage/status` endpoint must return `state: "ready"`.

## Current write path

- On-demand fixture checks call the configured provider adapters and normalize accepted rows as candidates.
- Valid candidates marked `evidenceState: "unverified"` are appended to `provider_fixture_observations` in PostgreSQL.
- Each row retains provider ID, observed timestamp, kickoff, names, status, optional score, provenance and the normalized observation payload.
- The unique constraint on provider + provider fixture ID + observation timestamp prevents duplicate inserts for the same observation.
- A write failure is surfaced in the fixture-check response and is not cached as a successful response.
- `GET /api/storage/status` performs a live query and reports a sanitized connection/schema error if it cannot access the store.

Follow `docs/POSTGRES_SETUP.md` to provision a database, configure the local or deployed environment, and verify insertion and restart persistence.

## Intended system of record

PostgreSQL is intended to hold:
- canonical teams, reviewed aliases, provider IDs, competitions and canonical fixtures;
- append-only provider observations with provenance, timestamps, evidence state and payload;
- separate reconciled result evidence, odds snapshots, immutable prediction snapshots and model versions;
- tracked-team/watchlist membership for the original 80 plus user-added teams.

Only the provider-observation table is connected by the current write path. The other entities and workflows are not considered implemented merely because they are part of the intended design.

## Required remaining gates

1. Verify `/api/storage/status` against the real target database.
2. Ingest provider candidates and verify the count increases.
3. Restart/redeploy against the same database and verify records survive.
4. Test idempotent re-ingestion and conflicting provider observations.
5. Complete reviewed canonical team and competition mappings; do not infer provider IDs from names.
6. Build a reviewed reconciliation workflow for settled results before promoting any observation to verified evidence.
7. Add historical backfill, immutable prediction snapshots, chronological backtesting and model calibration.
8. Verify backup/restore and production access controls.

Local JSON files are suitable for test fixtures only, not the production source of truth on an ephemeral serverless filesystem. Until the evidence and calibration gates pass, verified-history counts and betting recommendations must remain disabled.
