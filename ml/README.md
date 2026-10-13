## Corpus separation (important)

Games are split by scorer version so results are never silently pooled:

- `~/Downloads/Catan saved games/v150/` — games played under the **v1.50** scorer (current)
- `~/Downloads/Catan saved games/` — the older **v1.40-era** corpus (111 games)

Scripts default to the **current** corpus and print which one they used.
Use `--legacy` or `--all` to override — and always say which corpus a number came from.

---

# Catan Placement Learner (offline data-tuner)

Turns your real games into **corrected weights** for the extension's opening-pick advisor.
Today the advisor uses hand-tuned rules (pips × scarcity × board-lean + bonuses). This
pipeline checks those rules against how your games actually turned out and suggests better
numbers — grounded in *your* board-reading and the real colonist meta.

This is the **data-tuner** path (chosen over a full simulator for now): smaller, and it pays
off once you have enough games. It does **not** do lookahead — it re-weights the existing
heuristic. (A self-play simulator for true lookahead is a possible later phase.)

---

## The one big idea: luck-adjusted target

A single game's win/loss is mostly **dice luck**, so "did I win?" is a noisy signal over ~100
games. Because the extension decoded colonist's balanced-dice model, each archived game stores
`luckMe` — how much the dice favoured your board vs fair. We train on:

```
luck_adj_production = my_roll_income / (luckMe / 100)
```

i.e. your resource income with the dice luck divided out. That isolates how good the *engine
your opening built* was — which is exactly what placement controls. Clean signal from few games.
(`iWon` is kept as a secondary sanity check.)

---

## Workflow

You mostly just **play** — everything else is automatic.

1. **Collect games** — play with the side panel open. Every finished game auto-saves to
   `Downloads/Catan saved games/game-<id>.json`. (One-time catch-up for games already in
   memory: Review tab → 🗄 Saved Games → **Save games in memory**.)
2. **Pool across machines** — copy `game-*.json` files from your other machine into the SAME
   `Catan saved games` folder. Records dedupe by gameId, so overlap is harmless.
3. **Look (no installs needed):**
   ```
   python3 analyze.py
   ```
   Auto-reads `~/Downloads/Catan saved games/`. Prints your record, feature↔outcome
   correlations, 1st-vs-2nd-pick differences, and a heuristic backtest. Plain Python 3.
4. **Train (needs libraries), around ~50 games:**
   ```
   pip install -r requirements.txt
   python3 train.py
   ```
   Fits a gradient-boosted model (importances) + a linear model (signed weights), writes
   `learned_weights.json` with **suggested per-resource weights**.

The extension shows a live **"N games saved"** count in the Review tab (next to Analyze last
game). When it's ~50, that's the signal to run `train.py`.

---

## How much data?

| games | what it's good for |
|------:|--------------------|
| < 25  | plumbing/validation only — any "pattern" is coincidence |
| 40–50 | first trustworthy corrections; run `train.py` |
| 100+  | genuinely tuned to your style and boards |

`train.py` refuses to over-claim on small samples and skips cross-validation under ~30 games.

---

## Files

- `features.py` — feature + luck-adjusted-target extraction (pure stdlib). Edit here to add features.
- `analyze.py` — dependency-free report. Run anytime.
- `train.py` — gradient-boosted + linear models; writes `learned_weights.json`.
- `requirements.txt` — pandas / scikit-learn / numpy.
- `learned_weights.json` — output (created by train.py).

## Feeding results back into the extension

`learned_weights.json → suggested_resource_weights` maps directly onto the `base` resource
weights in `buildBoardGeo()` (sidepanel.js). Once the numbers are trustworthy (~50+ games)
we swap them in and re-validate the advisor against held-out games. Feature importances also
tell us which NEW features are worth adding to the ranker (e.g. board-lean, contestedness,
first/second interactions).

## Roadmap

1. ✅ Data foundation (extension Game Archive + export).
2. ▶ This tuner — corrected weights from your games (target: luck-adjusted production).
3. Richer features + interaction terms (first/second × spot type, port × matching production).
4. (Optional, big) Catan self-play simulator + Monte Carlo / RL for true lookahead.
