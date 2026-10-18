# Live deployment and evidence-pipeline verification runbook

This runbook applies to the current `main` code. It distinguishes code/CI verification from checks that must run against the real deployment. Do not assume the application is production-ready until each relevant live stage is confirmed.

## A. Configure server-side secrets

Set only the provider credentials you are authorized to use, plus a persistent PostgreSQL URL and a strong diagnostics token:

- `DATABASE_URL`: persistent PostgreSQL connection URL with required TLS settings.
- `SPORTAPI_AI_KEY` (or `SPORTAPI_API_KEY`): SportAPI.ai adapter.
- `SPORTMONKS_API_KEY` (or `SPORTMONKS_API_TOKEN`): Sportmonks adapter.
- `API_FOOTBALL_KEY`: optional API-Football adapter.
- `PROVIDER_DIAGNOSTICS_TOKEN`: protects administrative discovery, replay, and ticket actions where required.

The current server reports TheRundown as not connected; setting a TheRundown key alone does not mean that adapter is implemented. Do not place any secret in frontend/public variables, URLs, screenshots, source code, or chat. Restart/redeploy after changing server-side variables.

## B. Verify the exact deployment and storage

Replace `APP_HOST` with the actual deployed host.

1. Open `https://APP_HOST/health`. HTTP 200 means process liveness only; read the readiness fields in the JSON.
2. Open `https://APP_HOST/api/storage/status`. Continue only if `state` is `ready`; fix missing configuration or connection errors before provider calls.
3. Open `https://APP_HOST/api/storage/observations/summary` and record the baseline counts.
4. Open `https://APP_HOST/api/data-pipeline/status`. Record each stage's state and blocker/error codes.
5. Open `https://APP_HOST/api/predictions/status` and `https://APP_HOST/api/history/status`. A missing or unavailable count is not evidence of zero records.

No deployment URL is confirmed by source inspection alone. Use the host from your actual deployment provider.

## C. Verify provider calls and durable raw observations

1. In the dashboard, run **Check providers** once for a date where matches should exist.
2. Inspect each provider's diagnostics separately: credential state, last success time, accepted/rejected records, rate limits and sanitized error codes.
3. Inspect the returned persistence result. New valid candidates should produce `state: "saved"` and `inserted > 0`; duplicates can be skipped. A valid empty response is not the same as an error, but it is not fixture coverage.
4. Recheck `/api/storage/observations/summary` and confirm counts/timestamps change when new observations are inserted.
5. Restart/redeploy using the same database, then confirm the records persist.

Do not repeatedly trigger provider requests to overcome a rate limit. Respect the built-in pacing and provider quotas.

## D. Verify favourite-team discovery without guessing identities

1. Open `/api/teams/watchlist` and confirm the original 80 favourite-team names remain unchanged.
2. Run **Discover favourite teams** from the dashboard or use the protected next-batch workflow, one run at a time.
3. Inspect `/api/teams/provider-search/results` for saved candidate evidence and league/country/squad context.
4. SportAPI catalogue candidates are discovery evidence only and do not auto-confirm a provider identity. For canonical fixture reconciliation, supplied API-Football/Sportmonks IDs must resolve to distinct confirmed tracked-team identities; the resolver requires one exact/curated-name candidate per provider with matching country context. An unresolved supplied ID never falls back to its display name. Preserve league, season and senior/reserve/youth/women distinctions.
5. Keep ambiguous or unresolved teams unmapped until source IDs and competition context support a review decision. Do not force a match merely to raise mapping counts.

SportAPI.ai catalogue candidates can improve discovery, but optional catalogue results do not independently confirm a canonical identity or prove historical match coverage.

## E. Verify canonical fixtures and historical results

1. Trigger the supported history replay/reconciliation action only after raw observation persistence is confirmed.
2. Inspect `/api/data-pipeline/status`, `/api/fixtures`, and `/api/history/status`.
3. Confirm that canonical fixture counts are backed by corroborated provider evidence and unresolved provider IDs are excluded.
4. Confirm that a verified settled result requires independent providers to agree on the fixture identity, finished status and exact score. Conflicts must stay excluded.
5. Check replay diagnostics for conflict reasons and stale live-status observations. Verify that the resulting counts persist after restart.

A large raw-observation count is not the same as a large verified-history count. The 80 favourite teams are a watchlist, not evidence that the teams are mapped or have sufficient historical samples.

## F. Verify forecasts and ticket settlement

1. Inspect `/api/predictions/status` and `/api/data-pipeline/status` before running forecasts.
2. A forecast should only be emitted when a fresh corroborated future fixture, reviewed exact team mappings, and sufficient same-competition verified results strictly before kickoff are available.
3. If evidence is insufficient, probabilities must be null and diagnostics must explain the blocker. Do not introduce fixed priors or odds-driven fallbacks to fill gaps.
4. Check `/api/predictions/ledger?limit=20` for stored evidence hashes and timestamps. Calibration and betting recommendations remain unavailable until genuine chronological out-of-sample evaluation supports them.
5. Submit a test ticket only in a safe test environment. Verify that a ticket is marked lost as soon as any leg has a verified losing result, while missing, conflicted or unverified results cannot settle a leg. Confirm settlement events persist across restart.

## G. What CI does and does not prove

CI validates TypeScript, unit tests, build, and the database integration test against an ephemeral PostgreSQL instance. It does not prove that production secrets are configured, that live providers return data for the user's leagues, that production storage survives redeploy, that all favourite teams are mapped, that verified historical samples are sufficient, or that the model is calibrated.

**Go/no-go:** until live storage, provider ingestion, reconciliation, verified results, and out-of-sample evaluation are confirmed, treat predictions as exploratory and keep betting recommendations disabled.

## Troubleshooting

- `not_configured`: required server environment variable missing.
- `database_connection_failed` / `database_operation_failed`: inspect server-side network, permissions, TLS and schema diagnostics without exposing credentials.
- `rate_limited`: wait for the provider's reset window; do not loop requests.
- Empty provider results: inspect the provider-specific state and rejection diagnostics; an empty list alone does not prove there are no fixtures.
- Unresolved team mapping: review exact provider IDs, country, league and squad type; do not weaken matching.
- No forecast: use the pipeline blocker codes to determine which evidence stage is missing. Do not invent sample sizes or confidence.
