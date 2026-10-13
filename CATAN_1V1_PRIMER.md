# Catan 1v1 (15-VP) — Primer for Reasoning About the Placement Advisor

**Version 2 — 2026-09-16.** Supersedes the v1 primer, which described the retired v1.40 archetype
scorer and repeated several claims since shown to be data artifacts. Where v1 was wrong, this
document says so explicitly rather than quietly editing it.

**Audience:** a model or person who needs to understand *why* the Catan Companion extension scores
openings the way it does — before critiquing or tuning anything.

---

## 0. TL;DR — the two ideas that drive everything

1. **You cannot reach 15 VP on buildings alone.** Even maxing every piece you own caps at **13 VP**.
   So every game is *structurally forced* through dev cards and/or the two awards. That is why
   ore/wheat/sheep (cities + dev cards) are weighted above wood/brick.
2. **Placement is necessary but not sufficient, and the data is weak.** Across 138 replayed games,
   **53% ended in a concession** — they never reached the victory threshold at all. The advisor is a
   *principled heuristic*, not a fitted model. Treat every weight as a considered prior, not an
   empirical result.

---

## 1. The exact mode (it is NOT base Catan)

| Setting | This mode | Base Catan |
|---|---|---|
| Players | **2 (1v1)** | 3–4 |
| Victory points to win | **15** | 10 |
| Discard limit on a 7 | discard when holding **> 9** (10+) | 8 |
| Player-to-player trading | **None** — bank 4:1 and port 3:1 / 2:1 only | Yes |
| Board | Standard 19-hex board | Same |

Most Catan strategy written online assumes 4-player, 10-VP, *with* trading. Much of it does not
transfer. The extension reads `victoryPointsToWin` and `cardDiscardLimit` from `gameSettings` at
runtime, so it adapts if the mode changes.

---

## 2. Rules that matter for placement

### 2.1 Board & production
- 19 hexes: **wood, brick, sheep, wheat, ore**, or **desert** (produces nothing). Each producing hex
  carries a dice number 2–12 (never 7).
- Settlements/cities sit on **corners**; a corner touches up to 3 hexes.
- On a roll, each settlement on a touching hex yields **1** card; a **city yields 2**.
- **Distance rule:** buildings must be **≥2 edges apart**.

### 2.2 Pips (dice odds)
| Number | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **pips** | 1 | 2 | 3 | 4 | **5** | — | **5** | 4 | 3 | 2 | 1 |

A corner's total pips ≈ expected cards per roll (×1/36). **Raw production leads every score; weights
are only a tilt on top of it.** colonist uses a balanced 36-card dice deck rather than pure RNG, but
the pip *ordering* is unchanged.

### 2.3 Build recipes — the crux of the weights
| Build | Cost | Gives |
|---|---|---|
| Road | 1 wood + 1 brick | network; 5+ connected → **Longest Road +2 VP** |
| Settlement | 1 wood + 1 brick + 1 sheep + 1 wheat | **+1 VP**, new production corner |
| **City** (upgrades a settlement) | **2 wheat + 3 ore** | **+2 VP**, **doubles** that corner |
| **Dev card** | **1 sheep + 1 wheat + 1 ore** | Knight / VP card / special |

**Dev deck (25):** 14 Knight, 5 VP, 2 Road Building, 2 Year of Plenty, 2 Monopoly.
Playing **3+ Knights** claims **Largest Army +2 VP**. **VP cards are +1 each, hidden until you win.**

### 2.4 Piece limits — and the 13-VP ceiling
**5 settlements, 4 cities, 15 roads.** Upgrading returns the settlement piece to your supply, so the
theoretical maximum from buildings is:

```
  5 settlements × 1 VP  =  5
  4 cities      × 2 VP  =  8
  ──────────────────────────
  MAX BUILDING VP       = 13      ← still 2 short of 15
```

**This is the single most important structural fact in this mode.** Even a perfect building game
cannot win. You *must* take at least 2 VP from **VP dev cards (+1 each)**, **Longest Road (+2)**, or
**Largest Army (+2)**. In 10-VP Catan you can win on buildings; here you cannot.

### 2.5 Setup — what the advisor is for
Snake draft. In 1v1 the order is **P1, P2, P2, P1**:
- **P1** places settlement **#1** and later **#4** (first and last).
- **P2** places **#2 and #3 back-to-back** (the two middle picks).

Each settlement is placed with a road. **Only your SECOND setup settlement grants starting cards**
(one card per adjacent producing hex). For P1 that is pick #4; for P2 it is pick #3. This makes the
*order* within your pair a real decision, not a formality.

### 2.6 The robber
On a 7 (or a Knight), anyone over the discard limit discards half (rounded down); the active player
moves the robber onto a hex, blocking it, and steals 1 random card from an opponent on it.

---

## 3. Why 15-VP 1v1 forces a city + dev engine

From §2.4: buildings cap at 13. The remaining VP must come from dev cards or awards — all of which
run on **ore, wheat, sheep**:

