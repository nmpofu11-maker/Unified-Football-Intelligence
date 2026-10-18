# Verified ticket settlement core

This module is the deterministic settlement rule layer for accumulator tickets. It is intentionally separate from model predictions and bookmaker odds.

## Rules

- Only a result marked `verified`, with matching fixture identity, finished status, valid score, and a settlement timestamp at/after kickoff can settle a selection.
- A single verified losing selection makes the whole ticket `lost` immediately, even while other selections are pending.
- Missing, conflicted, unverified, or mismatched results stay pending; they are never treated as wins.
- The core supports 1X2, both-teams-to-score, total goals, double chance, and draw-no-bet.
- Draw-no-bet draws and totals exactly equal to the selected line are treated as void.
- A ticket is `won` only when every selection is resolved as won or void and at least one selection won. An all-void ticket is `void`.
- Invalid ticket identity or unsupported market/pick combinations are withheld.

## Integration boundary

`src/tickets/settlement.ts` is currently a pure, tested domain function. It does **not yet** create a persistent ticket store, poll providers, or update BetMatrix tickets. Production integration must call it only after the canonical verified-result store has settled a fixture, persist each evaluation with provenance, and rerun settlement when a verified result correction arrives. Until that integration is merged and live-tested, do not describe automatic ticket settlement as active in the deployed app.

Run `npm test` to execute its unit tests.
