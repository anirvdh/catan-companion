# 165-Game Audit — Independent Validation

**Audit date:** 2026-10-10
**Corpus:** `Downloads/Catan saved games/Games after v.156` — 165 derived records + 165 raw captures.
**Older generations (`Games before v1.56`, `v150/`) were excluded from every empirical number below.**
**Scorer shown to the player in all 165 games:** `v1.50`, config hash `ee784b36`.

Validates `CATAN_165_GAME_DATASET_ANALYSIS.md` ("the report").

## How to reproduce

```bash
python3 tools/audit165.py      # §1–9 validation table
python3 tools/timeline.py      # rebuild event timelines from raw (writes tools/timeline_cache.json)
python3 tools/research.py      # Part 4 exploratory signals
python3 tools/live_fields.py   # which fields are observable live
node    tools/replay_check.js  # replay all raw through current code, diff vs stored records
```

All four read the corpus and write nothing except `timeline_cache.json` (a derived cache, safe to
delete). **No raw file is ever opened for writing.**

---

## Verdict summary

| # | Report claim | Verdict |
|---|---|---|
| 1 | Integrity: 165/165 on every capture check | ✅ **Verified** |
| 1 | Raw message count matches record metadata | ✅ **Verified** (my first run disagreed — my bug, see below) |
| 1 | Roll/city event counts cross-check against raw | ✅ **Verified, independently reconstructed** |
| 1b | MMR complete 162/165; `path1301`, `sail6757`, `fort6728` | ✅ **Verified exactly** |
| 2 | Scorer `v1.50`/`ee784b36` across all 165 | ✅ **Verified** |
| 2 | Two replay/schema generations: 69 @ 1.56/2, 96 @ 1.60/3 | ✅ **Verified** |
| 3 | 86 decided (52.1%) / 79 conceded (47.9%) | ✅ **Verified** |
| 3 | 54/86 = 62.8% win rate in decided games | ✅ **Verified** |
| 3 | Mean pre-game MMR advantage ≈ +35 | ✅ **Verified** (+35.4, n=83) |
| 3 | Seat split P1 46/30/65.2%, P2 40/24/60.0% | ✅ **Verified exactly** |
| 3 | Concessions: ahead 37 / behind 30 / tied 12 | ✅ **Verified exactly** |
| 4 | **"In 11/165 games the server winner differs from the VP leader"** | ❌ **Incorrect — it is 4** |
| 4 | 4 concession cases where winner VP < max(finalVP) | ✅ **Verified exactly** |
| 4 | 86 decided winners: 82 at 15 VP, 4 at 16 VP | ✅ **Verified** |
| 5 | Winner composition (VP card 96.5%, award 98.8%, …) | ✅ **Verified, every row** |
| 6 | First city: winner earlier 49, loser earlier 35, p≈0.16 | ✅ **Verified exactly** (p=0.1557) |
| 6 | Median first-city turn: winner 26, loser 35.5 | ⚠️ **Needs qualification — clock not stated** |
| 7 | Engine class table | ✅ **Verified** · ⚠️ **but a seat confound is unreported** |
| 8 | Regret: wins 2.01/1.80, losses 1.18/0.56 | ✅ **Verified exactly** |
| 9 | Income 119 vs 106, blocked 5.9 vs 8.7 | ✅ **Verified** · ⚠️ **semantics need stating** |