```
  a common winning shape:
    3-4 cities        6-8 VP    (ore + wheat)
    2-4 settlements   2-4 VP    (wood + brick + sheep + wheat)
    Largest Army      2 VP      (dev = sheep + wheat + ore)
    VP dev cards      1-3 VP    (dev = sheep + wheat + ore)
    Longest Road      2 VP      (wood + brick)
```

**What actual winners looked like** — re-verified 2026-09-16 by replaying **138 raw captures**;
**65 decided** games (concessions excluded, see §8 for why that filter is mandatory):

| Among winners who genuinely reached 15 VP | share |
|---|---|
| held **≥1 VP dev card** | **98%** |
| ended with **3–4 cities** | **88%** |
| held **at least one award** (road or army) | **95%** |
| held **Longest Road** | **74%** |
| held **Largest Army** | **69%** |

And how the 15 points split on average:

```
  from buildings (settlements + cities)  9.8 VP
  from dev cards + awards                5.2 VP
  ───────────────────────────────────────────
                                        15.0 VP
```

That is the 13-VP ceiling showing up in practice. **98% of real winners held a VP card and 95% held
an award** — a third of the winning total comes from outside the building track. It is not a
preference, it is forced.

---

## 4. Resource hierarchy — the reasoning

### WHEAT — the keystone
In **everything that scores**: settlements, cities (2 each), dev cards. No VP path avoids it. A
wheat-starved opening stalls outright.
⚠ **Wheat has almost no variance in outcome data** because good players always take it. You will
find near-zero correlation between wheat and winning — that is *table stakes*, not evidence wheat is
cheap. Never down-weight wheat from a correlation.

### ORE — the win engine, but only with wheat
Cities (3 each) and dev cards. In a 15-VP game those *are* the win. But **ore alone builds nothing** —
both recipes need wheat. An ore-heavy, wheat-light opening is a trap, which is why the advisor gates
on the *pair* having both rather than rewarding ore in isolation.

### SHEEP — dev fuel, historically under-valued
Settlements and, critically, **dev cards**. The dev → Largest Army → VP-card path is a large,
controllable chunk of 15 points (**98%** of real winners held VP cards). Sheep *feels* cheap and is
traditionally weighted low; here it sits at parity with wood/brick.

### WOOD + BRICK — expansion and roads; they saturate
Roads and settlements: you need them early to expand and to contest Longest Road (+2, held by **74%**
of real winners — not a fringe plan). They are consumed **together**, so they must always carry the
**same weight**. But they *saturate*: once your network is built the marginal value drops, whereas
ore/wheat keep buying cities and dev cards all game.

**Typical ordering:** `wheat ≈ ore > sheep ≈ wood = brick` — board-dependent, see §5.

---

## 5. Reading the board — a CONTINUOUS lean, not three buckets

⚠ **Changed since primer v1.** The old three hard archetypes (OWS / ROAD / BALANCED at fixed 0.57 /
0.63 thresholds) are **retired**. They produced discontinuities: two nearly identical boards on
opposite sides of a threshold got materially different weights.

Now a single continuous **board lean** in `[-1, +1]`:

```
  ows_pips  = sheep + wheat + ore        (pip-weighted, whole board)
  road_pips = wood + brick
  share     = ows_pips / (ows_pips + road_pips)

  lean = clamp( (share - 0.6111) / 0.0698 , -1, +1 )
                       │            │
                       │            └─ 1.5σ, measured on 111 real boards (σ = 0.0465)
                       └─ 11/18: OWS holds 11 of the 18 producing hexes, so a
                          perfectly even board sits at 0.611, NOT 0.5

  -1 = strongly road-favouring   0 = balanced   +1 = strongly OWS-favouring
```

Weights are then **interpolated** between three endpoint vectors:

```
              wood  brick sheep wheat  ore
  ROAD (-1)   1.15  1.15  1.00  1.12  1.03     ← expansion / longest road
  BALANCED(0) 1.00  1.00  1.00  1.15  1.10     ← the base prior
  OWS   (+1)  0.95  0.95  1.06  1.20  1.20     ← city / dev engine

  lean = +0.5 → halfway between BALANCED and OWS, etc.
```

**Invariants enforced in code:** `wood === brick` at every lean; wheat never drops below 1.12; ore
never below 1.03 (ore must never become worthless, even on a road board).

> **A second "pair-opportunity lean" exists but is DISABLED** (weight 0.00, diagnostic only). Its
> `topKMean / mean` formulation measures *tail concentration*, not absolute opportunity — a family
> that is weak overall but concentrated scores high, so it could argue OWS on a road-rich board. It
> correlated **−0.22** with the supply lean and disagreed in sign on 56/111 boards. Do not re-enable
> it without fixing the semantics.

---

## 6. Opening theory specific to 1v1

- **Secure a city base.** Your two settlements *together* must give real wheat **and** ore pips, or
  the engine never runs. Enforced as a **gate**, not a bonus (§7).
- **Diversify.** With **no player trading**, a missing resource means 4:1 bank trades. Coverage is
  valued on a threshold curve — a 2-pip source is not equivalent to a 6-pip one.
