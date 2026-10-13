# Phase-Aware Advisor — Capability Audit, Opportunity Matrix, and MVP Proposal

**Date:** 2026-10-10
**Mode:** 1v1 Colonist, 15 VP, discard at 10, **no player-to-player trading**.
**Evidence base:** the 165 fresh games audited in `CATAN_165_GAME_AUDIT_VALIDATION.md`.
**Status:** Stages 1–2 **shipped in v1.61** — see `CATAN_WIN_PATH_IMPLEMENTATION.md`. Stages 3–5
remain proposed. Two corrections were folded back into this document after implementation: the VP
award categories were documented backwards (3 = Largest Army, 4 = Longest Road), and
`mechanicLongestRoadState` turns out to carry each player's **road chain length**, so the Longest
Road race needs no graph search.

---

## Part 2 — What the extension can actually support

### 2.1 The central finding

> **Five game-state fields are already arriving in the live WebSocket stream, are already parsed by
> the offline review code, and are not used live at all.** One of them — `victoryPointsState` —
> turns out to carry an exact live victory-point breakdown.

This is the whole reason a phase-aware advisor is cheap to build: the hard part (capture, decode,
state replay) is done. What's missing is reading five fields that are already in the pipe.

### 2.2 Live availability — probed from raw, not assumed

Measured with `tools/live_fields.py` over 40 captures, counting **only frames that arrive before the
type-45 end-game message**.

| Field | Live? | Games | Currently wired live? | What it gives |
|---|---|---:|---|---|
| `currentState` | ✅ | 40/40 | ✅ yes | current turn colour, `completedTurns` |
| `playerStates[].resourceCards` | ✅ | 40/40 | ✅ yes | **my exact hand**; opponent **count only** |
| `mapState.tileCornerStates` | ✅ | 40/40 | ✅ yes | every settlement/city + owner (`1`=settlement, `2`=city) |
| `mapState.tileEdgeStates` | ✅ | 40/40 | ✅ yes | every road + owner |
| `gameLogState` | ✅ | 40/40 | ✅ yes | full event stream: rolls, builds, trades, steals, dev plays |
| `mechanicDevelopmentCardsState` | ✅ | 40/40 | ⚠️ counts only | bank remaining; per-player counts; **my own card types** |
| **`playerStates[].victoryPointsState`** | ✅ | 40/40 | ❌ **no** | **VP by category, per player** |
| **`mechanicLargestArmyState`** | ✅ | 40/40 | ❌ **no** | who holds Largest Army |
| **`mechanicLongestRoadState`** | ✅ | 40/40 | ❌ **no** | who holds Longest Road |
| **`mechanicRobberState`** | ✅ | 40/40 | ❌ **no** | robber's current tile |
| **`playerStates[].bankTradeRatiosState`** | ✅ | 40/40 | ❌ **no** | my per-resource trade ratio (4:1/3:1/2:1) |

Fields that **never** appear before the end-game frame — any feature needing these is impossible
live, regardless of effort:

| End-game only | Consequence |
|---|---|
| `resourceStats` (rolling/robbing/dev/trade income and loss) | No live "income so far" |
| `activityStats` (`resourceIncomeBlocked`, `devCardsBought/Used`, `resourcesUsed`) | **No live blocked-income metric** |
| `diceStats`, `totalTurnCount`, `gameDurationInMS` | No live luck summary from the server |
| `rankedUserStates` (MMR) | Opponent strength unknown during play |
| **Opponent dev-card types** | Always enum `10` (face-down). **1,119 observations, 0 revealed.** |

### 2.3 Two traps verified by probe (do not skip these)

**Trap 1 — `victoryPointsState` arrives as a partial diff.** Tracking "the last value seen" gives
catastrophically wrong answers: a player truly on 15 VP reads as **3**. It must be merged
cumulatively per player.

| Tracking method | My VP matches final truth |
|---|---:|
| Last value seen (naive) | 7/40 sampled |
| **Cumulative merge — validated on the full corpus** | **165/165 (100%)** |

**Trap 2 — the opponent gap is exactly their hidden VP cards, and that is correct behaviour.**
Category `2` (VP development card) appears **only in my own** `victoryPointsState`, never the
opponent's. The server is not leaking hidden information, and we must not pretend otherwise.

Validated across all 165 games: **the opponent's live-VP shortfall equals their hidden VP-card count
in 165/165 games — exactly.** Their VP cards are the *only* thing we cannot see; everything else
about their score is observable in real time.

