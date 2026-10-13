# Win-Path Panel — Implementation Notes (v1.61)

Turns the Turn Coach from a score-blind priority ladder into a score-aware advisor.
**The opponent's position drives every recommendation and appears nowhere in the UI.**

## What the panel shows

Four rows, plus an optional trigger. No scores, ever.

```
┌──────────────────────────────────────────────────────────┐
│ OBJECTIVE    Close out the game — 2 VP to go             │
│ BOTTLENECK   2 ore short (you make 0.19/roll)            │
│ DO NEXT      Build a CITY on your 9-wheat / 6-ore        │
│              +1 VP and doubles that hex (11p).           │
│ ALTERNATIVE  Buy a DEV card                              │
│              Knights drive Largest Army (1 more needed). │
│ CHANGES IF   you reach 3 knights — Largest Army is +2 VP │
│              and may be faster than building             │
└──────────────────────────────────────────────────────────┘
```

Deliberately **not** displayed: my VP, the opponent's VP, their hidden-VP estimate, their unplayed
dev-card count. Colonist already shows all of it. What is allowed: VP *deltas* (`+2 VP`), the goal
distance (`2 VP to go`), the win target, hand size vs the discard limit, and my own knight/road counts.

## Stage 1 — live state (`processStateObject`)

Five fields were already arriving in the stream and were parsed only by the offline reviewer.
**Every one arrives as a partial diff and must be merged, never replaced.**

| State | Source | Note |
|---|---|---|
| `state.vp[color]` | `playerStates[].victoryPointsState` | VP by category. Merged. |
| `state.awards.la/lr[color]` | `mechanicLargestArmyState` / `mechanicLongestRoadState` | Holder flags. The loser is told via an explicit `null`. |
| `state.roadLen[color]` | `mechanicLongestRoadState.longestRoad` | **Chain length, server-computed — no graph search.** |
| `state.knights[color]` | log type 20, `cardEnum === 11` | Per-colour; `state.dev.played` is deck-wide and unusable for the LA race. |
| `state.robberTile` | `mechanicRobberState.locationTileIndex` | |
| `state.tradeRatios[color]` | `playerStates[].bankTradeRatiosState` | Changes mid-game when a port is taken. |
| `state.myDevCards` | `mechanicDevelopmentCardsState` | My enums are revealed; the opponent's are all `10` (face-down). |

**Why merging matters:** tracking the last value seen reads a player truly on 15 VP as **3**.

| Tracking | My VP == end-game truth |
|---|---:|
| Last value seen | 7/40 sampled |
| **Cumulative merge** | **165/165** |

All of it is cleared in `softReset()`, or a merged score leaks into the next game.

## Three bugs found

### 0. The city-upgrade diff trap — *in the live path* (v1.62)

A settlement→city upgrade arrives carrying only `buildingType: 2`, with **`owner` omitted** — the
owner didn't change, so the diff doesn't repeat it. `processStateObject` required an owner and
skipped the entry, so **every city upgrade was dropped from live state**.

| | before | after |
|---|---:|---:|
| live city count == end-game truth | **8/60** | **342/342 slots** |
| live settlement count == truth | 8/60 | 342/342 |

Symptoms, all reported from a real game: the objective read *"Build your engine toward your first
city"* for the whole game; the advisor offered to **build a city on a corner that was already a
city** (`bestCityTarget` reads `myBuildings(1)`, which still held upgraded corners); and
`myResProd` weighted cities ×1 instead of ×2, under-reporting production and skewing the bottleneck.

This is **the same bug that was fixed in `reviewAnalyze` long ago** and is documented in the primer
as a known trap — the live path simply never got the fix. Both paths now resolve each field from the
previous known state when the diff omits it.

After the fix, "toward your first city" is 35% of sampled objectives (the genuine early game)
instead of effectively all of them.

## Two bugs found while building this

### 1. VP award categories were documented backwards

`3` is **Largest Army** and `4` is **Longest Road**, not the reverse. Both are worth 2 VP, so every
VP total and every arithmetic check was unaffected — which is why it survived so long. Caught by
cross-checking the categories against the award mechanic states:

```
hasLargestArmy === category 3   →  330/330 player-slots
hasLongestRoad === category 4   →  330/330 player-slots
```

Anything reading a category *individually* was wrong; anything summing them was fine.

### 2. `awards` in saved records was wrong in 46/165 games

`reviewAnalyze` replaced the award mechanic states per message instead of merging. Only ~7% of
longest-road frames carry `hasLongestRoad` (the rest carry just the chain length), so the final
frame almost always lacked the flag.