- **Starting-card tempo.** Only the **second** settlement grants cards. Ordering your pair so those
  cards complete a road or a dev card is a free tempo gain — and it means the same unordered pair has
  two different values depending on which you place first.
- **Ports are valued by surplus, not presence.** A 2:1 port is only worth something if you actually
  produce a surplus of that resource relative to what your build plan consumes.
- **Don't over-concentrate.** If one hex carries most of your wheat or ore, a single robber placement
  can switch off your engine. Small penalty, not a veto — concentration is often still correct.
- **Position.**
  - **P1** gets the best single spot and a real tempo lead, but picks #4 on the most constrained
    board. First-player advantage is structural and partly irreducible (§8).
  - **P2** picks **#2 and #3 back-to-back** — the one structural edge of going second. The advisor
    optimises that **pair jointly** (both orders), not two greedy single picks.
- **Roads open expansion.** A setup road should aim at a corner you'd have to *build* later — never
  at a spot you are about to settle for free.
- **Raw pips still dominate.** Weights and bonuses are tie-breakers. A clearly bigger production spot
  beats a marginally "better-shaped" one.

---

## 7. How the scorer actually works (v1.50 architecture)

⚠ **Changed since primer v1.** The old design pushed every consideration into per-resource weights
and additive bonuses, which stacked unpredictably. The current split:

> **Resource weights price PRODUCTION only. Everything else is priced at the PAIR level.**

```
  FINAL = RAW_WEIGHTED_PRODUCTION  +  clamp( 0.60 × Σ(soft terms), -2.00, +2.50 )

  RAW = Σ over both settlements of  pip(number) × weight(resource)      ← ~20-26, dominates

  soft terms (each individually capped, all small):
    coverage              threshold curve per resource (replaces binary "new resource" bonuses)
    recipe balance        can this pair actually COMPLETE city / dev / road / settlement recipes?
    roll coverage         how many DISTINCT strong numbers activate it  ({6,8,9} > {6,6,9})
    recipe co-production  do complementary resources arrive on the SAME roll?
    port value            surplus vs the build mix — not mere presence
    starting-card tempo   what the 2nd settlement's free cards let you build immediately
    robber concentration  (negative) how much production dies to one robber placement
```

**The engine check is a GATE, not a penalty.** Additive penalties could always be out-voted by a
productive-but-broken opening. Pairs are classified and filtered *before* ranking:

```
  STRONG   wheat ≥3 and ore ≥3
  WEAK     (wheat ≥2 and ore ≥2)  or  thin + a genuinely usable port bridge
  FRAGILE  has both, but barely
  MISSING  lacks wheat or ore ENTIRELY          ← strategically fatal, kept separate on purpose

  Take the best class reachable without sacrificing too much production.
  Allowances SCALE with the board (≈11% / 6% / 3% of best raw production, clamped),
  because a fixed allowance let four boards select openings with literally zero ore or zero wheat.
```

Board-level lean and per-pair scoring are deliberately separated: the board decides *which game to
play*, the pair functions decide *whether this specific pair can play it*.

---

## 8. What the data does and does NOT support ← read before citing any number

This section exists because primer v1 repeated claims that later proved to be artifacts.

**Corrections to primer v1:**
- ❌ *"cities +0.37, largest army +0.34 (59% of wins vs 25% of losses), dev +0.30, longest road
  +0.26"* — these came from the **unfiltered** corpus. **39% of games were concessions**, which
  inflates such correlations.
- ❌ *"<2 cities → 14% win rate"* — **a concession artifact**. Every *decided* game had ≥2 cities;
  the low-city games were mostly early quits.
- ❌ *"win rate declined 56% → 40%"* — **not statistically significant** (trend p=0.10; p=0.24 after
  controlling for seat). It was largely a seat-mix artifact: first-pick share fell 68% → 32% across
  the period.

**The concession problem.** colonist reports a winner whenever a game ends — including a quit. True
final VP is now recovered from the end-game payload, so:

```
  decided  = winner's true VP >= 15      <- reached the victory-point threshold
  conceded = anything else               <- EXCLUDE from every outcome claim
```

Re-verified across **138 replayed raw captures** (2026-09-16):

| corpus | games | conceded |
|---|---|---|
| v1.50-era (Aug 2026) | 84 | **62%** |
| v1.40-era (Jul 2026) | 54 | **39%** |
| **combined** | **138** | **53%** |

**More than half of all recorded games never reached the victory condition.** Unfiltered win rate is
**49%**; on decided games only it is **57%**. One game had the player on 9 VP against the opponent's
8 and recorded as the *loser* — they quit while ahead.

> The concession rate itself is a live behavioural metric, not just noise to discard. It rose from
> 39% to 62% between the two periods. Analyse concessions as their own population (when, from what
> position, ahead or behind) — never fold them into win/loss.

**What survives scrutiny:**
- ✅ **The seat split.** On **decided games only**: **66% as P1** (21/32) vs **48% as P2** (16/33) —
  an 18-point gap, the same direction and rough size as the ~56/44 structural baseline published for
  this ruleset. It is a property of the game, not a flaw in the player. (An earlier unfiltered
  estimate gave 60.8% vs 38.3%, Fisher p=0.023.)
