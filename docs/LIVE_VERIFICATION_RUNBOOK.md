# Live deployment and favourite-team discovery runbook

This runbook starts after the code in `feature/canonical-evidence-pipeline` has been deployed. It does not assume provider access or a working database until each check passes.

## A. Required server-side configuration

Configure these values in the hosting platform's server-side secrets/runtime environment, never in browser-visible configuration:

- `DATABASE_URL`: managed PostgreSQL connection URL with the database provider's required TLS settings.
- `API_FOOTBALL_KEY`: API-Football key.
- `SPORTMONKS_API_KEY`: Sportmonks API token.
- `PROVIDER_DIAGNOSTICS_TOKEN`: a strong private token used by protected diagnostics and discovery endpoints.

Redeploy/restart after changing environment variables. Keep secrets out of Git, screenshots, URLs, issue comments, and chat.

## B. Verify the deployment before using discovery

Replace `APP_HOST` with the actual deployed host.

1. Open `https://APP_HOST/api/storage/status`.
   - Continue only if `state` is `ready`.
   - If it is `not_configured`, configure `DATABASE_URL` on the server and redeploy.
   - If it is `error`, fix the database connection before proceeding.
2. Open `https://APP_HOST/api/history/status` and record the initial counts for tracked teams, saved search observations, and confirmed/ambiguous/unresolved mappings.
3. Open the app dashboard. Confirm the **Discover favourite teams** control is present. If it is missing, the latest feature branch is not deployed or the deployment did not build the expected revision.
4. Use the existing protected-token field to enter the configured diagnostics token. Do not send the token to anyone or include it in a screenshot.

## C. Run automatic discovery

1. Click **Discover favourite teams** once and keep the dashboard open while it runs.
2. Let it respect the built-in pacing and retry behavior; do not repeatedly click the control or run multiple discovery sessions at once.
3. The process is bounded to 32 batches per dashboard run and searches up to five teams per batch. It may take several minutes due to provider throttling.
4. Inspect the progress output. A rate-limit response should trigger a wait/retry, not rapid repeated requests.
5. Refresh `/api/history/status` and `/api/teams/watchlist` after completion. Confirm search progress and mapping counts changed as expected.
6. Open `/api/teams/provider-search/results` to inspect persisted candidate evidence. Candidate results should survive a server restart/redeploy when the same PostgreSQL database is used.

## D. Interpret mapping outcomes safely

- **Confirmed** means each provider returned exactly one exact-name or curated-alias candidate and their country metadata agrees.
- **Ambiguous** means candidates conflict or more than one exact candidate exists. Do not force a match just to increase the count.
- **Unresolved** means available provider evidence is insufficient. Check provider spelling/country coverage and investigate those candidates before adding a curated alias.
- The original 80 favourite-team names must remain intact. They are a user watchlist, not proof of provider identity or historical coverage.
- Do not infer a team's country from a similar name. Preserve league, country, youth, reserve, women's and suffix distinctions. A team name alone is not enough to safely map a provider ID.

## E. Verify durability

1. Record the observation count from `/api/storage/status`.
2. Run discovery and confirm the saved candidate count rises when new candidates are returned.
3. Restart or redeploy the service without changing `DATABASE_URL`.
4. Recheck storage and search-result endpoints. Existing records and mappings must remain.
5. If records disappear after restart/redeploy, stop discovery and fix persistent database configuration before spending more provider quota.

## F. What discovery does not prove

Team catalogue identity mapping is not match-history ingestion. It does not verify fixture results, create verified historical records, calibrate forecasts, or authorize betting recommendations. Those gates remain closed until historical results are sourced, settled, independently verified, season/competition mappings are correct, and chronological backtesting/calibration passes.

## Troubleshooting checklist

- `state: not_configured`: `DATABASE_URL` missing from the running service environment.
- `state: error`: database networking, credentials, TLS, or schema/startup issue; use sanitized server logs and never share secrets.
- Missing discovery control: wrong deployed revision or stale browser page.
- Unauthorized response: the token must match the deployed `PROVIDER_DIAGNOSTICS_TOKEN`.
- No provider candidates: verify provider credentials, plan/permissions, query coverage and provider response diagnostics; an HTTP 200 with an empty list is not a team match.
- Everything unresolved: do not weaken the matching rules. Review the actual candidate names and country metadata first.
