# Catan Companion — 266-Game Analysis Brief

**For external review.** Self-contained: you should not need the codebase to follow this.
**Date:** 2026-11-01 · **Corpus:** 266 recorded games, 265 research-eligible, **146 decided**
**Scorer:** `v1.50`, config hash `ee784b36`, frozen and identical across all 266 games
**Machine-readable companion:** [`docs/corpus_stats.json`](docs/corpus_stats.json)
**Reproduce everything:** `python3 tools/analyze_corpus.py`

---

## 0. What you're looking at and what I want from you

A Chrome extension advises me during 1v1 [colonist.io](https://colonist.io) games (15 VP, discard at
10, **no player-to-player trading**) and records every game losslessly. The scorer has been
deliberately frozen since the corpus was 84 games so the data stays comparable.

The last review happened at **165 games / 86 decided**. We're now at **266 / 146** — a 70% increase
in decided outcomes. **Several findings from that review got weaker, not stronger.** That is the
single most important thing in this document, and the main thing I want a second opinion on.

**Specifically, I'd like you to pressure-test:**

1. The award findings (§4) are enormous — 43/43 and 1/31. I argue they're *structural* rather than
   merely correlational. Is that argument sound, or am I dressing up a tautology?
2. The first-city effect (§5) weakened as data grew (p 0.156 → 0.275). Is that regression to the
   mean, or is there a real effect being diluted by a widening population?
3. The regret paradox (§6) has now survived two samples. Winners consistently deviate *more* from
   the advisor. What would you test next?
4. The concession-selection problem (§8). I think it undermines every decided-only comparison. Do
   you agree, and is there a defensible correction?
5. **Why Longest Road alone (68.8%) beats Largest Army alone (45.0%)** when both are worth 2 VP (§4).
6. Anything you think I've over-claimed.

---

## 1. How the data is produced

```
colonist.io WebSocket (MessagePack)
   → MAIN-world hook → durable buffer
   → raw capture written immutable
   → pure replay → derived record
```

Every game yields **two** files: an immutable raw message log, and a derived record replayed from
it. Any derived field can be rebuilt; the raw never changes. All analysis below is re-derived from
raw where the record lacks detail.

**Integrity gating.** Each record carries a `captureIntegrity` block asserting the landmarks a
complete game must have: game start → 4 valid setup placements → first roll → **type-45 end-game
message**. Missing any ⇒ `researchEligible: false`.

This fired for real for the first time in this batch: `rule4690` has a full setup and 28 rolls but
no end-game message — a browser crash mid-game. It is valid JSON and replays without error. **It is
excluded from everything below.** 265/266 eligible.

**Ground truth** comes from colonist's own end-of-game payload: per-category victory points, both
players' MMR, per-category resource income, blocked income, dev cards bought/used, dice histogram.
Nothing in the analysis depends on the extension's own judgement of who won.

### Traps that cost real errors (relevant if you reason about the raw protocol)

| Trap | Consequence |
|---|---|
| `victoryPoints` is category → **count**, not points | a naive sum flags 100% of games as concessions |
| Category **3 = Largest Army, 4 = Longest Road** | both are worth 2 VP, so a swap is invisible in totals — it was documented backwards for months |
| Settlement→city upgrades omit `owner` | drops every city in every game; shipped twice |
| `victoryPointsState` is a partial diff | a player truly on 15 reads as 3 unless merged cumulatively |
| The server names a winner who may be **behind** on VP | happens on concessions; use `max(finalVP)` for position |
| Winners can exceed 15 | hidden VP cards reveal at once; assert `>= 15`, never `== 15` |

---

## 2. Population

| | n | share |
|---|---:|---:|
| Research-eligible games | 265 | |
| **Decided** (someone reached 15) | **146** | 55.1% |
| Conceded / abandoned | 119 | 44.9% |

**Win rate, decided only: 84/146 = 57.5% [95% CI 49–65].**

This is descriptive, not scorer validation. Games are non-randomised and I carry a mean pre-game
**MMR edge of +30.5** (median +32, n=143).

| Seat | Games | Decided | Wins | Win rate |
|---|---:|---:|---:|---:|
| P1 | 126 | 75 | 42 | 56.0% [45–67] |
| P2 | 139 | 71 | 42 | 59.2% [48–70] |