- ✅ **The 15-VP win composition** in §3 (98% VP cards, 88% 3–4 cities, 95% at least one award) —
  computed on 65 decided games only, re-verified on 138 replays.
- ✅ **The 13-VP building ceiling** — arithmetic, not statistics.

**What the data cannot do.** The learning pipeline's design matrix is exactly singular
(`n_res = Σ covers_*`), and the production target is ~93% correlated with game length. Detecting a
+3pp win-rate change needs **~2,200+ games**. At the few hundred games available, weight tuning is
**unfalsifiable** — an
honest A/B showed a data-derived reweight performed *worse* out-of-sample than the hand-set priors.
**Do not present tuned weights as empirically validated.**

---

## 9. Traps to check for when reviewing

- **Wheat's zero correlation** → no-variance artifact, not low value (§4).
- **"Ore openings underperform"** → measured against a *production* target, which is structurally
  blind to ore's payoff (cities). Ore is strong **with wheat**.
- **Chasing pips / 6-8 count alone** → a fat board that never converts to cities, dev and awards
  loses to a smaller, converted engine.
- **Any win/loss claim on unfiltered games** → **53%** of recorded games are concessions. Filter `decided === true`.
- **Comparing openings graded by different scorer versions** → v1.40 and v1.50 rank 51% of picks
  differently. Records are version-pinned (`capturedScorer`) and corpora physically separated.
- **Trend claims without controlling for seat** → the seat effect is large enough to manufacture
  fake trends on its own.

---

## 10. Reading rules for any analysis

1. **Filter to `decided === true`** before any outcome claim.
2. **Version-pin.** Never mix grades from different scorer versions in one series.
3. **Control for seat.** It is the only robustly established effect.
4. **Control for opponent.** Both players' MMR (before/after/delta) is now recorded — use it.
5. **Prefer stated ground truth** over reconstructed values where both exist (the end-game payload
   gives exact per-category VP including hidden dev VP).
6. **Respect the power limit.** A few hundred games cannot resolve a few points of win rate;
   detecting +3pp needs thousands. Say so, and prefer intermediate metrics (§13).

---

# PART II — HOW GAMES ARE RECORDED

*Part I is the game and the scoring logic. Part II is the data layer: how a game gets captured,
what ends up in a saved file, and which figures in Part I that evidence rests on.*

---

## 11. The recording pipeline

```
  colonist WebSocket (MessagePack)
        │
        ▼  interceptor.js      hooks window.WebSocket at document_start, decodes frames
        │                      (wrapped so a failure can never break the game's socket)
        ▼  content_bridge.js   relays to the extension
        ▼  background.js       durable buffer (survives the side panel being closed)
        │
        ├──────────────▶  raw/game-<id>.json     IMMUTABLE — every message, written once
        │
        ▼  reviewAnalyze()     PURE REPLAY: messages → game model. No live state.
        ▼  buildGameRecord()   → game-<id>.json  DERIVED — regenerable at any time
```

**The key property: replay is pure.** `reviewAnalyze` holds no live state — feed it the same
messages and you get the same model. That is what makes every derived field re-computable, and it is
why a bug found months later can still be fixed retroactively for old games.

### What gets reconstructed, and from where

| Field | Source |
|---|---|
| identity, seat | `payload.playerColor`, `payload.playOrder` → `amFirst` |
| rules | `gameSettings.victoryPointsToWin` (15), `cardDiscardLimit` (9) |
| board | `mapState.tileHexStates` / `tileCornerStates` / `portEdgeStates` |
| placements | `tileCornerStates[id] = {owner, buildingType}` — 1 settlement, 2 city |
| setup order | corners gaining an owner **before the first roll**, in sequence |
| rolls | `gameLogState` type **10** (`firstDice`+`secondDice`) — always complete |
| income | type **47** (`cardsToBroadcast`), `distributionType` 0 = setup / 1 = roll |
| events | **4/5** build · **116** trade · **14/15** steal · **20** dev played · **21** YoP · **86** monopoly |
| **end-game truth** | message **`data.type === 45`** — see §12 |

> ⚠ **A city upgrade arrives as a diff carrying only `buildingType: 2`**, with `owner` omitted
> (already known). Code that bails on a missing owner silently drops every city. That bug cost this
> project months of wrong conclusions about ore.

### Four independently-versioned layers

Capture, parsing, replay and record-shape can each change while the raw bytes stay identical. A
replay bug and a scoring bug are different problems, so every record pins all of them (§12).

---

## 12. What's in a saved game

Two files per game. The record is **derived**; the raw is the **source**.

