# Unified Football Intelligence

A greenfield football intelligence platform designed to consolidate audited capabilities from:
- https://github.com/nmpofu11-maker/SoccerPredict-pro
- https://github.com/nmpofu11-maker/BetMatrix-AI---Hollywoodbets-Intelligent-Betting-Engine
- https://github.com/nmpofu11-maker/Football-Analytical-Engine

The source repositories are reference projects; this application does not modify or depend on them at runtime.

## Product direction

Monitor broadly, build deeper verified histories for the original 80 priority teams plus teams explicitly added by the user, and make selective betting recommendations only after evidence, calibration, odds freshness and risk gates pass.

## Implemented in this foundation

- Canonical domain types and validation for fixtures, settled results, forecasts and odds.
- Conservative team/competition identity resolution: provider IDs must agree with names; unknown or ambiguous names are blocked rather than fuzzy-matched.
- SportAPI.ai, Sportmonks and API-Football on-demand fixture adapters with separate diagnostics for empty success, partial data, rate limits, authentication errors, malformed payloads and network errors.
- An API endpoint `/api/providers/fixtures?date=YYYY-MM-DD` that returns raw-normalized provider observations as **unverified candidates**.
- PostgreSQL-backed canonical evidence replay that promotes only cross-provider-corroborated fixtures; settled scores require independent providers to agree on fixture identity, finished status and score.
- Persistent canonical team registry and provider-specific identity mappings, with explicit operator review and fail-closed handling for unmapped provider IDs.
- Canonical evidence promotion is blocked when raw observation persistence fails; raw observations remain unverified and immutable.
- PostgreSQL-backed append-only storage for valid provider observations marked `unverified`, with deduplication and provenance. The database must be configured and verified at runtime before this path can save records.
- A transparent Poisson baseline that uses only verified, settled historical results strictly before the prediction cutoff and abstains when minimum history is missing.
- A separate odds/value assessment that withholds betting recommendations for uncalibrated forecasts, stale/missing odds or mismatched fixtures.
- Seeded verbatim list of the original 80 tracked-team names at `src/data/initial-tracked-teams.json`. Provider IDs and aliases are intentionally unresolved rather than guessed.

## Not yet production-ready

- No database connection has yet been verified in the target environment. `DATABASE_URL` being present is not enough; `/api/storage/status` must report `state: "ready"`, and an ingestion/restart test must confirm durable rows.
- No verified canonical fixtures or settled results are currently stored. Provider observations and reconciliation groups are not verified evidence.
- The original 80 names and any added teams still need reviewed provider-ID and competition mappings. A name list is not verified match history.
- Live runtime verification of PostgreSQL persistence, reviewed mappings and replay is still required; code/CI success is not proof that a deployed database is configured.
- Historical result backfill, immutable prediction ledger, chronological backtesting, calibration, odds ingestion, TheRundown integration, authentication and production deployment are not complete.
- Betting recommendations remain disabled. The Poisson baseline is exploratory and not a calibrated betting model.

## Development

Requires Node.js 22+.

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

Copy `.env.example` to `.env`. Set `DATABASE_URL` to a PostgreSQL connection URL only when you have a database provisioned. Never commit `.env` or paste API/database secrets into chat. The core server can start without Gemini; no Gemini key is required.

See `docs/POSTGRES_SETUP.md` for configuring and verifying durable storage. See `docs/NEW_REPO_SETUP.md` for the separate GitHub repository setup steps. See `docs/ARCHITECTURE.md`, `docs/BUILD_PLAN.md`, `docs/DATA_INTEGRITY.md`, `docs/PROVIDER_CONTRACTS.md`, `docs/PERSISTENCE.md`, `docs/SOURCE_AUDIT.md`, and `docs/STATUS.md`.