The seat difference is well inside noise. Note this **contradicts** the older 111-game corpus, which
showed a significant P1 advantage (60.8% vs 38.3%, Fisher p=0.023) consistent with twosheep.io's
structural 56/44 baseline. On the fresh scorer that gap is gone. I don't have an explanation and
would welcome one.

---

## 3. What a won game looks like

Profile of the **board leader** in each of the 146 decided games:

| Characteristic | n | share |
|---|---:|---:|
| ≥1 VP development card | 138/146 | 94.5% [90–97] |
| **≥1 award** | **145/146** | **99.3% [96–100]** |
| Longest Road | 117/146 | 80.1% [73–86] |
| Largest Army | 101/146 | 69.2% [61–76] |
| Both awards | 73/146 | 50.0% [42–58] |
| **≥2 cities** | **146/146** | **100% [97–100]** |
| 3–4 cities | 122/146 | 83.6% [77–89] |

**Mean winner: 9.9 VP from buildings + 2.1 from VP cards + 3.0 from awards = 15.**

Winner VP distribution: 139 at exactly 15, **7 at 16** (hidden VP cards all reveal on the winning
turn, so overshoot is expected).

---

## 4. Awards look near-decisive — and I think structurally, not just correlationally

The full 2×2 over all 146 decided games — this is the cleanest result in the dataset:

| What I held | n | wins | win rate |
|---|---:|---:|---:|
| **Both awards** | 43 | 43 | **100.0% [92–100]** |
| Longest Road only | 32 | 22 | 68.8% [51–82] |
| Largest Army only | 40 | 18 | 45.0% [31–60] |
| **Neither** | 31 | 1 | **3.2% [1–16]** |

Monotone across all four cells, and the extremes are 43–0 and 1–30.

**Longest Road alone (68.8%) is worth substantially more than Largest Army alone (45.0%)** — a gap
I had not noticed before and cannot currently explain. Both are 2 VP. Candidate explanations:
Longest Road also implies board presence and expansion room, whereas Largest Army can be bought by
a player whose board position is otherwise poor; or knights spent on Largest Army are knights not
spent clearing the robber off your own production.

### Why I think this is more than "winners win"

The obvious objection is endogeneity: awards are 2 VP each, so of course holders win. But there's a
**hard arithmetic constraint** that makes it stronger than that.

Piece limits are 5 settlements and 4 cities, so **maximum VP from buildings is 5×1 + 4×2 = 13**.
Awards are **zero-sum in 1v1** — unclaimed is rare (LA unclaimed in 3/146 games, LR in 0/146).

So if I hold both awards, my opponent must reach 15 from **buildings + VP cards alone**, capped at
13 + (VP cards drawn). They need ≥2 VP cards *and* a near-maximal board presence. Observed: 0 for 43.

And the converse: **only 1 winner in 146 reached 15 with zero awards.**

That reframes the 4-VP award swing as closer to a **precondition** than an advantage. If that's
right, a 1v1 15-VP advisor should treat award contention as a first-class objective rather than a
tiebreak — which is roughly what the extension now does, though it was built on much weaker evidence.

**Where I'd like challenge:** is there a cleaner way to separate "awards cause wins" from "awards
and wins share a common cause (a working engine)"? Dev-card purchases are the obvious confounder —
LA holders bought a median of 11 dev cards vs 8 for non-holders, and buying dev requires
sheep+wheat+ore, i.e. exactly the engine that also builds cities.

---

## 5. First-city timing — weaker than it looked at 165 games

This was the headline intermediate metric last time. It has **not** held up as well.

**Paired, within-game** (fully controls board, length and dice):

| | n | I won |
|---|---:|---:|
| I built the first city | 75 | 61.3% [50–72] |
| Opponent built the first city | 67 | 52.2% [40–64] |

Exact two-sided sign test: **p = 0.2752**. At 165 games this was p = 0.1557. More data made it
*less* significant, not more. Median first-city roll: winner 26, loser 30.

**Absolute timing** (split at my median first-city roll = 26) still looks strong — but is confounded:

| | n | win rate | mean MMR edge | median length |
|---|---:|---:|---:|---:|
| Early city (≤26) | 72 | 66.7% [55–76] | +42.5 | 78 rolls |
| Late city (>26) | 70 | 47.1% [36–59] | +20.7 | 80 rolls |