```jsonc
{
  "gameId": "army2436", "savedAt": "2026-08-10T14:47:54Z",
  "startedAt": "2026-08-10T14:36:21Z", "endedAt": "2026-08-10T14:47:52Z",
  "sourceHash": "2239-2fc60e62",                  // identifies the exact raw capture; catches duplicates

  // ── data-quality verdict, computed once at write time ──
  "captureIntegrity": {
    "rawWritten": true, "rawMessageCount": 2239, "replayCompleted": true,
    "boardValid": true, "setupValid": true, "setupPlacements": 4,
    "firstRollSeen": true, "rollCount": 101, "endGameMessageSeen": true,
    "captureComplete": true,
    "researchEligible": true, "researchExclusionReason": null
  },

  // ── reproducibility: which code produced this interpretation ──
  "version": { "capture": "1.56", "protocolParser": "2", "replay": "1.60",
               "recordSchema": "3", "scorer": "v1.50",
               "scorerConfigHash": "ee784b36" },   // catches silently-edited constants

  // ── identity / rules ──
  "myColor": "1", "oppColor": "5", "playOrder": ["5","1"], "amFirst": false,
  "vpToWin": 15, "discardLimit": 9,

  // ── GROUND TRUTH from the type-45 end-game message ──
  "endGame": {
    "totalTurnCount": 62, "gameDurationInMS": 334093,
    "diceStats": [0,2,3,3,5,6,4,2,1,1,1],        // index 0 = roll 2 … 10 = roll 12
    "players": { "1": { "rank": 2, "vp": 11, "vpByCategory": {...}, "winner": false } },
    "resourceStats": {...},                       // rolling/robbing/dev/trade income AND loss
    "activityStats": {...}                        // trades, resourcesUsed, resourceIncomeBlocked,
  },                                              // devCardsBought, devCardsUsed
  "finalVP": { "1": 11, "5": 15 },
  "winnerVP": 15,                                 // the SERVER-designated winner's VP
  "leader": "5", "leaderVP": 15,                  // who actually led on VP — NOT always the winner
  "decided": true, "conceded": false,             // decided = leaderVP >= vpToWin
  "mmr": { "1": { "before": 2201, "after": 2185, "delta": -16 }, "5": {...} },
  "mmrComplete": true,                            // false = one player's MMR was null; exclude from
                                                  // opponent-strength-controlled analysis

  // ── the opening, stored once, explicitly ──
  "openingState": { "seat": "P2", "setupOrder": {...}, "resourcePips": {...},
                    "numbers": [...], "ports": [...], "rawProduction": 21.324,
                    "boardLean": 0.631, "engineClass": "MISSING", "startingCards": {...} },

  // ── derived play summary ──
  "turns": 61, "completedTurns": 61,              // turns FINISHED (`turns` is a legacy alias)
  "terminalTurnNumber": 62,                       // includes the turn the game ended on — always
                                                  // completedTurns + 1. Never mix them in an average.
  "rolls": 58, "rollCounts": {...}, "rollSequence": [8,6,5,9,...],  // ORDERED
  "luckMe": 104, "luckOpp": 97,
  "awards": { "lrMe": false, "laMe": true, ... }, "stoleFrom": 9, "robbedBy": 7,
  "me": { "setts": 4, "cities": 3, "realIncome": 82, "trades": 6, "devPlays": {...} },
  "opening": [ /* per pick: rank, regret, best, top-8 candidates */ ],
  "board":   { /* raw hexes / corners / ports — any feature recomputable offline */ }
}
```

### Capture integrity — why a valid file is not a complete game

**A raw file existing does not mean it contains the whole game.** A browser crash, extension
restart, socket drop or buffer-flush failure leaves a file that is perfectly valid JSON, replays
without error, and is silently *partial*. Such a game entering the research set is worse than a
missing one, because nothing downstream will ever notice.

So every game is audited against the landmarks a complete game must contain:

```
  GAME START → SETUP (4 placements, valid snake) → FIRST ROLL → … → TYPE-45 END GAME
```

Missing any landmark ⇒ `researchEligible: false` with a reason
(`missing_raw`, `replay_error`, `invalid_board`, `invalid_setup`, `missing_first_roll`,
`missing_end_game`). Analysis filters on that flag instead of rediscovering data-quality
problems every time.

**Verified to actually catch failures** (not just pass clean data) by replaying deliberately
damaged captures:

| capture | verdict |
|---|---|
| full game (control) | ✅ eligible |
| empty | ❌ `missing_raw` |
| truncated to 3 messages | ❌ `invalid_setup` |
| truncated mid-setup (15%) | ❌ `missing_end_game` |
| truncated mid-game (50%) | ❌ `missing_end_game` |
| **truncated just before the end-game message** | ❌ `missing_end_game` |

That last row is the one that matters: it has a complete setup and 101 rolls, looks entirely
normal, and is still correctly rejected.

### The `type === 45` end-game message — the single most valuable field

It arrives **once per game** and carries **no `gameState`/`diff`**, so the replay loop originally
skipped straight past it and threw it away. It is the only source of ground truth for how a game
actually ended.

**`victoryPoints` is CATEGORY → COUNT, not points.** Decoding it wrongly (a naive sum) flags 100% of
games as concessions. The weights, verified on 138 replays:

```
  0 = settlement    ×1        3 = LARGEST ARMY  ×2
  1 = city          ×2        4 = LONGEST ROAD  ×2
  2 = VP dev card   ×1
```