| Opponent's hidden VP cards | 0 | 1 | 2 | 3 | 4 |
|---|---:|---:|---:|---:|---:|
| Games (of 165) | 49 | 46 | 45 | 18 | 7 |

**70% of the time the opponent holds at least one hidden VP card.** This is the single most
decision-relevant fact a live advisor could surface, and it is honestly estimable (below) rather
than known.

### 2.4 A calibrated, honest estimator for opponent hidden VP

Unplayed dev cards still in the opponent's hand are observable live (count only). Against the
end-game truth across **all 165 games**:

| Opponent's unplayed dev cards | n | Mean VP cards actually held | Max observed |
|---:|---:|---:|---:|
| 0 | 29 | **0.00** | 0 |
| 1 | 40 | 0.68 | 1 |
| 2 | 47 | 1.43 | 2 |
| 3 | 22 | 2.23 | 3 |
| 4 | 21 | 2.86 | 4 |
| 5+ | 6 | 2.50 | 4 |

**The upper bound was never violated once in 165 games** (0 cases of VP cards > unplayed cards),
which is guaranteed by the rules — a VP card is never played, so it is always still in hand.

Two usable properties, both confirmed on the full corpus:

- Unplayed count is a **hard upper bound**.
- When it is **0, the opponent provably has no hidden VP** — true in **29/29** such games. This is a
  certainty, not an estimate, and it is exactly when the advisor can safely say "they are not
  closer than they look."

Otherwise ≈ 0.7 × count is a reasonable central estimate — because a rational opponent plays
knights/monopoly/road-building and only *holds* VP cards.

### 2.5 What `reviewAnalyze()` reconstructs, and whether it is safe live

`reviewAnalyze()` is a **pure function over a message array** — it builds its own local state and
touches no globals. Running it on a prefix of a live game is therefore safe and side-effect free.

**But it should not be the live engine**, for two reasons:
- It replays the entire message array from scratch (O(n) per call, ~1,200–2,200 messages/game).
  Calling it per message is O(n²).
- `processStateObject()` already maintains the same state incrementally and is already wired to the
  live port.

**Recommendation: extend `processStateObject()`, and reuse `reviewAnalyze()` only for post-game
review and offline research.** The five unwired fields are all read in `reviewAnalyze` already
(`sidepanel.js:2165–2168`), so the parsing logic can be lifted directly.

### 2.6 Existing vs proposed functionality

**Exists today (live):**
- Opening placement advisor + board-lean banner (the mature feature)
- Turn Coach: a **fixed priority ladder** — city → settlement → dev → road → hold/trade
  (`computeTurnCoach`, `sidepanel.js:916`)
- Robber placement advice when a move is owed
- Opponent hand *inference* (`reconcileHand`) — exact count, estimated composition
- Dice model, 7-risk, roll odds, dev-deck tracker, event log
- Post-game review and archive

**The Turn Coach's structural gap:** its ladder is **stateless with respect to the game situation**.
It does not know the score, whether anyone is near 15, who holds the awards, or what phase the game
is in. It gives the same advice at 3 VP and at 13 VP. That is the thing to fix.

| Effort | What it unlocks |
|---|---|
| **Modest** (read fields already in the stream) | live VP both sides · award holders · robber location · my port ratios · opponent hidden-VP estimate · VP-aware build priority |
| **Moderate** (new derivation over existing state) | distance-to-15 planning · bottleneck detection · knight-count tracking for the LA race · city-target ranking by production gain |
| **Heavy** (new infrastructure) | opponent *composition* inference beyond counts · road-network/longest-road search · multi-turn lookahead · denial modelling · any live use of blocked income (**impossible — end-game only**) |

---

## Part 3 — Phase-by-phase opportunity matrix

**Advice types.** **A** = rule-based (game mechanics + current state; true regardless of my data).
**B** = empirical (a repeated pattern in the fresh 165). **C** = personalized (needs evidence about
*my* decisions and outcomes).

> Generic Catan strategy is marked **A**, never **B**. Nothing below claims my 165 games taught us
> that cities are good.

### Phase 1 — Setup and opening placement

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| Which corner to take | board geometry, corners taken, seat | ✅ all | pip totals, resource coverage, port access — exactly computable | 165 games scored under one frozen scorer | **High (feature)**, low (weights) | *already shipped* | — (exists) |
| Which road to place | my settlements, edges, my next pick | ✅ all | legal-move + reachability | — | High | *already shipped* | — (exists) |

**Verdict: mature. Leave it alone.** The audit found no basis for changing weights, the gate, or the
lean. Type **A** with a **B**-tuned prior.

