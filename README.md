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
- A conservative cross-provider reconciliation preview; it does not create canonical fixtures or verify results.
- PostgreSQL-backed append-only storage for valid provider observations marked `unverified`, with deduplication and provenance. The database must be configured and verified at runtime before this path can save records.
- A transparent Poisson baseline that uses only verified, settled historical results strictly before the prediction cutoff and abstains when minimum history is missing.
- A separate odds/value assessment that withholds betting recommendations for uncalibrated forecasts, stale/missing odds or mismatched fixtures.
- Seeded verbatim list of the original 80 tracked-team names at `src/data/initial-tracked-teams.json`. Provider IDs and aliases are intentionally unresolved rather than guessed.

### Evidence-gated prediction API (new)

The prediction path reads directly from PostgreSQL; it does not accept user-supplied averages or odds as model features.

- `GET /api/predictions/status` — database readiness plus provider-observation, corroborated-future-fixture, verified-result, team-mapping and forecast-ledger counts. A database-ready response does not imply the evidence is sufficient.
- `GET /api/predictions/ledger?limit=20` — latest persisted exploratory forecasts, diagnostics and evidence hashes (limit 1–100).
- `GET /api/predictions/team-mappings` — list explicitly reviewed canonical team mappings.
- `POST /api/predictions/team-mappings` — save a reviewed mapping. In production, send the configured `x-provider-diagnostics-token` header. JSON body: `{"teamId":"your-reviewed-stable-id","canonicalName":"exact canonical fixture team name","reviewedBy":"reviewer identifier"}`.
- `POST /api/predictions/run` — body `{"canonicalKey":"exact canonical key from /api/fixtures"}`.
- `GET /api/predictions?canonicalKey=...` — same prediction operation via query string.

The prediction route requires a corroborated, future scheduled fixture; exact reviewed mappings for both teams; and enough verified settled results from the **same competition** strictly before kickoff. It also requires the fixture evidence to be fresh: by default, the canonical evidence row must have been updated within the last 180 minutes at forecast time. Configure `FIXTURE_EVIDENCE_MAX_AGE_MINUTES` to a positive value up to 10,080 minutes (7 days) for your deployment; invalid policy values, stale evidence, or timestamps too far in the future cause the forecast to be withheld. It records a SHA-256 evidence hash and stores eligible forecasts in `prediction_ledger`. Missing evidence yields a withheld response rather than percentages.

The Poisson baseline is explicitly marked uncalibrated. Forecast availability is not a betting recommendation; betting recommendations remain disabled until a genuinely out-of-sample calibration and evaluation pipeline passes separate gates. Team mappings are manual reviews, not automatic provider-ID discovery.

## Not yet production-ready

- No database connection has yet been verified in the target environment. `DATABASE_URL` being present is not enough; `/api/storage/status` must report `state: "ready"`, and an ingestion/restart test must confirm durable rows.
- No verified canonical fixtures or settled results are currently stored. Provider observations and reconciliation groups are not verified evidence.
- The original 80 names still need reviewed provider-ID and competition mappings. A name list is not verified match history.
- Historical result backfill, immutable prediction ledger, chronological backtesting, calibration, odds ingestion, TheRundown integration, authentication and production deployment are not complete.
- Betting recommendations remain disabled. The Poisson baseline is exploratory and not a calibrated betting model.

## Favourite-team identity discovery

After the updated server is deployed with PostgreSQL configured and both API-Football and Sportmonks credentials available, set these variables in your local, git-ignored `.env` file (do not commit it):

```dotenv
FOOTBALL_APP_URL=https://your-deployed-app.example
PROVIDER_DIAGNOSTICS_TOKEN=your-configured-token
```

Then run the paced discovery runner from a trusted machine:

```bash
npm run discover:favourite-teams
```

The runner processes up to five teams per request, waits between requests to respect the team-search rate limit, and stores provider candidates plus conservative cross-provider identity decisions. It does not print the token. It stops at the configured maximum of 32 batches; set `TEAM_SEARCH_MAX_BATCHES` to a lower value if you want a shorter run. Alternatively, the deployed dashboard provides a **Discover favourite teams** control with visible progress and the same paced batch endpoint.

Review progress at `/api/teams/watchlist` and saved candidates at `/api/teams/provider-search/results`. A mapping is only confirmed when both provider catalogues return one exact/curated-name candidate and their country metadata agrees. Ambiguous and unresolved teams remain unmapped. Identity mapping does not create verified historical results or enable betting recommendations.

Never commit the token or put it into a public URL. Use the same `PROVIDER_DIAGNOSTICS_TOKEN` configured on the deployed server.

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

The deterministic ticket settlement domain core is documented in `docs/TICKET_SETTLEMENT.md`; it is unit-tested but is not yet connected to persistent ticket records or live auto-settlement. See `docs/POSTGRES_SETUP.md` for configuring and verifying durable storage, and `docs/LIVE_VERIFICATION_RUNBOOK.md` for the exact deployment, discovery, and restart-durability checks. See `docs/NEW_REPO_SETUP.md` for the separate GitHub repository setup steps. See `docs/ARCHITECTURE.md`, `docs/BUILD_PLAN.md`, `docs/DATA_INTEGRITY.md`, `docs/PROVIDER_CONTRACTS.md`, `docs/PERSISTENCE.md`, `docs/SOURCE_AUDIT.md`, and `docs/STATUS.md`.