Game length is identical, so it isn't a length artifact — but the early-city group has **double the
MMR edge**, so part of this is just playing weaker opponents. Stratifying:

| MMR stratum | Early-city win rate | Late-city win rate |
|---|---:|---:|
| Underdog (<0) | 76.2% (n=21) | 54.8% (n=31) |
| Even (0…+40) | 58.3% (n=12) | **66.7% (n=9)** ← reverses |
| Favoured (≥+40) | 64.9% (n=37) | 33.3% (n=30) |

At 165 games the direction held in **all three** strata. It now reverses in the middle one. I read
this as the original result having been partly noise.

**My current position:** first-city timing is a real *descriptor* of a working engine, but its
causal weight was overstated. I would not tune anything on it.

---

## 6. The regret paradox — now survived two samples

`regret` = score gap between the advisor's top-ranked corner and the one I actually took, measured
under the scorer I was shown at the time.

| Population | n | mean | median |
|---|---:|---:|---:|
| Decided wins | 84 | **1.89** | 1.49 |
| Decided losses | 62 | **1.30** | 0.68 |
| Conceded | 119 | 1.61 | 1.20 |

**Winners deviate from the advisor more than losers.** Stratified by seat and pick, winners show
higher mean regret in **3 of 4 cells** (the same 3 as at 165 games).

| Seat / pick | n | mean regret | took advisor's #1 |
|---|---:|---:|---:|
| P1 pick 1 | 126 | 0.49 | 53% |
| P1 pick 2 | 126 | 1.06 | 48% |
| P2 pick 1 | 139 | 1.07 | 29% |
| P2 pick 2 | 139 | 0.63 | 58% |

Candidate explanations I can't separate:

1. **Regret is partly a board property.** On boards with many near-equal corners every pick carries
   measurable regret, and those may simply be richer boards.
2. **I have information the scorer lacks** — most obviously *denial*: taking the corner the opponent
   wants. The scorer models no opponent interaction at all.
3. The scorer is mis-ranking, and deviating is correct.

(3) is the alarming one and I can't rule it out. But an earlier honest out-of-sample test showed
weights *derived from the data* performing **worse** (64% vs 68%) than the hand-set priors, which
argues against naive refitting.

**What I'd most like from you: a design for separating (1) from (3).**

---

## 7. Other measurements

### Opening production → realised production

| Relationship | r | n |
|---|---:|---:|
| Total opening pips → rolling income **per roll** | **+0.21** | 265 |
| wood / brick / sheep / wheat / ore (per-resource) | +0.06 / +0.10 / −0.12 / −0.01 / +0.09 | 265 |

A length-controlled correlation of +0.21 is weak for the scorer's primary input. Caveats:
`rollingIncome` counts *cards*, not pip-weighted expectation; it's affected by the robber, by which
hexes got upgraded, and by post-opening expansion. I read it as "the opening explains much less of
realised production than the model implicitly assumes," not "pips are wrong."

### Engine gate (opening wheat/ore access) → city development

| Class | Games | Ever built a city | Median 1st-city roll | Median cities | P1 share |
|---|---:|---:|---:|---:|---:|
| STRONG | 206 | 91.7% [87–95] | 21.0 | 3.0 | 51% |
| WEAK | 26 | 92.3% [76–98] | 35.5 | 2.0 | 35% |
| FRAGILE | 4 | 100% [51–100] | 38.5 | 3.0 | 75% |
| MISSING | 29 | **72.4% [54–85]** | 34.0 | 2.0 | **28%** |

MISSING is still worst but **much less dramatic than at 165 games** (then: 56% ever built a city,
median roll 46). The gap narrowed substantially as n grew. MISSING also remains confounded with
seat — only 28% are first-seat, because picking later leaves fewer wheat/ore corners.

### Robber pressure (paired, within-game)

| | my blocked income | opponent's | differential |
|---|---:|---:|---:|
| In wins (n=84) | 6.19 | 9.31 | **−3.12** |
| In losses (n=62) | 7.87 | 8.53 | −0.66 |

The signal is in the *differential*, not the absolute: in losses robber pressure is symmetric. Note
`resourceIncomeBlocked` is a server-reported count whose exact unit is undocumented — treat as ordinal.