### Phase 2 — Early game: the path to the first city

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| Prioritize city vs expand | my hand, my corners+types, production by resource | ✅ all | exact: cost 2🌾+3⛰, production delta of upgrading each corner | **B:** STRONG openings reach 1st city at roll 21 vs MISSING at 46; 91% vs 56% ever build one | Med-High (association) | "City on your 6-ore doubles your best hex. You need 2 more ore." | **S** |
| Which corner to upgrade | corner production, robber tile | ✅ (robber unwired) | exact expected-card gain per upgrade | — | High (A) | "Upgrade 9-wheat/6-ore (+0.72 cards/roll) over 4-sheep (+0.19)." | **S** |
| Am I behind on engine pace | turn counter, my city count | ✅ | — | **B:** median winner's 1st city ≈ own turn 15 | Medium — exploratory, confounded | "Turn 18, no city yet. In this corpus the median winner had one by ~15." | **S** |

**This is the strongest evidence-backed phase.** The first-city signal survived MMR stratification in
all three strata and is visible ~50 rolls before the outcome.

### Phase 3 — City vs settlement vs road vs dev card

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| What to build now | hand, **VP both sides**, buildable targets, dev deck left | ⚠️ VP unwired | affordability + VP gain are exact; production gain exact | **B:** winners held LA 74%, ≥1 VP card 97%, 3–4 cities 86% | High (A) / Medium (B) | "City (+1 VP → 11). Alternative: dev card — you have 3 knights, LA is 2 away." | **M** |
| Settlement vs city when both affordable | open corners, pips, VP | ✅ + VP unwired | exact VP and production comparison | **B:** 100% of decided winners had ≥2 cities | High | "Both affordable. City is +1 VP now; the 4-brick settlement adds 0.3 cards/roll. Take the city." | **M** |
| Hold vs spend near the discard limit | hand size, discard limit, opponent 7-odds | ✅ all | exact — discard at 11+ | — | High (A) | "10 cards. A 7 (16.7%) costs you 5. Spend the road now." | **S** (partly exists) |

### Phase 4 — Midgame expansion

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| Where to expand | edges, corners, board, distance rule | ✅ all | legal placement + pip value exactly computable | — | High (A) | "Two roads reach 8-wheat/5-ore (8 pips) — your best remaining corner." | **M** (exists partially) |
| Expand vs upgrade | my corners, open corners, hand | ✅ | exact production comparison | — | Medium | "Expanding adds 0.44 cards/roll for 2 roads + settlement; upgrading adds 0.72 for one city." | **M** |
| Block the opponent's expansion | opponent roads/corners, open corners | ✅ all | reachability is exact; *value* to them is inferable | ❌ none | Low-Med (A only) | "The 6-ore corner is 1 road from their network." | **L** |

### Phase 5 — Bank trades and ports (no player trading)

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| Trade to complete a build | hand, **my trade ratios**, target cost | ⚠️ ratios unwired | **fully deterministic** — ratios are given, costs fixed | — | **High (A)** | "3:1 wood port: trade 3 wood → 1 ore. That completes the city this turn." | **S** |
| Which surplus to give | hand, production rates | ✅ | expected replacement time is computable | — | High | "Give sheep — you produce 0.58/roll, your highest." | **S** |
| Is a trade worth it | hand, ratio, what it unlocks | ⚠️ ratios | exact | — | High | "4:1 for the last wheat costs 4 cards for +1 VP. Worth it at 13 VP." | **S** |

**The cheapest high-value area in the whole matrix.** `bankTradeRatiosState` is live in 40/40 games
and changes during play in 29/40 (port acquisition is observable). Everything here is deterministic
arithmetic — no statistics, no inference, no hidden information.

### Phase 6 — Robber placement and defence

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| Where to put the robber | corners+owners, dice odds, opponent card count | ✅ all | exact expected-block value | **B:** in wins I was blocked 5.9 vs opp 8.7; in losses 8.7 vs 8.8 — the *differential* matters | Med (A high) | *mostly exists* — add "don't block your own hex" weighting | **S** (exists) |
| Respond to being robbed | robber tile, my blocked hexes | ⚠️ robber tile unwired | exact — which of my hexes is dead | — | High (A) | "Your 6-ore is blocked. Until a knight clears it you make 0.42 fewer ore/roll." | **S** |
| Keep a knight for unblocking | my dev cards (types known), robber tile | ✅ + robber unwired | exact | — | Medium | "You hold 2 knights and your best hex is blocked — play one." | **S** |

