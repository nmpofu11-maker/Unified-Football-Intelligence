# PostgreSQL setup and persistence verification

This app stores **raw, unverified provider observations only**. Connecting a database does not create canonical fixtures, verify scores, load the 80 teams' histories, calibrate forecasts, or enable betting recommendations.

## 1. Create a PostgreSQL database

Use a managed PostgreSQL service or a PostgreSQL instance you control. Create a database and a least-privilege application user. Copy the provider's PostgreSQL connection URL from its dashboard. Use the provider's required TLS/SSL options; do not disable certificate verification to work around a connection problem.

Keep the connection URL private. It contains credentials. Do not paste it into chat, commit it to Git, or place it in browser/frontend configuration.

## 2. Configure the local app

In the repository root, copy `.env.example` to `.env` if you have not already done so. Set `DATABASE_URL` to the connection URL supplied by your database provider, for example:

```dotenv
DATABASE_URL=postgresql://APP_USER:REDACTED@DB_HOST:5432/APP_DATABASE?sslmode=require
```

This is a format example only, not a working credential. Use the exact URL/options supplied for your database. If your provider's URL uses a different SSL setup, follow that provider's instructions.

Restart the Node server after changing `.env`; environment variables are read by the server process at startup. The repository's `.gitignore` excludes `.env`.

## 3. Configure the deployed service

In the hosting platform's **server-side/runtime environment variables or secrets** settings, add `DATABASE_URL` with the same database connection URL. Do not add it to a frontend build variable, public environment variable, or client-side bundle. Redeploy/restart the service so the new variable is loaded.

The database must accept network connections from the hosting service. Restrict database network access and credentials to the minimum necessary. Never publish the connection string in logs or diagnostic output.

## 4. Verify the connection before ingestion

With the server running, open:

- Local: `http://localhost:3003/api/storage/status` (use the port configured for your server)
- Deployed: `https://YOUR-SERVICE-HOST/api/storage/status`

Expected connected response:

```json
{
  "configured": true,
  "state": "ready",
  "observationCount": 0
}
```

The count may be greater than zero if observations were already stored. Interpret results as follows:

- `state: "not_configured"`: the running process did not receive `DATABASE_URL`; check the correct environment and restart.
- `state: "error"`: the app could not use the database. The `errorCode` is sanitized; inspect the database provider's connection settings and server-side logs without exposing credentials.
- `state: "ready"`: a live query succeeded. This is a connectivity check, not yet proof that fixture observations are being saved.

## 5. Verify an observation is durable

1. Confirm `/api/storage/status` reports `state: "ready"`.
2. In the app dashboard, run **Check providers** once for a date with provider data.
3. Inspect the response's `persistence` object. Expect `state: "saved"` and `inserted` greater than zero when new valid candidates were returned. `duplicatesSkipped` can be greater than zero on repeat checks because observations are deduplicated.
4. Re-open `/api/storage/status` and confirm `observationCount` increased.
5. Restart the app process and query `/api/storage/status` again. The count should remain. For a deployment/redeploy test, repeat against the same external database.

If no records were returned by a provider, a `connected_empty` result can still demonstrate that the database write path reached the database, but it does not prove a new row was inserted. Do not treat a provider HTTP 200 alone as evidence that fixture data exists.

## Current boundaries

- PostgreSQL stores provider observations with provider IDs, observed time, provenance and raw normalized payload.
- Observations retain `evidenceState: "unverified"`. The database write path rejects candidates with any other evidence state.
- Canonical fixture creation remains disabled; the reconciliation output is only a preview.
- Team/provider/competition identity mappings and settled-result verification remain outstanding.
- Verified history, calibrated forecasts, and betting recommendations remain disabled until their separate evidence and validation gates pass.