**Bottom line: the report is substantially correct.** One number is wrong (§4's "11"), two need
qualification, and one material confound is missing. Its central recommendation — *keep collecting,
change nothing in the scorer* — is correct and I endorse it.

---

## 1. Integrity — verified, including two checks I rebuilt from scratch

All 165 records pass all eight `captureIntegrity` flags, all have a unique `sourceHash`, VP category
arithmetic is internally consistent in every game, and `decided` agrees with
`max(finalVP) >= vpToWin` everywhere.

**Two corrections to my own first pass** (recorded because they show how easy these mistakes are):

1. I initially reported `rawMessageCount` matching **0/165**. My bug: raw files are
   `{meta, messages}`, and I took `len()` of the dict (2) instead of `len(messages)`.
   Corrected: **165/165**, and `sourceHash`'s count prefix also matches **165/165**.
2. I initially computed total resource income by summing every key ending in `Income`, which
   double-counts because `totalResourceIncome` is itself the sum of the four components.
   The report's 119/106 is right; my 238/211 was wrong.

### Independent event reconstruction

Rather than trust the records, I re-derived build and roll events directly from the immutable raw
logs (`tools/timeline.py`), parsing `gameLogState` entries (nested under `.text`, deduped by log id)
exactly as `reviewAnalyze` does. Three cross-checks against the type-45 ground truth:

| Cross-check | Result |
|---|---|
| Reconstructed city builds == type-45 VP category 1 | **330/330 player-slots** |
| Reconstructed roll count == record `rolls` | **165/165 games** |
| `2 setup settlements + built − upgraded == standing` (VP category 0) | **330/330 player-slots** |

The third is the strongest single check in this audit: it simultaneously validates the event
extraction, the settlement/city accounting, **and** the VP-category decode, and it would fail if any
of the three were wrong. This confirms the report's §1 cross-check claim by an independent route.

---

## 2. Version consistency — verified, and regeneration is safe *today*

Confirmed: **69** records at replay `1.56`/schema `2`, **96** at replay `1.60`/schema `3`. All 165
carry scorer `v1.50` / `ee784b36`.

I tested the report's recommendation directly (`node tools/replay_check.js`): replaying **all 165**
raw captures through the current code reproduces every pre-existing stable field — including
`decided`, `winnerVP`, `turns`, and `sourceHash` — with **zero mismatches**.

**So regeneration is safe — but only because the scorer has not moved.** The record's
`capturedScorer` means *"the scorer whose advice the player actually saw"*. Regenerating today
rewrites it to `v1.50`/`ee784b36`, which is what it already said. **The moment the scorer changes,
blind regeneration silently relabels historical advice as having come from a model that did not
exist when the game was played.** If regeneration is ever run post-change, `capturedScorer` must be
carried forward from the original record, never recomputed.

**A cheaper option that avoids the risk entirely:** `ml/features.py::upgrade_record()` already
derives the three schema-3 fields (`terminalTurnNumber`, `leader`/`leaderVP`, `mmrComplete`) from
schema-2 records **in memory at read time**. All three are recoverable from fields schema-2 already
carries. Pooled analysis therefore works across both generations today with **no files rewritten**.
I recommend this over regeneration.

---

## 3. Outcome population — verified

86 decided / 79 conceded; 54/86 = 62.8% in decided games; mean pre-game MMR advantage **+35.4**
(median +45, n=83). Seat and concession-position tables reproduce exactly.

The report's framing is right and worth repeating: 62.8% is **descriptive, not scorer validation**.
The games are non-randomized and the recorded player is typically the stronger one.

---

## 4. ❌ Correction: the winner/leader disagreement count is 4, not 11

The report states *"In 11/165 games, the server-reported winner differs from the player with the
highest final VP."* That is wrong. Decomposing all 165:

| Case | Count |
|---|---:|
| Winner's VP **strictly below** `max(finalVP)` — genuine disagreement | **4** |
| Max VP **tied**, stored `leader` field happens to name the other player | 4 |
| Max VP tied, stored `leader` names the winner | 8 |
| Winner is the sole VP leader | 149 |

The four genuine cases — all conceded — are:

| game | finalVP | server winner | decided |
|---|---|---|---|
| `clay5899` | 8 – 7 | the 7-VP player | false |
| `sea892` | 7 – 6 | the 6-VP player | false |
| `stone9594` | 8 – 7 | the 7-VP player | false |
| `wall5796` | 5 – 4 | the 4-VP player | false |

The report's own "four concession cases" sentence is correct; the "11" appears to count tie games,
where "the VP leader" is not a well-defined single player.

**This exposes a real schema wrinkle worth recording:** in **12/165** games the maximum final VP is
tied, so the `leader` field — implemented as "first player holding the max" — is **arbitrary** in
those games. It is safe for `decided` (which only asks whether *anyone* reached the target, and is
tie-invariant) but **should not be read as "who was ahead" without checking for a tie first.**
`leaderVP` is always well-defined; `leader` is not.

The report's substantive conclusions here are correct: keep `winner` and `leader` as distinct
fields, and derive `decided` from `max(finalVP) >= vpToWin`.

### Winner VP distribution

Verified: **82 decided winners at exactly 15, 4 at 16.** Validation must assert `>= vpToWin`, never
`== 15`. (Overshoot is expected: hidden VP cards all reveal at once on the winning turn, so a player
on 13 visible points can land on 16.)

---

## 5. Winner composition — verified, every row

| Winner characteristic | Audit | Report |
|---|---:|---:|
| ≥1 VP development card | 83/86 = 96.5% | 96.5% ✅ |
| ≥1 award (LR or LA) | 85/86 = 98.8% | 98.8% ✅ |
| **Largest Army** | 62/86 = 72.1% | labelled *Longest Road* ❌ |
| **Longest Road** | 64/86 = 74.4% | labelled *Largest Army* ❌ |
| 3–4 cities | 74/86 = 86.0% | 86.0% ✅ |
| ≥2 cities | 86/86 = 100% | 100% ✅ |
| Avg VP split (buildings / cards+awards) | 9.9 / 5.1 | 9.9 / 5.1 ✅ |

> **❌ The two award labels are swapped — in the report and in this audit's first pass.**
> VP category **3 is Largest Army** and **4 is Longest Road**, not the reverse. Verified by
> cross-checking the categories against the award mechanic states over the whole corpus:
> `hasLargestArmy === category 3` in **330/330** player-slots, `hasLongestRoad === category 4` in
> **330/330**. Because both awards are worth 2 VP, every VP total and every arithmetic check was
> unaffected — which is exactly why the error survived this long. Only per-award statements change.

This is the composition of winning games, not a controlled test. It does not justify any weight
change — but it is a precise description of what a win looks like in this mode, which is exactly
what a mid-game advisor needs as a target state.

---

## 6. First-city timing — verified, with one qualification and one strengthening

**Verified exactly:** of 86 decided games, **84** had both players build a city; the eventual winner
built first in **49**, the loser in **35**, no ties. Exact two-sided sign test on 84 discordant
pairs: **p = 0.1557** (report: ~0.16).

### ⚠️ Qualification: the medians depend on an unstated clock

The report gives medians 26 (winner) / 35.5 (loser). Those are correct **under the roll-index
clock**. Under the server's `completedTurns` clock the same games give 29 / 38.5. Both are defensible;
the report doesn't say which it used, so the numbers aren't reproducible as written.

| Clock | Winner median | Loser median |
|---|---:|---:|
| Roll index (dice rolls so far) — *the report's* | 26 | 35.5 |
| `completedTurns` (server turn counter) | 29 | 38.5 |
| **The player's own turns** (÷2, since 1v1 alternates) | **≈ 14.5** | **≈ 19.25** |

The third row is the one to quote to a human: the winner's first city lands around their **15th own
turn**, the loser's around their **19th**.

### ✅ Strengthening: the effect survives MMR stratification

The report treats this as a descriptive trend. It is more robust than that. Splitting decided games
at the median first-city roll and then stratifying by pre-game MMR advantage:

| MMR stratum | n | Early-city win rate | Late-city win rate |
|---|---:|---:|---:|
| MMR advantage < 0 (I was the underdog) | 32 | **84.6%** (n=13) | 52.6% (n=19) |
| MMR advantage 0 … +60 | 15 | **80.0%** (n=10) | 20.0% (n=5) |
| MMR advantage > +60 | 36 | **75.0%** (n=20) | 43.8% (n=16) |

The direction holds in **all three strata**, including when I was the lower-rated player, and median
game length is identical across the split (78 vs 79 rolls) — so this is not a length artifact.

The strictly paired, fully length-controlled version is weaker, as expected: when I built the first
city I won 68.9% (n=45); when the opponent did, 53.8% (n=39), p=0.156. Both framings point the same
way. Treat as a **strong exploratory signal**, still not causal — building a city early and winning
are both downstream of having a working wheat/ore engine.

---

## 7. Engine class — verified, but the report omits a material confound

The report's table reproduces exactly (STRONG 131/69/46/66.7%, WEAK 15/8/4/50.0%, FRAGILE 3/3/2/66.7%,
MISSING 16/6/2/33.3%).

