# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A Chrome MV3 extension giving live strategy advice for **1v1 colonist.io, 15 VP, discard at 10**
(not base Catan — the ruleset differs and it matters), plus an offline research pipeline.

Read [`CATAN_1V1_PRIMER.md`](CATAN_1V1_PRIMER.md) before reasoning about game logic or the
protocol. It is the source of truth for the rules, the scoring model and the recording pipeline.

## Non-negotiable rules

1. **Document every change in `CONVERSATION.md`** — one row per version, at the top of the table.
   State what changed, why it mattered, and the measurement (before/after numbers, not adjectives).
   Update any stale figures in the primer/README in the *same* commit.
2. **Never delete `raw/`.** Derived records regenerate; raw does not. Game data lives outside this
   repo in `~/Downloads/Catan saved games/` and is gitignored.
3. **Never overwrite `capturedScorer`** — it records the scorer the player was *shown*. Carry it
   forward on any regeneration.
4. **Do not tune the placement scorer.** `PLACEMENT_SCORER_VERSION`, the `V150` weights, board lean
   and engine thresholds are frozen for the current collection run. ~86 decided games cannot support
   it; a prior out-of-sample test showed data-derived weights performing *worse* than hand-set priors.
   Prefer intermediate metrics (first-city timing, blocked income) over win rate.
5. **The advisor shows no scores** and never claims knowledge of hidden cards or future dice.

## Verify before claiming

Replay **real captures through the real code path** — not a mock, and not the offline reviewer
standing in for the live path. That distinction is exactly how the city-upgrade bug survived months.

```bash
node -c sidepanel/sidepanel.js
node tools/winpath_check.js      # live state vs end-game truth
node tools/winpath_logic.js      # decision-logic assertions
node tools/winpath_e2e.js 165    # advisor on real boards
node tools/setup_regression.js   # opening advisor unchanged
node tools/replay_check.js       # saved records reproduce
```

Run all of them before committing. New behaviour needs a new assertion. **A check that cannot fail
is worthless** — prove a new validation rejects deliberately damaged input.

## Architecture

```
interceptor.js (MAIN world, WS hook) → content_bridge.js → background.js (durable buffer)
                                                                    ↓
                        sidepanel.js:  processStateObject()  ← LIVE, incremental
                                       reviewAnalyze()       ← OFFLINE, pure replay
                                       buildGameRecord()     ← saved record
```

Two state paths exist and **both must be fixed when the protocol bites.** `processStateObject` is
incremental and drives the UI; `reviewAnalyze` is a pure function over the whole message array and
drives records/research. Never call `reviewAnalyze` per live message — it is O(n) per call.

## Protocol traps

| Trap | Consequence if missed |
|---|---|
| `tileCornerStates` upgrades omit `owner` | every city dropped (shipped twice) |
| `victoryPointsState` is a partial diff | a 15-VP player reads as 3 — merge cumulatively |
| Award mechanic states are partial diffs | `awards.lrMe` was wrong in 46/165 records |
| `victoryPoints` is category → **count** | naive sum flags 100% of games as concessions |
| category `3` = **Largest Army**, `4` = **Longest Road** | both worth 2 VP, so totals hide the error |
| Winners can exceed 15 VP | assert `>= vpToWin`, never `== 15` |
| Server winner may be **behind** on VP | `leaderVP` for position, `winner` for outcome |
| A valid raw file may be a partial game | that is what `researchEligible` is for |

## Version constants (`sidepanel/sidepanel.js`)

Four layers move independently — bump only what changed: `CAPTURE_VERSION`,
`PROTOCOL_PARSER_VERSION`, `REPLAY_VERSION`, `RECORD_SCHEMA_VERSION`, plus `manifest.json`.
`scorerConfigHash` exists to catch constants edited without a version bump.

## Style

Match the surrounding code: comments explain *why*, especially where a protocol quirk forced the
shape of something. Several comments in `sidepanel.js` are load-bearing — they are the only record
of a trap that cost real debugging time. Don't strip them.
