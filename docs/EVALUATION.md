# Chronological out-of-sample evaluation

Endpoint: `GET /api/evaluation/out-of-sample`.

The endpoint joins saved forecasts to verified settled results and reports metrics only for records that satisfy all of these conditions:

- The canonical fixture is corroborated and finished.
- The result is verified and its verification timestamp is at or after kickoff.
- The forecast timestamp is strictly before kickoff.
- The forecast feature cutoff is no later than the forecast timestamp.
- The 1X2 probabilities are finite, non-null, in [0, 1], and sum to 1 within tolerance.
- Scores are valid non-negative integers.
- Only the latest eligible forecast per fixture/model/version is counted, so repeat snapshots do not multiply-weight one match.

The default minimum is 30 eligible fixture/model/version records. Below that threshold the endpoint returns `state: "insufficient"` with `brierScore`, `logLoss`, and `accuracy` all `null`. It never fills unknown performance with zero or a placeholder.

When the threshold is met, the endpoint returns multiclass Brier score, log loss and accuracy from eligible records. These metrics are descriptive chronological evaluation, not calibration approval or proof that betting is profitable. Betting recommendations remain disabled.

This is not a full historical walk-forward training/backtest system: the current Poisson baseline is exploratory and uncalibrated, and deployment/database/source coverage must be verified separately.
