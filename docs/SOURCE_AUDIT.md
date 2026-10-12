# Source repository audit — findings from GitHub inspection

**Scope:** Read-only inspection of selected source files. This is a focused first pass, not a full line-by-line security or test audit. No source repository was modified by this rebuild work.

## Current source references inspected

| Source | Ref inspected | Evidence / observations | Initial reuse decision |
|---|---|---|---|
| `SoccerPredict-pro` | `feature/bsd-stage-a-provider`; `package.json` blob `a2468d2255102ec899ea02976f3a7f82003a37f9` | Provider client `src/services/serverFootballApis.ts` blob `6722ad1a7c2ddf2fec1c67a09429725925682a59`; SportAPI.ai client `src/services/serverSportApiAi.ts` blob `740292db4f292da736fab65e364e5dbd8f9d2ba1`; enrichment service blob `d01db1a77cb7c618434f0a686dd7e6f3e2f1b448`. Uses server-only credentials, provider calls, caches and team/competition/kickoff-aware matching. | `verify_before_reuse`: retain adapter concepts and tests, rewrite behind canonical evidence contracts; inspect complete matching and cache/error paths before copying. |
| `BetMatrix-AI---Hollywoodbets-Intelligent-Betting-Engine` | `main`; `package.json` blob `f6a05da4cdd518c1d97e1655e370cc83485127cd` | README describes provenance-first fixtures, results, odds and ticket evidence. `src/data/mockBetHistory.ts` blob `57a757324b476fe3f2fcefe3f0e415e476331538` initializes empty records. `src/verified-data/store.ts` blob `63f6856c298af9103ef61ce783416d99932b6135` writes JSON atomically but uses local `./data`; persistence can be ephemeral on serverless hosts. `server.ts` initializes verified-data services and local JSON ledger. | `reuse_concept`: reuse domain rules and tests selectively; rewrite storage interface and use durable database/object storage in production. Audit all write routes and storage failure behavior. |
| `Football-Analytical-Engine` | `main`; `package.json` blob `dde3b7a35dcf7988405777b18a5f180bc9288035`; merged PR #32 | `src/unified/contracts.ts` blob `143059dd721bea1cbf9bcdfa773e9d1d0d34a4e4` defines canonical contracts and gates. `src/services/serverSportmonks.ts` blob `397de05fdc5a9428b0a47078027ffe61f04c74b2` defines diagnostics and a Sportmonks adapter. `server.ts` blob `a791ec3c8ce0684b84cfcf53f1fb13e854c7f94f` integrates SportAPI.ai, Sportmonks, TheRundown and local server-db. Architecture notes that fixed expected-goal priors remain and calibration is not established. | `verify_before_reuse`: the contract/reconciliation tests are useful references; reimplement independently in this greenfield app and compare behavior against tests. Do not assume sample availability proves calibration. |

## Important repository-state correction

GitHub currently reports [Football-Analytical-Engine PR #32](https://github.com/nmpofu11-maker/Football-Analytical-Engine/pull/32) as **merged**, with merge commit `4a809954df03b0a9a4eea49a63ed6d3c6905f093` and merge timestamp `2026-10-12T16:40:46Z`. This is observed repository state, not a change made by this greenfield work. Leave the source repository untouched; the new app remains a separate project.

## Confirmed technical details and cautions

- `SoccerPredict-pro`'s inspected `serverSportApiAi.ts` documents `GET /api/fixtures/date/{YYYY-MM-DD}` and sends both `X-Api-Key` and `Authorization: Bearer` headers. It treats HTTP 429 as a rate-limit state and returns an empty list during the block. Therefore, an empty array alone cannot mean “no fixtures”; diagnostics must distinguish rate limit from a genuine empty success.
- `SoccerPredict-pro`'s enrichment path uses normalized names, a three-hour kickoff window, and competition compatibility checks. This is better than name-only matching, but the greenfield implementation should prefer provider IDs and strict canonical fixture keys, and retain ambiguity/conflicts rather than auto-merging uncertain candidates.
- `BetMatrix`'s verified store uses `process.cwd()/data/verified-data.json` with a temporary file plus rename. This is useful for local atomic writes, but it is not durable storage proof in serverless/cloud deployments.
- `Football-Analytical-Engine`'s merged PR adds a Sportmonks adapter and cross-provider fixture/result reconciliation. The PR body itself says live provider responses and durable production persistence still require host verification. No such live calls were run by this audit.
- The source projects use different schemas and package versions. Do not combine their `package.json` files or copy whole server entry points into the new app.

## Still required before adapter reuse

1. Review full provider endpoint functions, pagination, rate-limit/auth failures, parsing and fixture/result field mappings.
2. Review every source's tests and execute them against a clean install; record exact commit SHAs for the complete audit snapshot.
3. Verify actual live API responses with authorized credentials outside this chat; never treat key presence or HTTP 200 as enough.
4. Inventory the original 80-team list and aliases from the source data rather than reconstructing it from memory.
5. Compare existing deterministic rules and prediction tests against the greenfield model; do not promote any model to betting use without chronological out-of-sample calibration.
6. Decide and test durable persistence for the intended deployment. Local JSON files on a serverless filesystem do not satisfy the production persistence gate.