> **Corrected in v1.61 — categories 3 and 4 were documented backwards.** Because both awards are
> worth 2 VP, every VP *total* and every arithmetic check was unaffected, so the error was invisible
> for months. It was caught by cross-checking the categories against the award mechanic states over
> the full corpus: `hasLargestArmy === category 3` in **330/330** player-slots and
> `hasLongestRoad === category 4` in **330/330**.
>
> **Anything that reads a category individually** (per-award win rates, the Win-Path engine) must
> use the corrected mapping. Anything that only sums them is unaffected — including every
> `decided`/`finalVP`/concession figure in this primer.

**Validation:** every decided winner finishes at **`vp >= vpToWin`**, and each category's maximum
matches the real piece/card limits (5 / 4 / 5 / 1 / 1). There is no reported total in the payload to
cross-check against — this *is* the validation.

> **Corrected in v1.60.** This used to read "65/65 decided winners land **exactly** on 15." That was
> an accident of the old corpus, not a rule. The fresh data contains a genuine **16-VP** winner:
> 3 settlements + 3 cities + 3 VP cards + longest road + largest army = 3+6+3+2+2 = 16. This is
> expected, not corruption — **hidden VP cards are all revealed at once on the winning turn**, so a
> player sitting on 13 visible points can jump straight past 15. Assert `>= vpToWin`, never `== 15`.

This one message yields: **true final VP including hidden dev-card VP**, **concession detection**,
**both players' MMR**, per-category resource income *and loss*, blocked income, and the dice
histogram.

### Two different "winners" — never conflate them

On a concession the server still designates a winner, and **that winner is not always the player
ahead on points.** If the player who is *winning* rage-quits, their opponent is recorded as the
winner while holding fewer VP. Observed in **3 of the 66** fresh games (e.g. final 8–7 with the
7-VP player recorded as winner).

| field | meaning | use it for |
|---|---|---|
| `winner` / `winnerVP` | whom the **server** declared | match outcome, W/L record, MMR |
| `leader` / `leaderVP` | who actually held most VP (`max(finalVP)`) | board position, "was I ahead?" |

`decided` is derived from **`leaderVP >= vpToWin`** — *"did anyone reach the target"* — not from
`winnerVP`. Both rules classify all 66 fresh games identically; the leader rule simply cannot be
fooled by a server-designated winner who is behind.

**Why this matters for the concession population:** in **21 of 35** conceded games (60%) *you were
ahead on VP when the game ended*. Analysed via `winnerVP` that signal is invisible; via `leaderVP`
it is directly measurable. Concessions are their own behavioural population — never fold them into
outcome analysis, but don't discard them either.

---

## 13. The dataset — three generations, and one permanent rule

```
  Downloads/Catan saved games/
  ├── Games after v.156/            ← CURRENT. Full end-game truth + version block.
  │     ├── game-<id>.json               derived record
  │     └── raw/game-<id>.json           immutable capture
  ├── Games before v1.56/           ← v1.40-era: 111 records + 54 raw
  │     └── v150/                   ← v1.50-era: 84 records + 84 raw
```

Generations are kept physically apart because each was graded by a **different scorer**, and only the
current one records end-game ground truth. Pooling them invalidates any outcome comparison.

### 🚨 Never delete `raw/`

```
  RAW CAPTURES  →  IMMUTABLE  →  NEVER DELETE
  Every derived artifact is regenerable. Raw is not.
```

Records, grades and scores are **derived** — if replay or scoring has a bug, re-run it over raw and
regenerate them. This is not hypothetical: replaying the 138 preserved captures through the current
code recovered the end-game payload, true VP, concession flags and both players' MMR for **every
game retroactively**, none of which the original records contained. That only worked because raw
survived. A clean-slate reset that deletes raw destroys those games permanently, including for every
future fix.

### Reproducibility metadata

Every new record carries the versions of all four layers that can change independently, plus a hash
of the scorer constants (which catches the nasty case of an unchanged version number with silently
edited weights):

```json
"version": { "capture": "1.56", "protocolParser": "2", "replay": "1.60",
             "recordSchema": "3", "scorer": "v1.50", "scorerConfigHash": "ee784b36" }
```

**`scorer: "v1.50"` is the scoring-model family, not the build number.** The extension is at 1.60;
the placement model it ships is still v1.50. These are deliberately independent — recording can
improve without touching the scorer, which is exactly what every change since 1.56 has done. All 66
fresh games carry `v1.50` / `ee784b36` **identically**, so the collection run is uncontaminated.

**Schema 3 is purely additive over schema 2** — every older field kept its name and meaning, so the
generations mix safely. `ml/features.py::upgrade_record()` derives the three new fields for
schema-2 records in memory, so no saved file is ever rewritten.

### First-class `openingState`

The opening is stored once, explicitly, so analysis never re-derives it — and critically it makes
**setup order unambiguous**, since only the second settlement grants starting cards:

