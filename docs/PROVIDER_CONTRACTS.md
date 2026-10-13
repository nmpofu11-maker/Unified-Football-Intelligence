# Provider contract notes

These notes are based on inspected source adapters. They are not a guarantee of current vendor terms or live availability; confirm current documentation and account access before production use.

## SportAPI.ai — primary

- Current public SportAPI documentation shows `GET https://sportapi.ai/api/fixtures?date=YYYY-MM-DD`. The adapter uses this documented query endpoint.
- Authentication in the source adapter sends `X-Api-Key` and `Authorization: Bearer …` using `SPORTAPI_AI_KEY` (legacy alias `SPORTAPI_API_KEY`).
- The public example returns `{ success, fixtures: [...] }`; each row can contain `id`, `date`, `datetime`, `status`, string `league`, string `home_team`, and string `away_team`. The adapter also accepts supported array/data envelope variants.
- The source adapter treats HTTP 429 as rate limiting and pauses requests. The new adapter records 429 separately from a valid empty response.
- The mapper requires a provider fixture ID, team names, competition name, and explicit UTC/offset kickoff timestamp. Team and competition provider IDs are optional because the public example does not provide them; absent IDs remain absent and canonicalization must use exact reviewed names or remain blocked. A date-only field plus timezone-naive time is rejected rather than guessed.
- Score values are exposed only for a finished-status record with valid non-negative integer scores; they remain unverified until result reconciliation.

## Sportmonks — primary

- Existing source adapter documents `GET https://api.sportmonks.com/v3/football/fixtures/date/{YYYY-MM-DD}`.
- Authentication uses the documented `api_token` query parameter sourced from `SPORTMONKS_API_KEY` (legacy alias `SPORTMONKS_API_TOKEN`); the adapter also sends the `Authorization` header for compatibility. The token is never included in diagnostics.
- Includes: `participants;scores;league;state;season`, timezone `UTC`, page size 50 (the documented maximum), and pagination capped at five pages with partial responses tracked.
- Sportmonks may return HTTP 200 with an empty `data` array; inspect sanitized response-message diagnostics and subscription coverage before treating that as proof that no fixtures exist.
- The new mapper requires fixture ID, home/away participants with IDs and names, competition ID/name and a parseable kickoff. Timezone-naive `starting_at` is treated as UTC only because the request explicitly asks for `timezone=UTC`.
- Scores are read only for finished-status fixtures and valid score rows; a score is not proof of finality by itself.

## API-Football — optional live observation source

- The adapter calls `GET https://v3.football.api-sports.io/fixtures?date=YYYY-MM-DD` with the `x-apisports-key` header from `API_FOOTBALL_KEY`; `API_FOOTBALL_BASE_URL` may override the base URL for a documented compatible endpoint.
- It validates the provider `response` array and maps fixture, league, teams, kickoff, status and scores into unverified candidates. Scores are included only for finished-status fixtures with two non-negative integer goals.
- Provider-reported errors, missing response arrays, HTTP authentication failures, rate limits, empty results and rejected records are reported separately. Provider error bodies and credentials are not copied into diagnostics.
- API-Football is an optional source for fixture monitoring and does not make the forecast model calibrated.

## TheRundown

- TheRundown is a planned secondary adapter and is not implemented in this greenfield foundation.
- No adapter should mark an HTTP response verified merely because it returned 200. Validate shape, fixture identity, freshness, status, score semantics and provenance.

## Operational behavior

- Missing key: `unavailable` with `credential_not_configured`.
- HTTP 401/403: `auth_error`; HTTP 429: `rate_limited`; other non-2xx: `http_error`.
- Valid empty response: `success_empty`; non-empty response with rejected rows: `partial`.
- Network/timeout/parse failures are explicit diagnostics, never silently converted to “no fixtures.”
- The `/api/providers/fixtures?date=YYYY-MM-DD` route performs an on-demand request and returns unverified provider observations. It does not persist or advertise them as canonical verified fixtures.

## Protecting provider quota

The on-demand diagnostics route is rate-limited to six requests per minute per IP and caches results for five minutes per UTC date. In production, it is disabled unless `PROVIDER_DIAGNOSTICS_TOKEN` is configured. When configured, callers must send it in `x-provider-diagnostics-token`; the dashboard has a password input for internal checks. Keep the token in server secret configuration and do not hard-code it in frontend code. A real multi-user production deployment should replace this lightweight in-process limit with authenticated access and shared rate limiting.
