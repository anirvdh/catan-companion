# v1.51 Validation Report — FINAL (regenerated with final constants)

```text
scorerVersion          v1.50 pipeline (extension build 1.52)
configHash             b17ecced3d64   (sha256 of V150 constants)
sourceHash             a66b23788665   (sha256 of sidepanel.js)
generatedAt            (stamped by the run that produced this file)
boardCount             111
validationScript       v2 — single constant set, no mixed results
```

> Supersedes `V150_VALIDATION_REPORT.md`, which was generated BEFORE the final
> `coverage.multiplier 0.30→0.28` and `rollCoverage.multiplier 0.04→0.025` changes.
> That file has been deleted to prevent mixing two constant sets. **The reviewer was right.**

## 14.2 Lean calibration

| lean | p10 | median | p90 | mean | at −1 | at +1 | saturated | live weight |
|---|---|---|---|---|---|---|---|---|
| globalSupplyLean | -0.85 | 0.14 | 0.88 | 0.02 | 6 | 10 | 16/111 (14.4%) | **1.00** |
| pairOpportunityLean | -0.96 | 0.40 | 1.00 | 0.28 | 10 | 33 | 43/111 (38.7%) | 0.00 (diagnostic) |
| finalBoardLean | -0.85 | 0.14 | 0.88 | 0.02 | 6 | 10 | 16/111 (14.4%) | — (= global) |

`pairOpportunityLean` is now **diagnostic only**. Retained evidence for disabling it:
corr with globalSupplyLean **-0.22**, signs disagree on **56/111** boards, saturates **38.7%**. finalBoardLean now equals globalSupplyLean exactly.

## 14.3 Soft components — FINAL constants

| component | mean | sd | p10 | p50 | p90 | p95 | p99 | max | zero | cap-hit all | cap-hit top-10 | changes top-1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| coverage | 0.85 | 0.26 | 0.54 | 0.88 | 1.21 | 1.25 | 1.47 | 1.58 | 0.0% | **0.0%** | **0.0%** | 2/111 |
| recipes | 0.24 | 0.27 | 0.00 | 0.19 | 0.63 | 0.74 | 1.05 | 1.44 | 44.1% | **0.0%** | **0.0%** | 10/111 |
| rollCoverage | 0.29 | 0.10 | 0.18 | 0.30 | 0.43 | 0.45 | 0.53 | 0.60 | 0.0% | **0.0%** | **2.4%** | 8/111 |
| recipeCoProduction | 0.00 | 0.01 | 0.00 | 0.00 | 0.00 | 0.00 | 0.08 | 0.19 | 96.4% | **0.0%** | **0.0%** | 0/111 |
| port | 0.40 | 0.48 | 0.00 | 0.10 | 1.05 | 1.35 | 1.60 | 1.60 | 43.5% | **1.1%** | **0.0%** | 0/111 |
| tempo | 0.62 | 0.24 | 0.28 | 0.56 | 1.01 | 1.07 | 1.15 | 1.19 | 0.0% | **0.0%** | **0.0%** | 6/111 |
| robber | 0.35 | 0.17 | 0.10 | 0.32 | 0.55 | 0.63 | 0.80 | 1.00 | 0.0% | **0.5%** | **0.0%** | 7/111 |
| **final soft** | 1.24 | 0.44 | 0.66 | 1.26 | 1.79 | 1.93 | 2.16 | 2.50 | — | **0.01%** | — | — |

All components now satisfy the §4 rule (≤5% all, ≤10% top-10). `replaceability` has been **removed**, not merely zeroed.

## 14.4 Engine gate — scale-aware, 4 classes

Top-pick class: **STRONG 109 · WEAK 1 · FRAGILE 0 · MISSING 1** of 111.

### Gate variant comparison

| gate | STRONG | WEAK | FRAGILE | MISSING | zero-wheat-or-ore picks | top-1 vs scale-aware |
|---|---|---|---|---|---|---|
| old fixed (2.00/1.00) | 104 | 2 | 0 | 5 | **5** | — |
| **scale-aware (live)** | 109 | 1 | 0 | 1 | **1** | — |
| strict no-MISSING | 100 | 11 | 0 | 0 | **0** | — |

**The four zero-wheat/zero-ore selections are eliminated.** Boards that changed top pick: army6743, coin6243, deck4256, hill6198, sea4007, sheep5337

Remaining non-STRONG selections:

- **cost1098** → `6+2` class MISSING, wheat 0 / ore 0; best STRONG sacrifice 4.06 vs allowance 3
- **sheep5337** → `26+18` class WEAK, wheat 10 / ore 2; best STRONG sacrifice 3.78 vs allowance 2.94

## 14.5 Exhaustiveness — clean-board vs LIVE states

