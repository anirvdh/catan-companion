# v1.50 — Open Questions Before Phase B

Written in response to `CATAN_V150_COMPLETE_CLAUDE_REVIEW_AND_NEXT_ACTIONS.md`.
Everything the review asked for that was unambiguous has been **implemented and re-validated**
(see `V150_VALIDATION_REPORT.md`). What follows is only what I judged to need a decision rather
than a default, with my reasoning and a recommendation for each.

---

## 0. First: three corrections I owe

1. **My arithmetic was wrong by 1000×.** `20 × 1200 × 1200 = 28,800,000` — **28.8 million**, not
   28.8 billion. Verified. The performance *conclusion* still held (the real cost is dominated by
   the per-pair denial sim, not that product), but the number I quoted was simply wrong.
2. **My "conservative" wording was backwards.** A *smaller* half-width reaches ±1 sooner, so the
   spec's `0.05` was the **aggressive** setting and `0.0698` is the softer one. Corrected in code.
3. **The 14% vs 2% figures were different metrics and I didn't say so.** Now reported separately:
   `globalSupplyLean` saturates **16/111 (14.4%)**; `finalBoardLean` saturates **2/111 (1.8%)`.
   The review's hypothesis about the cause was exactly right.

I also accepted the review's argument on `NEUTRAL_OWS_SHARE`: the empirical 0.6139 is only **0.63
standard errors** from the theoretical `11/18 = 0.6111` (SE = 0.0465/√111 = 0.0044), i.e. not
distinguishable from sample noise. Reverted to the principled constant.

---

## Q1. `replaceability` is provably dead — delete it, or redefine it?

**Measured:** zero-rate **100.0%**, cap-hit 0%, and it changes top-1 on **0 of 111** boards.

**Why:** the exact definition (`candidate − best_alternative`) can only be positive for the single
best pair per resource on the whole board. For every other pair it is exactly 0 by construction. So
it is not "rare", it is **structurally almost always zero**.

The review said not to change it until its ranking impact was measured. It is now measured: **no
impact whatsoever**.

**Options**
- **(a) Remove it.** Simplest; loses nothing measurable. Its stated purpose (valuing scarce access
  without a global scarcity multiplier) is arguably already covered by `coverage`.
- **(b) Redefine to percentile-relative**, as the review floated:
  `max(0, candidatePips − p95(alternativePips))`. This would fire for roughly the top 5% of pairs
  per resource instead of exactly one, making it a real term.
- **(c) Keep as-is** for spec fidelity, accepting it is inert.

**My recommendation: (b).** The *idea* is sound and distinct from coverage — "this is the only
strong brick access left" is genuinely different from "this pair has enough brick". (a) is the safe
fallback. I'd avoid (c): carrying an inert term is misleading.

---

## Q2. `pairOpportunityLean` appears to be fighting `globalSupplyLean`, not refining it

This is the finding I'm least comfortable with, and the review predicted it in §10.

**Measured across 111 boards:**

| lean | median | saturated at ±1 |
|---|---|---|
| globalSupplyLean | 0.14 | 16/111 (14.4%) |
| **pairOpportunityLean** | 0.40 | **43/111 (38.7%)** |
| finalBoardLean | 0.11 | 2/111 (1.8%) |

- `corr(globalSupplyLean, pairOpportunityLean)` = **−0.22** (they point *opposite* ways on average)
- their **signs disagree on 56/111 boards** — i.e. half the time the correction argues against supply
- mean |difference| = **0.85** on a scale that only spans −1…+1

The correction was designed to *refine* the supply signal ("high sheep but no draftable wheat+ore
corner"). A −0.22 correlation with sign disagreement on half of all boards is not refinement; it is
a second, largely independent signal being averaged in at 30%. And it saturates on 39% of boards, so
for those it contributes a constant ±0.30 to the final lean regardless of magnitude.

I can see three readings and I don't think I should pick unilaterally:
- **(a) It's working as intended** — opportunity genuinely diverges from raw supply, and averaging is
  the point. Then only `opportunityLogScale` needs raising (0.25 → ~0.45) to stop the saturation.
- **(b) The log-ratio formula is mis-scaled.** `log(relTopOWS / relTopRoad) / 0.25` — a 25% relative
  difference already produces full ±1. That is a very tight scale for a ratio of *normalised top-K
  means*, which is why 39% saturate.
- **(c) The 70/30 blend is masking the problem.** Final lean looks healthy (1.8% saturation) only
  because two noisy signals are being averaged. That's a fragile kind of healthy.

**My recommendation:** raise `opportunityLogScale` to ~0.45 (fixes the saturation, which is
measurable and clearly wrong) and **leave the 70/30 blend alone** until we have a way to tell whether
opportunity divergence is signal or noise. But I'd like a second opinion on whether the log-ratio
formulation itself is right, since **that decision changes the weights on every board.**

---

## Q3. Review mode is currently half-migrated — is that acceptable?

**Current state:** `reviewScoreCorner` still uses the **v1.40 bonus structure** (diversity,
complement, wheat/ore security) but now reads **v1.50 weights** (because `geo.weights` points at the
active scorer). Live mode uses the full v1.50 pair pipeline.

The review explicitly asks (§11) that *"review mode and live mode use the same v1.50 feature
extraction"*. Right now they don't.

**The tension:** the Review tab grades your **past** openings, and all 111 saved games were graded
under v1.40. Porting Review to v1.50 will silently **re-grade your entire history** — past "you took
the best spot ✓" verdicts may flip to misses and vice-versa.

**Options**
- **(a) Port Review fully to v1.50** — consistent with live, satisfies §11, but rewrites history.
- **(b) Pin Review to pure v1.40** (`weights140` + v1.40 bonuses) — historically stable, but then
  Review grades you against a scorer the live advisor no longer uses. Arguably worse.
- **(c) Show both** — grade under v1.50 but keep the v1.40 verdict alongside during the trial.

**My recommendation: (a)**, because Review's job is "was this a good pick?", and our current best
answer to that is v1.50. But it is your call whether re-grading history is acceptable — it will
change the opening-regret numbers we've been quoting in analyses.

---

## Q4. How far should the symmetry test go?

I implemented the **iteration-order** half of review §12.1: shuffling corner iteration order
reproduces an identical top-1 on **111/111** boards. Combined with the explicit deterministic
tie-breaker (§12.2), this catches accidental dependence on corner IDs, sort instability, and
iteration order — which is what §12.1 says the test is *for*.

**Not implemented:** true geometric rotation/reflection invariance. That needs a board transformer
(rotate the hex axial coordinates, remap corner/edge/port IDs, rebuild `mapState`) — a few hours of
work and its own correctness risk.

**Question:** is the iteration-order proxy sufficient, or do you want the full geometric test?
**My recommendation:** proxy is sufficient for now. The scorer reads only per-corner hex sets, pips,
resources and ports — it has no access to absolute coordinates or orientation, so geometric
invariance follows analytically unless the geometry *decoder* is wrong (and that is already
validated 24/24 against real captures).

---

## Q5. `port` never changes the top pick (0/111) — is that right?

Port value has a healthy distribution (mean 0.40, p90 1.05, 43.5% zero, 1.1% cap-hit), so it is not
broken or clipped. But ablating it entirely **never changes top-1 on any of the 111 boards**.

Two readings:
- **Correct:** on a 15-VP board, the best-production pair with a real city base is rarely also the
  port pair, and a ≤1.60 bonus shouldn't overturn a production gap. Ports matter *later* (converting
  surplus), which placement scoring can't capture.
- **Too weak:** the spec's port model was one of its bigger investments; a term that never changes a
  decision is doing nothing.

**My recommendation:** leave it. It is a genuine tie-breaker in principle and its magnitude is
defensible; I'd rather not inflate a term just to make it visible. But flagging it because it is the
same "does this term earn its place?" question as Q1, and I answered them differently — Q1's term is
*structurally* always zero, whereas this one varies but never quite decides.

---

## Q6. I cannot supply the human labels

Review §14.6 asks for a human judgement column (`v1.50 clearly better` … `uncertain`) on the
disagreements. The queue is generated and waiting in `V150_VALIDATION_REPORT.md` (25 rows shown of
60 disagreements, with v1.40's pick, its rank under v1.50, the raw-production delta, engine-class
change, and the dominant reason).

**I can't fill this in honestly** — I have no ground truth for which opening is actually better, and
guessing would manufacture false validation. This needs you (or the reviewing model) to label them.

Worth noting from the report: the dominant disagreement reason is **`rawProduction` on 46 of 60
boards**. So most of the v1.40→v1.50 divergence comes from the *weight endpoints and continuous
lean*, **not** from the new soft terms. That is useful — it means labelling a handful of the
`recipes` (9) and `robber` (3) disagreements will tell us more per label than the raw-production ones.

---

## Status of everything else from the review

| Review item | Status |
|---|---|
| §3.1 arithmetic correction | ✅ corrected above |
| §3.2 aggressive vs conservative wording | ✅ corrected in code comments |
| §3.3 report both lean saturations separately | ✅ report §14.2 |
| §3.4 evidence for miscalibration is the 56% hit rate, not cap sums | ✅ reworded |
| §3.5 56ms covers steps 1–12 only | ✅ stated explicitly in report §14.7 |
| §3.6 54% disagreement is not a quality metric | ✅ labelled as such; queue generated |
| §3.7 full BROKEN audit | ✅ all 4 audited — every one is *"a STRONG pair exists but the raw sacrifice exceeds the allowance"*, not *"none exists"*. Gate behaved correctly in all 4. |
| §4 per-component cap audit | ✅ done — found `rollCoverage` capping **90.6%** of top-10 and `coverage` **24%**; both recalibrated from the unclamped top-10 distributions. All components now ≤2.4% top-10. |
| §4 exact final constants | ✅ full dump + diff in `V150_VALIDATION_REPORT.md` and below |
| §5.1 P2 must stay exhaustive | ✅ **it already was** — 54 corners vs `pairPoolTopK` 60 made the shortlist a no-op. Now documented so it can't be lowered accidentally. |
| §5.3 validate shortlist | n/a — nothing is pruned on the current path |
| §7.1 keep both terms, rename | ✅ `numberCoverage`→`rollCoverage`, `sync`→`recipeCoProduction` |
| §7.3 sparse-term impact | ✅ measured — see Q1 (replaceability) and Q5 (port) |
| §8 engine-gate tests | ✅ via the BROKEN audit; A/B/C confirmed |
| §11 code-path isolation | ⚠️ partly — fixed `roadAdvice` (was ranking road targets with v1.40 bonuses under the v1.50 flag). Review mode outstanding → **Q3** |
| §12.1 symmetry | ⚠️ iteration-order proxy done (111/111) → **Q4** |
| §12.2 deterministic tie-breaking | ✅ explicit comparator: score → raw → engine → tempo → stable id |
| §12.3 pair-order dedup | ✅ both orders scored, best retained per lead spot |
| §14.7 percentiles not just mean/max | ✅ p50/p90/p95/max |

**Not started (correctly, per the review's staging):** Phase B expansion, Phase C denial,
Phase D robust P1 lookahead.

---

## Final constants — diff vs the original spec

```text
neutralOwsShare          11/18   (spec 11/18 — I had briefly used the empirical 0.6139; reverted)
globalLeanHalfWidth      0.0698  (spec 0.05 — 1.5σ from 111 boards; spec §4.2 prefers empirical)
opportunityLogScale      0.25    (spec 0.25 — UNCHANGED, but see Q2)
globalLeanWeight         0.70    (spec 0.70)
opportunityLeanWeight    0.30    (spec 0.30)

weights.balanced/ows/road        (spec values, unchanged)

coverage.multiplier      0.28    (spec 0.38 — recalibrated; 0.38 clipped 24% of top-10 pairs)
coverage.cap             1.60    (spec 1.60)
rollCoverage.multiplier  0.025   (spec 0.04  — recalibrated; 0.04 clipped 90.6% of top-10 pairs)
rollCoverage.cap         0.60    (spec 0.60)
soft.scale               0.60    (NOT IN SPEC — added; without it 56% of pairs pinned at the cap)
soft.min / soft.max      -2.00 / 2.50   (spec values)

engine thresholds + allowances   (spec values, unchanged)
ports / tempo / robber / replaceability caps   (spec values, unchanged)

replaceability           computed in O(n) via top-2-per-resource index
                         (spec's O(n²) definition, identical result — see Q1 re: whether to keep)
pairPoolTopK             60      (NOT IN SPEC — ceiling for FUTURE nested lookahead only;
                                  a no-op today since a board has 54 corners)
PLACEMENT_SCORER_VERSION 'v1.50' (v1.40 fully retained and switchable)
```