```json
"openingState": {
  "seat": "P2",
  "setupOrder": {
    "firstSettlement":  { "pickNo": 2, "cornerId": "2",  "grantsStartingCards": false },
    "secondSettlement": { "pickNo": 3, "cornerId": "15", "grantsStartingCards": true  }
  },
  "resourcePips": { "wood": 4, "brick": 9, "sheep": 5, "wheat": 3, "ore": 0 },
  "numbers": [3, 6, 8, 9, 10], "ports": [],
  "rawProduction": 21.324, "boardLean": 0.631, "engineClass": "MISSING",
  "startingCards": { "wood": 1, "brick": 1, "sheep": 0, "wheat": 1, "ore": 0 }
}
```

Verified on all 138 replays: P1's second settlement is **always pick #4**, P2's is **always pick #3**,
and `seat` always agrees with `amFirst`.

---

## 14. Verification status (2026-09-21)

Everything empirical in this primer was re-derived by replay. Structural facts (the 13-VP ceiling,
recipes, piece limits) are arithmetic and need no data.

### The 66-game fresh corpus (`Games after v.156`, first real collection run)

Every record was cross-checked against its own preserved raw capture:

| Check | Result |
|---|---|
| derived records ↔ raw captures | **66 / 66** matched by game id and message count |
| `sourceHash` unique (duplicate detection) | **66 / 66** |
| `captureComplete` · `replayCompleted` · `researchEligible` | **66 / 66** |
| `endGameMessageSeen` · `firstRollSeen` · `boardValid` · `setupValid` | **66 / 66** |
| VP category arithmetic self-consistent | **66 / 66** |
| starting cards match the **second** settlement | **66 / 66** |
| `scorer` + `scorerConfigHash` identical across the run | **66 / 66** (`v1.50` / `ee784b36`) |
| `terminalTurnNumber − completedTurns` | **always exactly 1** |
| dice captured | **4,106 rolls**, no distributional anomaly |

**Re-replay after the v1.60 change** (`tools/replay_check.js`): all 66 captures reproduce every
pre-existing field byte-identically, including `decided`, `winnerVP`, `turns` and `sourceHash`.
The new `leaderVP` rule classifies all 66 **exactly as the old `winnerVP` rule did** — the change
is a robustness improvement, not a reclassification.

### What the fresh corpus is not yet able to answer

| | |
|---|---|
| total games | 66 |
| **decided** (someone reached 15) | **31** |
| conceded | 35 — of which **21 (60%) ended with you ahead on VP** |
| decided **and** MMR-complete | **29** |

**31 genuine outcomes is far too few to move any weight**, and the seat split (P1 9/18 = 50%, P2
10/13 = 77%) is confounded by you usually being the higher-rated player. Detecting a +3pp win-rate
change needs thousands of games. The near-term research loop must therefore be **intermediate
metrics** — first-city turn, first dev card, resource realization, blocked income — which converge
in tens of games, not win rate, which converges in thousands.

The engine-gate distribution so far (**STRONG 55 · WEAK 4 · FRAGILE 2 · MISSING 5**) is worth
watching but carries **1 decided game and 0 wins in the MISSING bucket** — monitor it, don't tune it.

---

## 15. What changed in recording, and why

Every item below is **recording only** — none of it altered the placement scorer or any weight.