### ⚠️ MISSING openings are 88% second-seat

| Class | n | Mean MMR advantage | **P1 share** | Median dice luck |
|---|---:|---:|---:|---:|
| STRONG | 131 | +25.0 | 50% | 102% |
| WEAK | 15 | −19.0 | 40% | 98% |
| FRAGILE | 3 | −2.7 | 67% | 99% |
| **MISSING** | **16** | +10.4 | **12%** | 98% |

Only **2 of 16** MISSING openings occurred from the first seat. The MISSING bucket is therefore
substantially a *second-seat* bucket, and its worse outcomes are confounded with seat. This
makes mechanical sense (picking later means fewer wheat/ore corners remain), but it means
"MISSING loses more" cannot be read as "the gate is calibrated correctly".

### ✅ But the gate looks much better on intermediate metrics than on win rate

Replacing win/loss with city development — far more signal per game:

| Class | games | **built any city** | median first-city roll | median total cities |
|---|---:|---:|---:|---:|
| STRONG | 131 | **119/131 = 91%** | **21.0** | 3.0 |
| WEAK | 15 | 14/15 = 93% | 35.5 | 2.0 |
| FRAGILE | 3 | 3/3 | 29.0 | 3.0 |
| **MISSING** | 16 | **9/16 = 56%** | **46.0** | **1.0** |

