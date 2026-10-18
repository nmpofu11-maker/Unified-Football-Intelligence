# PostgreSQL setup and end-to-end persistence verification

PostgreSQL is used for append-only raw provider observations, team-search observations, reconciled canonical fixture evidence, verified settled results, reviewed prediction-team mappings, and saved forecast/ticket records. These are separate evidence stages: storing a provider response does **not** make its fixture or score verified.

A successful CI build does not prove that a deployed app has a reachable database or working provider credentials. Complete the checks below against the exact deployment you intend to use.

## 1. Provision a database

Use a managed PostgreSQL service or a PostgreSQL instance you control. Create a dedicated application user with the minimum privileges required to create/update the application's tables. Follow your provider's TLS requirements; do not disable certificate verification to work around a connection problem.

Keep the connection URL private. It contains credentials. Never paste it into chat, commit it, or expose it through a browser-visible environment variable.

## 2. Configure the server

For local development, copy `.env.example` to `.env` and set the values you actually have:

```dotenv
DATABASE_URL=postgresql://APP_USER:REDACTED@DB_HOST:5432/APP_DATABASE?sslmode=require
SPORTAPI_AI_KEY=REDACTED
SPORTMONKS_API_KEY=REDACTED
API_FOOTBALL_KEY=REDACTED
PROVIDER_DIAGNOSTICS_TOKEN=REDACTED
```

The values above are placeholders, not credentials. The current provider adapters accept `SPORTAPI_AI_KEY` (or `SPORTAPI_API_KEY`), `SPORTMONKS_API_KEY` (or `SPORTMONKS_API_TOKEN`), and optionally `API_FOOTBALL_KEY`. Only set keys you are authorized to use. Never commit `.env`.

For deployment, configure these in the hosting platform's **server-side/runtime secrets**, not frontend/public build variables. Restart or redeploy after changing them.

## 3. Check database connectivity

With the server running, open:

- Local: `http://localhost:3003/api/storage/status` (use the configured port)
- Deployed: `https://YOUR-SERVICE-HOST/api/storage/status`

Interpret the response:

- `state: "not_configured"`: the running server did not receive `DATABASE_URL`.
- `state: "error"`: connection, permissions, TLS, or schema initialization failed; inspect sanitized server-side diagnostics.
- `state: "ready"`: a live query and raw-observation schema check succeeded. This alone does not prove ingestion or reconciliation works.

Then inspect:

- `/api/storage/observations/summary` — persisted raw observation counts and timestamps.
- `/api/data-pipeline/status` — provider freshness, raw observations, canonical fixtures, verified results, reviewed mappings, prediction evidence and blockers.
- `/api/predictions/status` — prediction-storage readiness and evidence counts.
- `/api/history/status` — history, watchlist and discovery status.

Unavailable counts should remain unknown/null; do not interpret them as zero.

## 4. Verify raw observation persistence

1. Open the dashboard and run **Check providers** once for a date with provider coverage.
2. Inspect the response's `persistence` details. For newly accepted observations, expect `state: "saved"` and `inserted > 0`. A repeat request can report duplicates skipped.
3. Recheck `/api/storage/status` and `/api/storage/observations/summary`.
4. Restart/redeploy the service without changing `DATABASE_URL`, then confirm that the records remain.

A `connected_empty` result can show that the database write path was reachable when a provider returned no valid records, but it does not prove that new rows were inserted. A provider HTTP 200 or a non-empty in-memory response is not persistence evidence.

## 5. Verify reconciliation and verified history

Raw observations are deliberately unverified. Use the protected history replay/reconciliation workflow only after raw persistence is confirmed. Then inspect `/api/data-pipeline/status`, `/api/fixtures`, and `/api/history/status`.

- A canonical fixture must have corroborating provider evidence and a safe, unambiguous identity.
- A finished score enters the verified-results ledger only when independent providers agree on fixture identity, finished status and score.
- Conflicts and unresolved provider team IDs must remain blocked; do not auto-map a team merely to increase coverage.
- Replay diagnostics should be checked for conflict reasons and stale records.
- Confirm counts persist after restart/redeploy.

This app has separate provider-ID reconciliation and prediction-time canonical-name mappings. A provider candidate or catalogue result is not automatically a prediction mapping. The identity-gate migration adds `identity_reviewed = FALSE` to existing canonical rows; those legacy rows are retained for audit but excluded from forecasts, historical model inputs, out-of-sample evaluation and ticket settlement until the new pipeline safely rebuilds them. A replay that encounters unresolved API-Football/Sportmonks IDs that could participate in canonical matching reports `snapshotReplacementSkipped` and preserves the existing snapshot rather than deleting evidence during partial identity review. A replay with no eligible canonical candidates (including a batch containing only unreviewed SportAPI IDs) also skips snapshot deletion and reports `snapshotReplacementSkipped`; an empty eligible set is never treated as proof that the old snapshot should be cleared. Unreviewed SportAPI fixture IDs are excluded from canonical matching and do not permanently block cleanup of a safe primary-provider snapshot when eligible reviewed candidates are present; an operator-reviewed SportAPI ID can participate after passing the same identity gate.

### Explicit SportAPI identity review

- Only review a candidate from the latest saved successful SportAPI.ai search for the selected watchlist team.
- The review path requires an exact or curated alias match, country agreement, and squad-category agreement. Missing country/category context is not treated as a match.
- A confirmed provider ID cannot be assigned to another watchlist team or silently replaced. Each approval creates a durable `provider_identity_review_events` audit row.
- `reviewed_by` is an operator-supplied audit label; it is not proof of an authenticated person's identity. In production, configure `PROVIDER_DIAGNOSTICS_TOKEN` and restrict it to trusted operators. The review endpoint is disabled outside development/test if that token is absent.
- Operator approval establishes provider-team identity only. It does not independently corroborate a fixture, verify a result, create historical evidence, calibrate predictions, enable betting recommendations, or settle a ticket.

## 6. Verify prediction readiness without bypassing gates

Inspect `/api/predictions/status`, `/api/predictions/ledger?limit=20`, and `/api/data-pipeline/status`. A forecast requires a corroborated fresh future fixture, reviewed exact team identities, and sufficient verified settled results from the same competition strictly before kickoff. The model must abstain with null probabilities when those conditions fail.

Forecast availability is not the same as model calibration. Betting recommendations remain disabled until genuinely out-of-sample evaluation and calibration requirements are met. Never add bookmaker odds as a substitute for team-performance evidence or use odds to drive the independent prediction model.

## Current limitation

No deployment URL, production database, or live provider credentials are verified by CI alone. The database-backed CI test uses an ephemeral PostgreSQL instance and verifies application persistence logic; it does not certify production connectivity, provider quota/coverage, full 80-team mapping, historical completeness, model calibration, or live ticket settlement.