| field | before | after |
|---|---:|---:|
| `awards.lrMe` | **46/165 wrong** | **0/165** |
| `awards.laMe` | 0/165 | 0/165 |

Fixed; `REPLAY_VERSION` → `1.61`. **Any past analysis using `awards.lrMe` is suspect** — derive
awards from the end-game VP categories, which were always correct.

## Stage 2 — the engine (`winPathFacts` → `winPathCandidates` → `winPathPlan`)

Candidates carry the VP they *certainly* add now, so "does this win?" is a comparison, not a special
case. Tiers, in order — but not rigidly: a guaranteed win always outranks defence, and a speculative
route never displaces a reliable one.

| Tier | Fires when | Example |
|---|---|---|
| `win` | an affordable action closes the whole gap | "Play a KNIGHT — takes Largest Army and wins" |
| `win-maybe` | same, but via Longest Road (topology-dependent) | flagged as needing a check |
| `defend` | opponent ceiling ≥ target, or visibly within 2 | "Race" / "Deny — take an award before they close" |
| `closing` | ≤ 3 VP to go | prefers whatever adds VP soonest |
| `engine` | nobody close — **production gain decides, not a fixed order** | "City doubles that hex" |
| `fallback` | nothing affordable | trade, or hold deliberately |

Key rules encoded:

- **A city is a net +1 VP** — it replaces a settlement, it doesn't add one.
- **Playing a knight already in hand costs nothing.** If it completes Largest Army that is +2 VP for
  free — the most-missed winning move, so it is evaluated first.
- **Awards must be *exceeded*, not matched.** Equal knights or equal road length does not take the award.
- **Taking an award from the opponent is a 4-VP swing** (+2 me, −2 them) and is flagged as such.
- **A win must actually close the gap** (`c.vp >= need`, `need > 0`). Testing
  `myVP + c.vp >= vpToWin` alone labelled a 0-VP road "the winning move" once the score already sat
  at the target — caught in replay.
- **Longest Road is only suggested within 3 segments.** Advising a road when the award is 9 away is
  noise.
- **Bank trades are used to reach a build**, honouring live 2:1 / 3:1 port ratios, and only ever
  spending genuinely spare cards.

### Honesty

- My VP is exact. The opponent's is **visible only**; their unplayed dev-card count is a
  rule-guaranteed *upper bound* on hidden VP (0 violations in 165 games), never an assumption.
- The threat line is qualitative — *"Opponent may already have enough hidden points to win"* — and
  never names a card count.
- Zero unplayed cards is the one certainty: they provably hold no hidden VP (29/29 games).
- No dice prediction anywhere. "Affordable" means from cards in hand, now.

## Verification

```bash
node tools/winpath_check.js      # live state vs end-game truth, all 165 captures
node tools/winpath_logic.js      # 36 decision-logic assertions
node tools/winpath_e2e.js 165    # advisor driven on real boards, 1477 calls
node tools/setup_regression.js   # opening advisor unchanged (fingerprinted)
node tools/replay_check.js       # saved-record fields unchanged
```

| Acceptance criterion | Result |
|---|---|
| Live VP matches final truth across every capture | **171/171** (opponent: 171/171 == truth − hidden) |
| Live settlements + cities match end-game piece counts | **342/342** (guards the city-upgrade diff) |
| Objective never says "first city" once a city exists | **0** violations in 1,484 calls |
| Award points never double-counted | **0** games with 2 simultaneous holders; `laNeed = 0` when held |
| City upgrade is a net +1 VP | ✅ asserted |
| Immediate winning routes recognised | ✅ incl. the free-knight win |
| Opponent VP/hidden estimates affect advice without being displayed | ✅ 0 leaks in 1477 real calls |
| Winning actions prioritised over generic development | ✅ same hand ⇒ different advice by score |
| Award transfers and winning routes recognised | ✅ must-exceed semantics asserted |
| Ties and hidden-information uncertainty handled | ✅ 7 assertions |
| Opening recommendations and unrelated UI unchanged | ✅ 60/60 fingerprint match, 0 drift |

**Untouched:** `PLACEMENT_SCORER_VERSION` (`v1.50`), the `V150` weights, board lean, engine
thresholds, and `scorerConfigHash` (`ee784b36`).

### Known, pre-existing (not introduced here)

Between the 4th setup settlement and the first roll, both the setup advisor and the Turn Coach can
be active: `computeSetupAdvice` ends at the first roll, while `computeTurnCoach` starts once 4
corners are owned. The guard lines are unchanged from before this work. Left alone as out of scope.