---

## 8. The methodological problem I most want challenged

**45% of all games end in concession, and concession is a choice.**

| Concession position (119 games) | n | share | median length |
|---|---:|---:|---:|
| I was ahead on VP | 52 | 43.7% | 56 rolls |
| I was behind | 48 | 40.3% | 46 rolls |
| Tied | 19 | 16.0% | 38 rolls |

Median concession: **50 rolls** vs **78** for decided games — they terminate near the midpoint.

The problem: **the decided subset is not a random sample**, and the selection rate varies
systematically:

| MMR stratum | All games | Reached a decision | Win rate among decided |
|---|---:|---:|---:|
| Underdog (<0) | 116 | 54 (**46.6%**) | 63.0% |
| Even | 36 | 21 (58.3%) | 61.9% |
| Favoured (≥+40) | 110 | 68 (**61.8%**) | 51.5% |

I win *more* when I'm the underdog (63.0%) than when favoured (51.5%) — which is backwards, and
almost certainly an artifact: as the underdog only 46.6% of games reach a decision, so the decided
subset is filtered toward games that were going well.

**If that's right, every decided-only comparison in this document is biased by an amount that
varies across strata, and the bias is not estimable from the data alone.** Final VP position does
not identify *who* conceded, so I can't even model the selection directly.

Is there a defensible correction here, or is the honest answer "treat all decided-only effects as
upper bounds"?

---

## 9. What I believe, with confidence levels

| Claim | Confidence | Basis |
|---|---|---|
| Every win needs ≥2 VP from cards/awards | **Certain** | arithmetic: building ceiling is 13 |
| Awards are near-decisive in 1v1 15-VP | **High** | 43/43 and 1/31, plus the zero-sum + ceiling argument |
| ≥2 cities is a practical precondition | **High** | 146/146, and mechanically necessary given the ceiling |
| Concessions must be analysed separately | **High** | 45% of games; position at termination is not outcome |
| Early first city indicates a working engine | **Medium** | direction consistent, but p=0.275 paired and one stratum reverses |
| Engine gate separates openings meaningfully | **Medium** | clear on city timing, confounded with seat, gap narrowing |
| Opening pips drive realised production | **Low** | r=+0.21 length-controlled |
| The seat effect | **None** | 56.0% vs 59.2%; contradicts the older corpus |
| Any specific weight value is correct | **None** | never tested; derived weights did *worse* out-of-sample |

### What this sample cannot settle

- **Anything requiring win-rate resolution finer than ~8pp.** A 50/50 coin over 146 games has a 95%
  CI of ±8.1pp. Detecting a +3pp change at 80% power needs **~4,350 decided games**.
- **Counterfactual opening quality** — what the *recommended* pick would have done. Unanswerable
  from observational data at any n.
- **Who initiated each concession.** Not in the data.
- **Causality anywhere.** Non-randomised, systematic MMR edge, uneven seat split, selective termination.

---

## 10. Where I'd take it next

1. **Stop treating win rate as the target.** It will not converge. Intermediate metrics converge in
   tens of games.
2. **Make award contention the primary research object**, given §4 — specifically *when* each award
   is secured and what it costs, which is reconstructable from the raw logs and not yet extracted.
3. **Build a denial measure** to test explanation (2) of the regret paradox: for each of my picks,
   how good was it *for the opponent*? That's computable from the board and would be the first
   opponent-aware term in a scorer that currently has none.
4. **Do not refit weights.** 146 decided games, a known-biased decided subset, and a prior
   out-of-sample test that went the wrong way.

---

## Appendix — reproducing this

```bash
python3 tools/analyze_corpus.py          # this report
python3 tools/analyze_corpus.py --json   # docs/corpus_stats.json
python3 tools/timeline.py                # rebuild event timelines from raw
python3 tools/audit165.py                # integrity audit
```

Game data is **not** in the repository (personal play data, 164 MB, raw captures irreplaceable).
The analysis scripts, the extension and all documentation are at
<https://github.com/anirvdh/catan-companion>.

All percentages carry Wilson 95% confidence intervals in brackets. Where an earlier figure is
quoted for comparison it is attributed to the 165-game snapshot it was measured on.
