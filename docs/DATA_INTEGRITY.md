# Data integrity policy

Every normalized fact retains canonical entity/fixture ID, provider and provider record ID where available, retrieval timestamp, event/valid time, validation state/reasons, and an audit reference. Never store credentials in payload archives or logs.

Use explicit states: `verified`, `unverified`, `stale`, `conflicted`, `unavailable`, `insufficient_evidence`. Provider error is not empty success. Missing is not zero. Unknown is not false.

Only documented settled/final states plus valid scores qualify for verified-history counts. Postponed, abandoned, awarded, incomplete or conflicting results need special handling.

Forecast records preserve input cutoff, feature snapshot, model version, generated timestamp, probabilities and later outcome link. Never rewrite past forecasts after outcomes are known.

Evaluation must use chronological splits and prevent post-kickoff information from entering pre-match features. Report calibration and uncertainty with sample counts.

Abstain when evidence is insufficient, with explicit reasons such as missing history, conflicting fixture identity, stale odds, uncalibrated model or incomplete provider coverage.