This is the most informative result in the corpus. A MISSING opening reaches its first city
**25 rolls later** than a STRONG one and **fails to build a city at all 44% of the time**, versus 9%.
The gate is detecting something real and strongly mechanical, visible long before the outcome.

**It still does not justify changing the gate's thresholds on n=16.** It justifies *monitoring the
gate against city timing* rather than against win rate.

---

## 8. Opening regret — verified, and the paradox survives stratification

Verified exactly: decided wins mean 2.01 / median 1.80 (n=54); decided losses 1.18 / 0.56 (n=32);
conceded 1.63 / 1.30 (n=79). (The report used the true median; an off-by-one median convention gives
1.90 for wins — immaterial.)

Stratifying by seat and pick number, as the report suggests:

| seat / pick | n | mean regret | median | took advisor's #1 |
|---|---:|---:|---:|---:|
| P1 pick 1 | 76 | 0.57 | 0.00 | 53% |
| P1 pick 2 | 76 | 1.08 | 0.30 | 45% |
| P2 pick 1 | 89 | 1.10 | 0.45 | 30% |
| P2 pick 2 | 89 | 0.57 | 0.00 | 60% |

Within decided games, **winners show *higher* mean regret in 3 of 4 seat/pick cells**. So the
paradox is not a pooling artifact.

I would not read this as "ignoring the advisor helps". Two more likely explanations, neither
testable at this n:

1. **Regret is a board property, not just a choice property.** On boards with many near-equal
   corners, any pick carries measurable regret. Those may simply be richer boards.
2. **The player has information the advisor lacks** — notably blocking the opponent's best corner,
   which the scorer does not model at all.

Either way: **a research lead, not a tuning target.** Do not optimize toward observed wins from it.

---

## 9. Resource and activity metrics — verified, semantics need stating

Verified: in decided games, mean `totalResourceIncome` **119.3 in wins vs 105.6 in losses**;
mean `resourceIncomeBlocked` **5.9 vs 8.7**.

Two things the report should have said:

1. **These are end-game aggregates and are outcome-correlated by construction** — a player who is
   winning keeps building and keeps collecting. The report flags this; it bears repeating.
2. **`resourceIncomeBlocked` is a server-reported count whose unit is not documented anywhere in
   our data.** It is almost certainly "resource cards not received because the robber sat on a
   producing hex", but we have never verified that against a reconstruction. Treat it as ordinal.

### A paired view the report didn't run

Comparing *me vs my opponent within the same game* removes board, length, and dice confounding:

| | my blocked | opponent blocked |
|---|---:|---:|
| In wins (n=54) | **5.89** | 8.67 |
| In losses (n=32) | 8.72 | 8.75 |

In losses, robber pressure is symmetric. In wins, I am blocked ~3 fewer times while blocking the
opponent just as much. The signal is in the **differential**, not the absolute — which is a
coaching-relevant framing (it is about robber *exchange*, not robber *avoidance*).

