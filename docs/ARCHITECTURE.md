# Architecture

## Direction
Begin as a modular monolith with strict module boundaries, not a fleet of microservices. This keeps deployment affordable while separating provider ingestion, canonical data, analysis, predictions, betting decisions, and presentation.

```text
Provider APIs -> Provider adapters -> Raw evidence archive
   -> validation/normalization -> canonical football domain
   -> fixture monitoring + team history + result reconciliation
   -> leakage-safe feature snapshots -> versioned statistical models
   -> out-of-sample evaluation/calibration -> odds/value comparison
   -> risk gates -> selective recommendations -> dashboard/audit trail
```

## Modules
- `providers`: authentication, pagination, timeouts, rate limits, parsing, diagnostics; no prediction logic.
- `ingestion`: scheduled/on-demand collection, idempotency, bounded retries and backoff.
- `domain`: canonical entities and validation rules independent of frameworks.
- `reconciliation`: conservative identity matching and cross-provider conflict detection.
- `history`: verified settled results and per-team rolling history.
- `features`: snapshots using only information available at prediction time.
- `models`: reproducible deterministic baselines with versioned inputs.
- `evaluation`: chronological backtests, calibration, Brier score, log loss and comparison with baselines.
- `markets`: odds, market rules, implied probabilities, margin removal and stale-quote rejection.
- `risk`: limits and reason-coded abstention; no forced recommendations.
- `explanations`: optional local/hosted LLM summaries grounded in supplied evidence.
- `api`/`web`: interface that never invents missing fields.
- `observability`: provider health, freshness, quality, model version and persistence health.

## Persistence
PostgreSQL is the intended durable system of record. Raw provider evidence, normalized facts, predictions and user decisions are separate records. Production requires backup/restore and restart/redeploy persistence tests. In-memory cache is never the system of record.

## Providers
Initial investigation priority: SportAPI.ai and Sportmonks. TheRundown is secondary where coverage, terms and rate limits allow. API-Football is optional. Audit endpoint contracts and field coverage before calling any adapter production-ready. HTTP 200 does not alone make data verified.

## Forecasts and recommendations
Start with a transparent statistical baseline (for example, Poisson goals with league/home advantage). Add complexity only when chronological out-of-sample evaluation beats baselines. Probabilities must sum to 100% within tolerance and must not default to identical values for unrelated matches. Insufficient evidence means abstain.

A forecast can be shown for analysis while a betting recommendation remains withheld. Recommendation gates include calibrated model, current valid odds, understood settlement rules, uncertainty-aware expected value, sufficient data freshness and risk controls.

## AI role
AI may explain verified facts, identify gaps and suggest research. It may not create canonical statistics, change probabilities, mark data verified or deploy a model without deterministic checks and explicit approval.
