# Catan Companion

A Chrome extension (Manifest V3) that gives live strategy help for **1v1 [colonist.io](https://colonist.io) games in 15-VP / discard-at-10 mode** — and a research pipeline that measures whether the help is actually any good.

Most Catan helpers stop at "here are the pip counts." This one does two things that are harder:

- **It reads the board before it ranks corners**, because a board starved of ore wants a different opening than one drowning in it.
- **It records every game losslessly**, so claims about the advice can be tested against real outcomes rather than asserted.

The second part is why this repo contains as much analysis as code. Several confident conclusions in its history turned out to be wrong, and the only reason that's known is that the raw games were kept.

---

## Status

| | |
|---|---|
| Extension version | **1.62** |
| Placement scorer | `v1.50`, config hash `ee784b36` — **frozen** for the current collection run |
| Games recorded | 171, all passing integrity checks |
| Decided games (someone reached 15) | 90 — *not enough to tune weights on; see [Why the scorer is frozen](#why-the-scorer-is-frozen)* |

> The empirical tables below come from the **165-game audit snapshot** (86 decided), which is the
> last point where every figure was independently re-derived and cross-checked. Collection has
> continued since; the analysis is not re-run on every new game. Where a number is quoted, it is
> quoted against the snapshot it was measured on.

---

## How it works

### The data path

Colonist sends game state over a WebSocket as MessagePack. The extension hooks that socket in the page's MAIN world, decodes it, and fans it out two ways:

```
colonist.io WebSocket
        │
   interceptor.js          MAIN-world hook, MessagePack decode
        │
   content_bridge.js       relay into the extension
        │
   background.js           durable buffer — keeps capturing while the panel is closed
        │
        ├──► processStateObject()   LIVE · incremental · drives the UI
        │
        └──► reviewAnalyze()        OFFLINE · pure replay over the whole message array
                     │
                     └──► buildGameRecord()   the saved record
```

Two state paths exist on purpose. The live one is incremental and cheap; the offline one is a pure function over the full message array, used for post-game review and research. **Both have to be fixed when the protocol bites** — a bug once lived in one of them for months because only the other was tested.

Raw captures are written untouched and treated as immutable. Derived records can always be rebuilt from raw; raw cannot be rebuilt from anything.

### What the extension can and cannot see

This matters, because the advisor is built to never pretend otherwise.

| Observable live | Not observable |
|---|---|
| Your exact hand | **The opponent's hand composition** (count only — inferred, flagged uncertain) |
| Opponent's card **count** | **The opponent's dev-card types** (always face-down, 1,119 observations, 0 revealed) |
| Every settlement, city, road, owner | Their hidden VP cards — only an upper bound is knowable |
| Full event log: rolls, builds, trades, steals, dev plays | Anything about future dice |
| **VP by category, both players** | Income/blocked-income totals (end-of-game only) |
| Largest Army + Longest Road holders, and road chain length | Opponent MMR during play |
| Robber tile, your port trade ratios | |

Three of those live fields arrive as **partial diffs** and have to be merged cumulatively. Tracking "the last value seen" for victory points reads a player who is genuinely on 15 as **3**. Merged properly, your live VP matches end-game truth in **171/171** games.

---

## What it does during a game

### 1. Opening placement advisor

Runs during setup, then hands off. It ranks every legal corner (and, for the second pick, every legal *pair*) through a five-step model.

#### Step 1 — read the board

Count pips per resource across all 18 producing hexes, then compute how much of the board is ore/wheat/sheep:

```
owsShare   = (ore + wheat + sheep pips) / (all pips)
lean       = clamp( (owsShare − 0.6111) / 0.0698 , −1 , +1 )
```

`0.6111` is `11/18` — the theoretical neutral, since OWS occupies 11 of 18 producing hexes. The empirical mean across 111 boards was 0.6139, statistically indistinguishable from it, so the principled constant is used.

`lean = +1` is a hard OWS board (city/dev engine). `lean = −1` is a road board (expansion, Longest Road). Most boards land in between, and the lean is **continuous** — not three buckets.

#### Step 2 — pick the weights for that board

Three weight sets, interpolated by `|lean|`:

| Resource | Road board (−1) | Balanced (0) | OWS board (+1) |
|---|---:|---:|---:|
| Wood | 1.15 | 1.00 | 0.95 |
| Brick | 1.15 | 1.00 | 0.95 |
| Sheep | 1.00 | 1.00 | 1.06 |
| Wheat | 1.12 | **1.15** | **1.20** |
| Ore | 1.03 | 1.10 | **1.20** |

Wheat and ore carry a premium on every board — in a 15-VP game you cannot win on settlements alone (see [the 13-VP ceiling](#the-13-vp-ceiling)). On an OWS board that premium widens and wood/brick are discounted; on a road board it narrows and wood/brick lead.

**Wood and brick are always forced equal.** They're consumed together, one each, by both roads and settlements, so valuing them differently is incoherent.

#### Step 3 — raw production

```
rawProduction = Σ over adjacent hexes of ( pips(dice) × weight(resource) )
```

where pips are the standard dot counts — `6` and `8` are worth 5, `2` and `12` are worth 1, desert 0.

This is the dominant term, deliberately. Everything that follows is a tie-breaker.

#### Step 4 — the engine gate

Production alone will happily recommend a 12-pip opening with no ore. In a 15-VP game that's a trap, so pairs are classified by whether they can actually build cities and dev cards:

| Class | Condition |
|---|---|
| **STRONG** | wheat ≥ 3 pips **and** ore ≥ 3 pips |
| **WEAK** | wheat ≥ 2 and ore ≥ 2, *or* ≥1 of each plus a genuine port bridge |
| **FRAGILE** | ≥1 pip of each |
| **MISSING** | lacks wheat or ore entirely |

The gate then keeps the best class reachable **without giving up too much production**, with allowances that scale to the board's own level (11% of the best raw score for STRONG, clamped to 2.25–3.00; 6% for WEAK, 1.25–1.75; 3% for FRAGILE, 0.60–0.90). A fixed allowance was too tight against ~26-point raw scores and let four boards select openings with literally zero ore.

This gate is the piece with the strongest empirical support:

| Opening class | Games | Ever built a city | Median first-city roll | Median cities |
|---|---:|---:|---:|---:|
| STRONG | 131 | **91%** | **21** | 3.0 |
| WEAK | 15 | 93% | 35.5 | 2.0 |
| FRAGILE | 3 | 100% | 29 | 3.0 |
| **MISSING** | 16 | **56%** | **46** | **1.0** |

A MISSING opening reaches its first city 25 rolls later and fails to build one at all 44% of the time.

> ⚠️ With one caveat worth stating: **14 of those 16 MISSING openings were second-seat**, so the bucket is confounded with seat position. It's suggestive, not settled.

#### Step 5 — the soft adjustment

A small bundle of pair-level terms, summed, scaled by **0.60**, then clamped to **[−2.00, +2.50]**:

| Term | Cap | What it rewards |
|---|---:|---|
| `coverage` | 1.60 | Breadth across all five resources, weighted toward wheat/ore |
| `recipes` | — | Whether the pair actually builds things the board favours |
| `rollCoverage` | 0.60 | How many *distinct* numbers activate the opening |
| `recipeCoProduction` | 0.35 | Whether one roll delivers complementary resources together |
| `port` | 1.60 | 2:1 worth 1.35, 3:1 worth 1.00, with a real surplus to trade |
| `tempo` | 1.40 | Starting-card quality from the second settlement |
| `expansion` | −0.50…1.00 | Room to grow |
| `robber` | −1.00 | Penalty for concentration into one blockable hex |

```
score = rawProduction + clamp( 0.60 × Σ(soft terms) , −2.00 , +2.50 )
```

That `0.60` matters more than it looks. The component caps sum to 7.75 while the aggregate clamp is 2.50, so without scaling **56% of pairs pinned at the +2.50 ceiling** — the term became a constant and stopped discriminating among exactly the candidates it exists to separate. After scaling, 0.3% pin.

Two terms were measured and removed rather than kept for appearance: **opportunity lean** (it was a tail-concentration index, not an opportunity signal — it disagreed in sign with board supply on 56 of 111 boards) and **replaceability** (100% zero rate, changed zero top-1 picks).

### 2. Win-Path coach

Takes over after setup. Earlier versions ran a fixed ladder — city > settlement > dev > road — which was **score-blind**: identical advice at 3 VP and at 14 VP. It now reads both players' live scores:

```
OBJECTIVE    Close out the game — 2 VP to go
BOTTLENECK   2 ore short (you make 0.19/roll)
DO NEXT      Build a CITY on your 9-wheat / 6-ore
             +1 VP and doubles that hex.
ALTERNATIVE  Buy a DEV card
             Knights drive Largest Army — 1 more needed.
CHANGES IF   they take Largest Army — a 4-VP swing
```

Candidates are evaluated by the VP they *certainly* add now, so "does this win?" is a comparison rather than a special case. Tiers:

| Tier | Fires when |
|---|---|
| **win** | an affordable action closes the entire remaining gap |
| **win-maybe** | same, but via Longest Road, where topology could betray it |
| **defend** | opponent could already win, or is visibly within 2 VP |
| **closing** | ≤3 VP to go — prefers whatever adds VP soonest |
| **engine** | nobody close — **production gain decides**, not a fixed order |
| **fallback** | nothing affordable — trade, or hold deliberately |

Not a rigid ladder: a guaranteed win always outranks defence, and a speculative route never displaces a reliable one.

Rules it encodes that are easy to get wrong:

- **A city is a net +1 VP**, not +2 — it replaces a settlement.
- **A knight already in hand costs nothing to play.** If it completes Largest Army that's +2 VP for free, which is the most-missed winning move in the whole game.
- **Awards must be exceeded, not matched.** Equal knights doesn't take Largest Army.
- **Taking an award off the opponent is a 4-VP swing** (+2 you, −2 them).
- Longest Road is only suggested within 3 segments. Advising a road when the award is 9 away is noise.
- Bank trades honour live 2:1 / 3:1 port ratios and spend only genuinely spare cards.

#### It shows no scores, on purpose

Colonist already displays the scoreboard. Repeating it is noise. Your VP, the opponent's VP, their hidden-VP estimate and their unplayed-card count all drive the recommendation and **none of them are printed**. Verified: 0 score leaks across ~1,500 advisor calls on real games.

#### And it stays honest about uncertainty

- Your VP is **exact**. The opponent's is **visible only** — their hidden VP cards are the one thing the server doesn't reveal, confirmed in 171/171 games.
- Hidden VP is bounded, never assumed. A VP card is never played, so it's always still in hand — their unplayed dev-card count is a rule-guaranteed ceiling, with **0 violations in 171 games**:

  | Their unplayed dev cards | 0 | 1 | 2 | 3 | 4 |
  |---|---:|---:|---:|---:|---:|
  | Mean VP cards actually held | **0.00** | 0.68 | 1.43 | 2.23 | 2.86 |

  Zero unplayed cards is the one certainty: they provably hold no hidden VP (29/29 games).
- **No dice prediction.** "Affordable" means from cards in hand, right now.

### 3. Supporting panels

**Dice odds** — colonist does not roll fair dice. It draws from a 36-card deck with recent-roll damping and per-player 7-balancing. The model mirrors that: a deck of `{2:1, 3:2, … 7:6, … 12:1}`, reshuffled below 13 cards, with recently-seen numbers damped 34% each and 7-streaks damped 40%. That's why the panel shows live odds rather than static 6/36.

**Opponent hand inference** — exact card *count* comes from the server; composition is tracked through gains, spends, trades and steals, and reconciled against the count. When it has to guess, it's flagged uncertain rather than presented as fact.

**Also:** dev-deck tracking, robber placement advice weighted by opponent production and your own exposure, and a post-game review.

---

## Background: why the model looks like this

### The 13-VP ceiling

Piece limits are 5 settlements and 4 cities. Maximum VP from buildings is therefore `5×1 + 4×2 = 13`. **Every win in this mode requires at least 2 VP from dev cards or awards.** That's arithmetic, not strategy — and it's why wheat and ore carry a premium on every board.

The 86 decided games agree:

| Winner characteristic | Share |
|---|---:|
| Held ≥1 VP development card | 96.5% |
| Held ≥1 award | 98.8% |
| Longest Road | 74.4% |
| Largest Army | 72.1% |
| Ended with 3–4 cities | 86.0% |
| Ended with ≥2 cities | **100%** |

Average winner: **9.9 VP from buildings, 5.1 from cards and awards.**

### Why the scorer is frozen

90 decided games is not enough to tune weights on, and the honest tests say so:

- Weights derived from the data performed **worse** out-of-sample than the hand-set priors (64% vs 68%).
- Opening regret is **not lower in wins** — winners show *higher* mean regret in 3 of 4 seat/pick cells. That's a research lead, not a tuning signal.
- A controlled ablation attributed divergence mostly to **pair architecture (52%)**, not weights (13%).
- Detecting a realistic win-rate change needs thousands of games.

So the target is **intermediate metrics** — first-city timing, blocked income, dev-card pace — which converge in tens of games instead of thousands. First-city timing already looks real: the early-city half of decided games wins **77.8%** vs **46.3%**, and the direction holds inside every MMR stratum, including when the recorded player was the underdog.

**~150 decided games before revisiting weights. Currently 90.**

---

## Install

```bash
git clone https://github.com/anirvdh/catan-companion.git
```

Chrome → **Extensions** → enable **Developer mode** → **Load unpacked** → select the folder containing `manifest.json`.

Open the side panel on colonist.io. Recording can be toggled off with the **Save game** switch when you're testing.

## Repository layout

```
manifest.json          MV3 manifest
interceptor.js         MAIN-world WebSocket hook + MessagePack decode
content_bridge.js      interceptor → background relay
background.js          durable capture buffer
msgpack.js             decoder
sidepanel/
  index.html           panel markup + styles
  sidepanel.js         live state, advisors, replay, record writer (~3k lines)
ml/                    offline feature extraction (pure stdlib Python)
tools/                 research + acceptance-test harnesses
```

## Verification

Every behavioural claim is checked by replaying **real captured games through the real code path**.

```bash
node -c sidepanel/sidepanel.js
node tools/winpath_check.js      # live state vs end-game truth, every capture
node tools/winpath_logic.js      # 36 decision-logic assertions
node tools/winpath_e2e.js 165    # advisor on real boards (~1,500 calls)
node tools/setup_regression.js   # opening advisor unchanged (fingerprinted)
node tools/replay_check.js       # saved records reproduce exactly
python3 tools/audit165.py        # dataset integrity audit
```

Current: live VP **171/171** exact · opponent VP **171/171** (== truth − hidden) · board pieces **342/342** · awards **342/342** · 0 exceptions · 0 score leaks · opening advisor 0 drift.

## Data & privacy

No game data is in this repo. Captures stay local in `~/Downloads/Catan saved games/` and are gitignored — they're ~60 MB and the raw ones are irreplaceable. The extension reads only colonist.io's own WebSocket traffic for the signed-in player's games and transmits nothing anywhere.

## Documentation

| Document | Covers |
|---|---|
| [`CATAN_1V1_PRIMER.md`](CATAN_1V1_PRIMER.md) | **Start here.** The game, the scoring model, the pipeline, the record schema, the traps |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to make changes — verify, document, version, commit |
| [`CATAN_WIN_PATH_IMPLEMENTATION.md`](CATAN_WIN_PATH_IMPLEMENTATION.md) | Coach design, tiers, honesty rules, acceptance results |
| [`CATAN_165_GAME_AUDIT_VALIDATION.md`](CATAN_165_GAME_AUDIT_VALIDATION.md) | Independent validation of the dataset analysis, with corrections |
| [`CATAN_PHASE_AWARE_ADVISOR_PROPOSAL.md`](CATAN_PHASE_AWARE_ADVISOR_PROPOSAL.md) | Phase-by-phase opportunity matrix and roadmap |
| [`V151_VALIDATION_REPORT_FINAL.md`](V151_VALIDATION_REPORT_FINAL.md) | Scorer calibration report |
| [`CONVERSATION.md`](CONVERSATION.md) | Full changelog — every version, in detail |

## Two rules learned the hard way

**Never delete `raw/`.** Derived records regenerate; raw does not. A clean-slate reset once deleted raw alongside records and recovery was luck, not design.

**The city-upgrade diff omits `owner`.** A settlement→city upgrade arrives carrying only `buildingType: 2`. Any handler requiring an owner silently drops every city in every game. This shipped **twice** — once offline, once live. There are permanent assertions against both now.

---

## Version history

Condensed. Full detail, with reasoning and measurements, is in [`CONVERSATION.md`](CONVERSATION.md) — 53 versions.

### Current — the advisor becomes score-aware

| Version | Change |
|---|---|
| **1.62** | **Fixed the city-upgrade diff in the live path.** Upgrades arrive with `buildingType: 2` and **no `owner`**, so the live handler skipped them and dropped every city: live city count matched truth in only **8/60** games. The coach said "toward your first city" all game and offered to upgrade corners that already *were* cities. Now **342/342**. The same bug had been fixed offline long before — the live path never got it. Permanent assertions added. |
| **1.62** | Merged the two dice sections into one content switcher (Roll odds · Dice distribution); dropped the reshuffle readout from the UI (the logic is untouched). |
| **1.61** | **Win-Path coach.** Replaced the score-blind ladder with a tiered, score-aware engine. Wired five live fields that were already arriving but parsed only offline — VP by category, both award holders, road chain length, robber tile, port ratios — plus per-colour knight counts. All arrive as **partial diffs**: merged cumulatively, live VP is exact **171/171**. Found two bugs: **VP categories 3/4 were documented backwards** (3 = Largest Army, 4 = Longest Road — invisible because both are worth 2 VP), and **`awards.lrMe` was wrong in 46/165 records** because award states were replaced instead of merged. |

### Recording integrity

| Version | Change |
|---|---|
| **1.60** | `completedTurns` + `terminalTurnNumber` separated (they differ by exactly 1 in 66/66 games). Added `leader`/`leaderVP` — **the server names a winner who can be behind on VP** (3/66 games) — and derived `decided` from the leader instead. Added `mmrComplete`. Corrected "winners land exactly on 15": a genuine **16-VP** winner exists, since hidden VP cards all reveal at once. |
| **1.59** | **`captureIntegrity` + `researchEligible`.** A partial capture is valid JSON that replays fine — this is the only thing separating it from a complete game. Negative-tested: a capture truncated *just before* the end-game message (full setup, 101 rolls, looks normal) is correctly rejected. Added `sourceHash` for duplicate detection, wall-clock bounds, ordered roll sequence, per-settlement opening detail. |
| **1.58** | Corpus reinstated and validated by replaying all 138 captures. **Key correction: 53% of games are concessions**, not 39% — unfiltered win rate 49% vs decided-only 57%. |
| **1.57** | Full version block + `scorerConfigHash` (catches constants edited without a version bump). First-class `openingState`. |
| **1.56** | **Captured the type-45 end-game message** — it carries no `gameState`, so the replay loop had been skipping it entirely. It is the only source of ground truth: true final VP including hidden cards, both players' MMR, per-category income, dice stats. Decoded `victoryPoints` as **category → count** (a naive sum flags 100% of games as concessions). |
| **1.53–1.55** | Corpus split by scorer generation; clear-games control (games live in *two* stores — deleting only the files left a silent desync). |

### Scorer development

| Version | Change |
|---|---|
| **1.52** | External review implemented. **Disabled opportunity lean** (a tail-concentration index, not an opportunity signal — disagreed in sign on 56/111 boards) and **removed replaceability** (100% zero rate). Engine gate reworked into 4 classes with scale-aware allowances; zero-wheat-or-ore selections dropped 5 → 1. A controlled ablation **overturned my own earlier claim** that weights drove divergence: pair architecture 52%, weights 13%. |
| **1.51** | Calibration fixes after measuring saturation: soft adjustment was pinning **56%** of pairs at its cap, `rollCoverage` capped **90.6%** of top-10 pairs. Both were constants pretending to be discriminators. |
| **1.50** | **Board-archetype model.** Continuous lean (OWS ↔ road ↔ balanced) replacing fixed weights; engine-viability gate; pair-level scoring for the second pick. |
| **1.4x** | Cities bug: a settlement→city upgrade drops `owner`, so **every city in every game** was lost — which had produced a confident and entirely wrong conclusion that ore openings underperform. |

### Published

| | |
|---|---|
| **repo** | Published to GitHub at v1.62. Game data, local settings and caches deliberately excluded; machine usernames scrubbed before the first commit. Added `README.md`, `CONTRIBUTING.md` and `CLAUDE.md` so the "document every change" rule is enforced rather than remembered. |
