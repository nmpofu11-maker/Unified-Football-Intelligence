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
- An API endpoint `/api/providers/fixtures?date=YYYY-MM-DD` that returns raw-normalized provider observations as **unverified candidates**, not as persisted verified fixtures.
- A transparent Poisson baseline that uses only verified, settled historical results strictly before the prediction cutoff and abstains when minimum history is missing.
- A separate odds/value assessment that withholds betting recommendations for uncalibrated forecasts, stale/missing odds or mismatched fixtures.
- Seeded verbatim list of the original 80 tracked-team names at `src/data/initial-tracked-teams.json`. Provider IDs and aliases are intentionally unresolved rather than guessed.
- Draft PostgreSQL schema, provider contract notes, persistence plan, initial dashboard, and CI workflow.

## Not yet production-ready

- PostgreSQL schema is not applied; no database repository/migrations or durable write path is connected.
- Provider requests have not been verified against live credentials from this environment. No verified canonical fixtures or results are currently stored.
- The original 80 names still need reviewed provider-ID/competition mappings. A name list is not verified match history.
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

Copy `.env.example` to `.env`. Never commit `.env` or paste API secrets into chat. The core server can start without Gemini; no Gemini key is required.

See `docs/NEW_REPO_SETUP.md` for the separate GitHub repository setup steps. See `docs/ARCHITECTURE.md`, `docs/BUILD_PLAN.md`, `docs/DATA_INTEGRITY.md`, `docs/PROVIDER_CONTRACTS.md`, `docs/PERSISTENCE.md`, `docs/SOURCE_AUDIT.md`, and `docs/STATUS.md`.