---

## Findings the report did not surface

### Holding an award is the single largest split in the dataset

Measured from the end-game VP categories (the authoritative source), **not** from the record's
`awards` block, which is unreliable — see the bug note below.

| Award held by me (86 decided games) | n | win rate | not held | win rate |
|---|---:|---:|---:|---:|
| **Largest Army** | 48 | **81.2%** | 38 | **39.5%** |
| **Longest Road** | 46 | **84.8%** | 40 | **37.5%** |

Both awards split the dataset far harder than anything else measured, and **both are common** —
roughly half of decided games each. My earlier reading that Longest Road was rare (9/86) came from
the buggy `awards.lrMe` field and was wrong.

Cause and symptom are tangled: LA holders bought a median of **12** dev cards vs **8**. Buying dev
cards requires sheep+wheat+ore, so LA partly *measures* having a working engine.

### 🐛 Bug found: the `awards` block in saved records was wrong in 46/165 games

`reviewAnalyze` **replaced** `mechanicLongestRoadState` / `mechanicLargestArmyState` on every
message instead of merging them. They arrive as partial diffs, and only ~7% of longest-road frames
carry the `hasLongestRoad` flag at all (the rest carry just the chain length), so the last frame
almost always lacked it.

| field | wrong before | after merging per colour |
|---|---:|---:|
| `awards.lrMe` | **46/165** | **0/165** |
| `awards.laMe` | 0/165 | 0/165 |

Fixed in v1.61 (`REPLAY_VERSION` → 1.61). Any past analysis that used `awards.lrMe` is suspect;
derive awards from the end-game VP categories instead, which were always correct.

### Opening pips barely predict realized income

| relationship | r | n |
|---|---:|---:|
| Total opening pips → rolling income | +0.04 | 165 |
| Total opening pips → income **per roll** (length-controlled) | **+0.16** | 165 |
| Total opening pips → dice luck % (sanity check, should be ~0) | −0.06 | 165 |
| Ore pips → income per roll | +0.20 | 165 |
| Sheep pips → income per roll | −0.16 | 165 |

A length-controlled correlation of **+0.16** between total opening pips and realized production is
strikingly weak for a quantity the scorer treats as its primary input. Before reading anything into
it, note the strong caveats: `rollingIncome` counts *cards*, not pip-weighted expectation; it is
affected by the robber, by which hexes were upgraded to cities, and by expansion after the opening.
This is **not** evidence the pip model is wrong — it is evidence that **the opening explains much
less of realized production than the scoring model implicitly assumes**, which is itself consistent
with every earlier finding that placement is near its ceiling.

### Concessions terminate near the midpoint

Median concession length **46 rolls** vs median decided game **78 rolls**. Median VP margin at
concession is **0**. Concessions where I was ahead ran longest (54 rolls), tied ones shortest (37).

---

## What I could not verify

- **Who initiated each concession.** Not in the data. The report is right to refuse the inference.
- **`resourceIncomeBlocked` units.** Not documented; not reconstructed.
- **Whether the advisor's *recommended* opening beats the *selected* one.** The records store the
  advisor's ranking at placement time, but there is no counterfactual outcome. This is unanswerable
  from observational data at any sample size.
- **Any causal claim.** Every relationship above is an association in a non-randomized sample of 165
  games, 86 decided, with a systematic MMR advantage and an uneven seat split.

---

## Recommendation

I agree with the report's bottom line and add three amendments:

1. **Keep collecting. Change nothing in the scorer, the gate, or the weights.** 86 decided outcomes
   cannot support any of it, and the MISSING bucket's seat confound makes the one apparently
   gate-relevant result uninterpretable.
2. **Prefer `upgrade_record()` over regenerating the 69 older records.** Same analytical result, no
   files rewritten, and no risk of ever relabelling `capturedScorer`. If regeneration does happen,
   carry `capturedScorer` forward rather than recomputing it.
3. **Switch the research target from win rate to city timing.** It is reconstructable from raw, it
   separates the engine classes far more cleanly than win/loss does (91% vs 56% ever building a
   city), it is visible by roll ~25 instead of roll ~78, and it survives MMR stratification. This is
   the metric that will converge in tens of games rather than thousands.
