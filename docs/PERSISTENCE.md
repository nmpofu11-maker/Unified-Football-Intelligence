# Persistence plan and status

The initial PostgreSQL schema is in `src/db/schema.sql`. It has not been applied, and the app does not yet connect to PostgreSQL. `DATABASE_URL` being present is reported only as configured, never as proof that persistence works.

The intended system of record is PostgreSQL, with:
- canonical teams, reviewed aliases, provider IDs, competitions and canonical fixtures;
- append-only provider observations with provenance, timestamps, evidence state and payload hash;
- separate reconciled result evidence, odds snapshots, immutable prediction snapshots and model versions;
- tracked-team/watchlist membership for the original 80 plus user-added teams.

Before production, implement a migration runner and repository interface, then verify:
1. schema creation against a clean PostgreSQL instance;
2. idempotent re-ingestion and duplicate constraints;
3. conflicting provider observations remain queryable;
4. prediction snapshots cannot be overwritten through application routes;
5. backup/restore works;
6. records survive service restart and redeploy;
7. failure to persist is surfaced and never treated as a successful ingestion.

Local JSON files are suitable for test fixtures only, not the production source of truth on an ephemeral serverless filesystem.