### Phase 7 — Development cards

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| Buy a dev card | hand, deck remaining, my knight count, LA holder | ⚠️ LA unwired | cost exact; deck count exact; **VP-card odds are computable from deck composition** | **B:** winners bought median 12 vs 8; LA holders won 81% vs 40% | Med (B is confounded) | "11 cards left. You have 2 knights; LA needs 3. Buying now is the main LA path." | **M** |
| Play knight vs hold | my card types (known), robber tile, LA race | ✅ + robber/LA unwired | exact | — | Medium | "Playing this knight makes 3 — takes Largest Army (+2 VP)." | **M** |
| Judge opponent's hidden VP | opponent dev count, their played cards | ✅ | **calibrated estimator, §2.4**; upper bound is rule-guaranteed | 165-game calibration, 0 bound violations | Med — explicitly probabilistic | "Opponent shows 11 VP and holds 3 unplayed dev cards — treat them as ~13, at most 14." | **M** |

### Phase 8 — Longest Road and Largest Army

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| Contest Largest Army | knights played (log), **LA holder** | ✅ **now wired** | knight counts exactly countable from the log | **B:** LA held by 72% of winners; 81.2% vs 39.5% win split | Med-High | "Opponent has played 2 knights. One more and they take LA from you (−2 VP for you)." | **S** |
| Contest Longest Road | edges, **LR holder + chain length** | ✅ **now wired** | **`longestRoad` gives each player's chain length directly — no graph search needed** | **B:** LR held by 74% of winners; 84.8% vs 37.5% win split, and common (46/86) | Med-High | "You hold Longest Road at 5. Two of their roads would tie it." | **S** |

**Note the asymmetry:** the *holder* flags are free (one field). Computing road length from scratch
is a real graph problem. Build the former, skip the latter.

### Phase 9 — Endgame: reaching 15

| Decision | Live inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| Cheapest path to 15 | **my exact VP**, hand, buildable targets, deck, awards | ⚠️ VP unwired | **fully deterministic** given VP + costs | **B:** avg winner = 9.9 building VP + 5.1 card/award VP | **High (A)** | "You're on 13. City = 15 and wins. You need 1 ore." | **M** |
| Am I about to lose | **opponent VP** + hidden estimate | ⚠️ unwired | visible VP exact; hidden probabilistic | §2.4 calibration | Med — honest range | "Opponent shows 12, holds 2 dev cards. They may already be at 14. Deny Largest Army." | **M** |
| Race vs deny | both VPs, award holders | ⚠️ unwired | exact VP arithmetic | ❌ no evidence on denial | Low (A only) | "Both at 13 — your city wins outright next turn. Race." | **L** |

**The 13-VP building ceiling is a hard rule worth encoding:** 5 settlements + 4 cities = 13 VP max
from buildings, so **every win requires ≥2 VP from cards or awards.** That is arithmetic, not
statistics, and the corpus confirms it (98.8% of winners held an award, 96.5% a VP card).

### Phase 10 — Post-game review

| Decision | Inputs | Available | Rule/deterministic | Dataset support | Confidence | Example advice | Complexity |
|---|---|---|---|---|---|---|---|
| What lost me this game | full record + raw | ✅ (exists) | — | all 165 | Medium | "First city at roll 44 (corpus median for winners: 26)." | **S** |
| Which decisions were pivotal | reconstructed timeline | ✅ offline | — | — | Low | needs a decision model that doesn't exist | **L** |
| **C**: my recurring mistakes | many games of my decisions vs outcomes | ⚠️ partial | — | **insufficient** | **Too low to ship** | — | **L** |

**Type C is not yet supportable.** It needs my *choices* logged against the advice shown, over
enough games to separate pattern from noise. We have the opening (165 games of rank/regret) but not
mid-game decisions. **Do not ship personalized mid-game coaching yet.**

---

## Part 5 — MVP proposal

### The recommendation: **the Win-Path panel**

A single always-visible block answering the five required questions, built almost entirely on the
five already-arriving fields.

```
┌────────────────────────────────────────────────┐
│  YOU 11  ·  OPP 9 (+0–2 hidden)                │
│  ─────────────────────────────────────────     │
│  ▸ OBJECTIVE   4 VP to win                     │
│  ▸ BOTTLENECK  ore — you make 0.19/roll        │
│  ▸ DO NEXT     Build CITY on 9-wheat/6-ore     │
│                → 13 VP. Need 2 ore.            │
│  ▸ OR          Buy dev card — 2 knights, LA    │
│                is +2 VP and 1 knight away      │
│  ▸ CHANGES IF  opponent plays a 3rd knight     │
│                (takes LA, swings 4 VP)         │
└────────────────────────────────────────────────┘
```