| state | legal candidates | scored | illegal scored |
|---|---|---|---|
| clean-board pair scan (opportunity diagnostic) | 1359 | 1359 | 0 |
| **live P2 opening** (after P1's settlement) | 1162 | 1162 | **0** |
| **complement pick** (one own settlement down) | 47 | 47 | **0** |
| **P1 fourth pick** (after P2's pair) | 44 | 44 | **0** |

The 1359 figure is the **clean-board** count. Live P2 sees ~1162 pairs after P1 blocks corners — all scored, none illegal. Nothing is pruned on any live path.

## 14.7 Performance — steps 1–12 only

Exhaustive live pair ranking: p50 **50ms** · p90 **52ms** · p95 **52ms** · max **62ms**

## §12 Symmetry & determinism

- shuffled corner **iteration order** → identical top-1 on **111/111** boards
- **corner-ID permutation** (relabel every corner, preserve features/adjacency/ports) → recommendation transforms correctly on **111/111** boards
- geometric rotation/reflection tests: **deferred to Phase B**, as agreed (needed once road/expansion geometry enters scoring)

## §4 Ablation ladder — what actually causes the v1.40 → v1.50 divergence

Controlled, one-change-at-a-time (111 boards):

| transition | isolates | top-1 changed |
|---|---|---|
| A → B | production-weight system only (v1.40 structure, v1.50 weights) | **14/111 (13%)** |
| B → D | **pair architecture** (v1.40 structure → v1.50 pipeline) | **58/111 (52%)** |
| D → E | adding `pairOpportunityLean` back (70/30 blend) | **9/111 (8%)** |
| A → E | end to end | 60/111 (54%) |

**This overturns my earlier claim.** I previously said 46 of 60 disagreements were `rawProduction`-driven
and concluded the weights/lean caused most of the divergence. The controlled ablation shows the
opposite: the **pair architecture causes 52%**, while the weight system alone causes only 13%.

The reviewer predicted this exact error in §4: *"Raw production can be the largest difference between
the two candidate pairs even when the actual version change was caused by removing an old v1.40
bonus."* My "dominant reason" column measured *which component differs most between the two chosen
pairs*, which is **not** the same as *what caused the choice to change*. The ladder is the correct
instrument; the reason-column should be read as descriptive only.

Note also `D → E = 9/111`: re-enabling the opportunity lean would change 8% of recommendations —
non-trivial, which is a further argument for not shipping a signal whose semantics are wrong.

## §7 Full port ablation

| variant | top-1 changes | top-3 set changes | order changes | gate-class changes | mean rank shift | max |
|---|---|---|---|---|---|---|
| additive only (engine bridge still active) | 0 | 1 | 0 | 0 | 2.7 | 74 |
| **FULL** (additive 0 **and** engine bridge disabled) | 0 | 1 | 0 | 0 | 2.7 | 74 |

Both ablations were run — the earlier one was indeed incomplete (it left the bridge active), so this
is the first true full ablation.

**Decision: retain port unchanged.** The removal criteria in §7 required *0 top-1, 0 top-3, 0 order,
0 gate, negligible rank movement*. We observe 0 top-1 / 0 order / 0 gate, but **1 top-3 change** and a
mean rank shift of 2.7 (max 74) — so it does not meet the bar for removal. Per the stated rule,
"otherwise retain it unchanged". Port is not inert: it reorders candidates and affects top-3
composition; it simply never overturns a top-1 on this 111-board sample.

Identical figures for both variants indicate the **engine bridge is currently never the deciding
factor** for a class promotion on these boards — consistent with the tightened bridge validity rule
(must own the port, be short on wheat/ore, and hold a real tradeable surplus).

## §5 Review mode — dual-version (no history overwrite)

The hybrid (*v1.40 bonuses on v1.50 weights*) is gone. Each pick is now graded twice and both are
stored:

- **v1.40 (historical):** v1.40 bonus structure on `weights140` — a *pure* reproduction of the model
  in use at capture time.
- **v1.50 (current):** the live pipeline — opening pick judged standalone, complement pick judged as
  the completing half of the pair, exactly as the live advisor does.

Every saved record now carries `capturedScorer { version, weights, lean }` for version pinning.

Measured over 54 raw games / 108 graded picks:

| metric | v1.40 (historical) | v1.50 (current) |
|---|---|---|
| mean opening regret | **0.77** | **0.85** |
| picks ranked differently by the two models | — | **55/108 (51%)** |

Half of all historical picks would have been re-graded by a silent migration. **Never quote an
opening-regret aggregate without naming the scorer version** — the 1.7-vs-1.6 wins/losses figure
used in earlier analyses is a **v1.40** number.