| v | Change | Why it mattered |
|---|---|---|
| **1.53** | Split the corpus by scorer generation into separate folders | Openings graded by different scorers aren't comparable (51% of picks rank differently). Pooling silently blends versions into one series. |
| **1.55** | "Clear saved games" control | Games live in **two** stores — the Downloads folder and a `chrome.storage` index. Deleting only the files left the index believing they were saved, so they'd **never be re-written**: a silent desync. |
| **1.56** | **Captured the `type === 45` end-game message** | It has no `gameState`/`diff`, so the replay loop skipped it entirely. It is the only ground truth for how a game ended. |
| **1.56** | Decoded `victoryPoints` as **category → count** | A naive sum undercounts (a city counts 1 there but is worth 2 VP) and flags **100%** of games as concessions. |
| **1.56** | `decided` / `conceded` flags | colonist reports a "winner" for any termination, including a quit. **53% of games are concessions.** |
| **1.56** | Both players' MMR (before/after/delta) | Lets analysis control for opponent strength. Use **before** — post-game MMR already encodes the result. |
| **1.57** | Full `version` block + `scorerConfigHash` | Four layers change independently; the hash catches an unchanged version number with silently edited constants. |
| **1.57** | First-class `openingState` | Analysis stops re-deriving the opening, and **setup order becomes explicit** rather than inferred. |
| **1.57** | Fixed the clear-games guidance | The v1.55 note said to delete the corpus folder — **which contained `raw/`**. That instruction is what caused the data loss. |
| **1.58** | Repointed to `Games after v.156/`; three-generation corpus API | Validated by replaying all 138 preserved captures. |
| **1.59** | **`captureIntegrity` + `researchEligible`** | A partial capture is valid JSON and replays fine. This is the only thing that separates it from a complete game. |
| **1.59** | `sourceHash` of the raw capture | Identifies the exact source behind a record and catches the same game stored twice. |
| **1.59** | `startedAt` / `endedAt`, ordered `rollSequence` | Enables timing questions (first-city turn, early droughts, robber timing, session effects) without re-replaying raw. |
| **1.59** | Per-settlement detail in `openingState` | Each placement stores its hexes, port, and the advisor's rank/regret **at that moment** — so research asks "good given what was known then?", not in hindsight. |
| **1.60** | `completedTurns` + `terminalTurnNumber` | `turns` and `endGame.totalTurnCount` differ by exactly 1 in **66/66** games — turns *finished* vs the turn the game *ended on*. Both are right; unnamed, they'd silently corrupt any "average game length". |
| **1.60** | `leader` / `leaderVP`, and `decided` derived from them | The server names a winner even when that player is **behind** on VP (3/66 games). "Did anyone reach the target" is the robust question. |
| **1.60** | `mmrComplete` flag | 2/66 games have one player's MMR null (guest/unranked). Kept **null, never imputed**; the flag lets strength-controlled analysis self-filter. |
| **1.60** | `upgrade_record()` in `ml/features.py` | All three new fields are derivable from schema-2 records, so the 66 existing games are upgraded **on read** — old and new stay comparable with **zero files rewritten**. |
| **1.60** | `tools/replay_check.js` | Replays every preserved raw capture through the current code and diffs it against the stored record. The regression test for any future change to `reviewAnalyze` / `buildGameRecord`. |
| **1.61** | **VP categories 3/4 corrected** (3 = Largest Army, 4 = Longest Road) | Both awards are worth 2 VP, so totals were always right and the error was invisible. Caught by cross-checking against the award mechanic states: 330/330 both ways. Only per-award readings change. |
| **1.61** | **Award mechanic states MERGED, not replaced, in `reviewAnalyze`** | They arrive as partial diffs and only ~7% of longest-road frames carry `hasLongestRoad`, so the last frame usually lacked it — **`awards.lrMe` was wrong in 46/165 records**. Now 0/165. Any past analysis using that field is suspect. |
| **1.61** | **Win-Path live state** — `victoryPointsState`, award holders, road chain length, robber tile, port ratios, per-colour knights | Five fields that were already in the stream and parsed only offline. All arrive as partial diffs: merged cumulatively, my live VP matches end-game truth **165/165** (naive last-value tracking reads a 15-VP player as 3). |

### The two bugs worth remembering

**1. The city-upgrade diff.** A settlement→city upgrade arrives carrying only `buildingType: 2`,
with `owner` omitted. The replay bailed on the missing owner and dropped **every city in every
game** — which then produced a confident, entirely wrong conclusion that ore openings underperform.

> **It bit twice.** Fixed in `reviewAnalyze` (the offline path) in v1.4x, but the **live**
> `processStateObject` kept the same faulty guard until **v1.62** — live city count read 0 in
> **52/60** replayed games, so the Turn Coach coached "toward your first city" all game and offered
> to upgrade corners that were already cities. **Any handler for `tileCornerStates` must resolve
> `owner` and `buildingType` from the previous known state when the diff omits them.** There is now
> a permanent assertion in `tools/winpath_check.js` (live pieces == end-game counts, 342/342).

**2. Deleting raw.** A clean-slate reset removed `raw/` along with the records. Records are
derived and regenerable; raw is not. Recovering it was luck, not design — hence the permanent rule
in §13.

### Deliberately deferred

Not built, because **everything derivable from raw can be backfilled later** — and raw is now
preserved:

- **Canonical event timeline** — normalized `TURN_START / DICE_ROLL / BUILD_CITY / …` events. Build
  it against ~30 real games rather than guessing the schema.
- **Offline regeneration CLI** — replay raw → records outside the browser. Useful the first time a
  replay bug needs a mass re-run.
- **Expected-vs-realized production** — theoretical opening output vs what actually arrived, and how
  much the robber blocked. This is the **highest-value future addition** (see §14).

### Skipped on purpose

A separate canonical-model abstraction layer between replay and analysis. `reviewAnalyze` is already
a pure replay, which delivers the property that matters; another layer would be ceremony for a
single-user tool.

---

## 16. QA pass for the first ~10 fresh games

Automated checks cover structure; these catch *semantic* wrongness. The city-upgrade bug passed
every structural check for months while silently deleting every city from replay — which is exactly
why this list exists. Do it by hand for the first handful, then stop.

```
   1. raw capture written, and researchEligible === true
   2. replay finished without error
   3. type-45 end-game message present
   4. both players' final VP look right; winner's total == 15 when decided
   5. decided / conceded matches what actually happened
   6. seat + setup order correct (P1 → picks #1 & #4, P2 → #2 & #3)
   7. startingCards match the SECOND settlement's adjacent hexes
   8. cities appear (the historic failure mode — check this one hardest)
   9. resource income / loss totals are plausible
  10. openingState matches what the advisor actually showed you on screen
```

Item 10 is the one a script cannot check for you: it is the only guard against the record and the
live advisor silently diverging.

---

*The reasoning lives here; the exact live constants live in `V150` / `v150ScorePair` in
`sidepanel/sidepanel.js`, the validation evidence in `V151_VALIDATION_REPORT_FINAL.md`, and the
build history in `CONVERSATION.md`.*