### Why this one

1. **It fixes the actual defect.** The Turn Coach currently gives identical advice at 3 VP and 13 VP.
   Score-awareness is the difference between a build-order cheat-sheet and an advisor.
2. **It is overwhelmingly rule-based (type A).** VP arithmetic, build costs, the 13-VP ceiling, and
   production deltas are all exact. It does not depend on the 86 decided outcomes, so **it cannot be
   invalidated by the sample being small** — the main risk in everything else we might build.
3. **It is cheap.** Five fields already in the stream; parsing already written in `reviewAnalyze`;
   one new UI block.
4. **It is honest by construction.** It shows my VP exactly (validated 165/165), the opponent's
   *visible* VP, and a calibrated *range* for what's hidden. It never claims to know their cards.
5. **It is verifiable before shipping — and the core of it already is.** Every live field can be
   replayed against the 165 raw captures with known end-game truth. The VP tracker has already been
   validated this way: **165/165 exact for my own score, 165/165 exact on the opponent's
   visible score**, with the residual being precisely their hidden VP cards.

### What it must not do

- Claim to know the opponent's hidden cards — show a **range**, always.
- Predict dice.
- Offer personalized (type C) claims — we don't have the data.
- Recommend everything at once. **One primary action, one alternative, one trigger.** The existing
  Turn Coach already shows a single step; that discipline should be kept.

### Build order

**Stage 1 — Live state foundation** *(prerequisite; no UI)*
Wire the five fields into `processStateObject()`: `victoryPointsState` (**cumulative merge, per
player — see §2.3**), `mechanicLargestArmyState`, `mechanicLongestRoadState`, `mechanicRobberState`,
`bankTradeRatiosState`. Lift parsing from `reviewAnalyze` (`sidepanel.js:2165–2168`).
*Acceptance (already demonstrated offline, must hold in the wired implementation): replay all 165
raw captures; my live VP equals final truth in 165/165, and the opponent's equals
truth-minus-their-hidden-VP-cards in 165/165.*

**Stage 2 — The Win-Path panel** *(the MVP)*
VP line with hidden-card range · distance to 15 · bottleneck resource · primary action · alternative
· trigger. Replace the Turn Coach's fixed ladder with a VP-aware ordering.

**Stage 3 — Deterministic trade helper** *(highest value per line of code)*
Using `bankTradeRatiosState`: "trade 3 wood → 1 ore, completes the city this turn." Pure arithmetic,
zero inference.

**Stage 4 — Award race tracker**
Knight counts from the log; LA/LR holder from the mechanic fields; warn when an award is one play
from changing hands (a 4-VP swing).

**Stage 5 — Post-game milestone review**
Add first-city turn, first-dev turn and award timings to the existing review, each against the
corpus median. Reuses `tools/timeline.py` logic.

**Explicitly deferred:** opponent hand-composition inference beyond counts, longest-road graph
search, denial/blocking recommendations, multi-turn lookahead, any personalized (type C) coaching,
and anything requiring `resourceStats`/`activityStats` **(impossible live — end-game only)**.

---

## Final recommendation

**Build first:** Stage 1 + Stage 2 — the live-state foundation and the Win-Path panel. It addresses
the clearest defect (score-blind advice), rests on exact game mechanics rather than a small sample,
and is verifiable against 165 captures before it ever runs in a live game.

**What the current sample supports:** retiring win rate as the research target in favour of
**city timing** — which separates engine classes cleanly (91% vs 56% ever building a city), appears
~50 rolls earlier than the outcome, and survives MMR stratification. Also: a calibrated opponent
hidden-VP estimator, and the descriptive shape of a won game (9.9 building VP + 5.1 card/award VP,
awards held by ~73% of winners each, ≥2 cities in 100%).

**What needs more games:** anything touching scorer weights, the engine gate's thresholds, the board
lean, seat-specific strategy, or the opening-regret paradox. The MISSING bucket's **88% second-seat
confound** means even the one apparently gate-relevant result cannot be acted on. Target ≈150
*decided* games before revisiting — currently 86.

**What cannot be supported reliably at any sample size here:** causal claims from observational,
non-randomized play; counterfactual opening quality (what the *recommended* pick would have done);
who initiated each concession; any live use of blocked income; and personalized mid-game coaching,
which needs decision-level logging that does not exist yet.
