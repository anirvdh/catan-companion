# Catan Companion

A Chrome extension (Manifest V3) that gives live strategy help for **1v1 [colonist.io](https://colonist.io) games in 15-VP / discard-at-10 mode**, plus a research pipeline for measuring whether that help actually works.

It does two things:

1. **Advises during play** — an opening-placement advisor and a score-aware Win-Path coach.
2. **Records every game losslessly**, so advice can be evaluated against real outcomes instead of intuition.

---

## Status

| | |
|---|---|
| Version | **1.62** |
| Placement scorer | `v1.50`, config hash `ee784b36` (frozen for the current collection run) |
| Games recorded | 171 (fresh corpus, all `researchEligible`) |

## Features

### Opening placement advisor
Ranks every legal corner at setup using a weighted production model with a continuous **board lean** (ore-wheat-sheep ↔ road-building ↔ balanced) and an **engine-viability gate** (STRONG / WEAK / FRAGILE / MISSING). Shows the board read *before* the picks.

### Win-Path coach (v1.61+)
Replaced a fixed priority ladder that was **score-blind** — it gave identical advice at 3 VP and at 14 VP. The engine now reads the live score of both players and answers four questions:

```
OBJECTIVE    Close out the game — 2 VP to go
BOTTLENECK   2 ore short (you make 0.19/roll)
DO NEXT      Build a CITY on your 9-wheat / 6-ore
ALTERNATIVE  Buy a DEV card — 1 knight from Largest Army
CHANGES IF   they take Largest Army — a 4-VP swing
```

It **never displays either player's score.** The opponent's position drives every recommendation; Colonist already shows the scoreboard, so repeating it is noise.

It is also honest about what it cannot know: your VP is exact, the opponent's is *visible only*, and their unplayed dev-card count is a rule-guaranteed **upper bound** on hidden VP — never an assumption that they hold any. No dice prediction, anywhere.

### Supporting panels
Dice distribution & next-roll odds (balanced-dice model), opponent hand inference, dev-deck tracking, robber placement advice, and post-game review.

---

## Install

```bash
git clone <this-repo>
```

Then in Chrome: **Extensions → Developer mode → Load unpacked** → select this folder (the one containing `manifest.json`).

## Repository layout

```
manifest.json          MV3 manifest
interceptor.js         MAIN-world WebSocket hook (MessagePack decode)
content_bridge.js      interceptor → background relay
background.js          durable capture buffer (survives panel close)
msgpack.js             decoder
sidepanel/
  index.html           panel markup + styles
  sidepanel.js         live state, advisors, replay, record writer (~3k lines)
ml/                    offline feature extraction and analysis (pure stdlib Python)
tools/                 research + acceptance-test harnesses
```

## Verification

Every behavioural claim is checked by replaying **real captured games** through the real code.

```bash
node tools/winpath_check.js      # live state vs end-game truth, every capture
node tools/winpath_logic.js      # 36 decision-logic assertions
node tools/winpath_e2e.js 165    # advisor driven on real boards (~1,500 calls)
node tools/setup_regression.js   # opening advisor unchanged (fingerprinted)
node tools/replay_check.js       # saved-record fields reproduce exactly
python3 tools/audit165.py        # dataset integrity audit
```

Current state: live VP **171/171** exact, board pieces **342/342**, 0 exceptions, 0 score leaks, opening advisor 0 drift.

---

## Documentation

| Document | What it covers |
|---|---|
| [`CATAN_1V1_PRIMER.md`](CATAN_1V1_PRIMER.md) | **Start here.** The game, the scoring model, the recording pipeline, the saved-game schema, and the traps. Written to teach the whole system from scratch. |
| [`CONVERSATION.md`](CONVERSATION.md) | **The changelog.** Every version, what changed, and *why*. |
| [`CATAN_WIN_PATH_IMPLEMENTATION.md`](CATAN_WIN_PATH_IMPLEMENTATION.md) | Win-Path coach design, decision tiers, honesty rules, acceptance results |
| [`CATAN_165_GAME_AUDIT_VALIDATION.md`](CATAN_165_GAME_AUDIT_VALIDATION.md) | Independent validation of the dataset analysis, with corrections |
| [`CATAN_PHASE_AWARE_ADVISOR_PROPOSAL.md`](CATAN_PHASE_AWARE_ADVISOR_PROPOSAL.md) | Phase-by-phase opportunity matrix and roadmap |
| [`V151_VALIDATION_REPORT_FINAL.md`](V151_VALIDATION_REPORT_FINAL.md) | Placement-scorer calibration report |

## Two rules that exist because they were learned the hard way

**1. Never delete `raw/`.** Derived records are regenerable; raw captures are not. A clean-slate reset once deleted raw alongside records, and recovering it was luck. Game data lives outside this repo (`~/Downloads/Catan saved games/`) and is gitignored — back it up separately.

**2. The city-upgrade diff omits `owner`.** A settlement→city upgrade arrives carrying only `buildingType: 2`. Any handler that requires an owner silently drops every city in every game. This bug shipped **twice** — once in the offline replay, once in the live path. There are now permanent assertions against both.

## Data & privacy

No game data is committed. Captures stay local, in `~/Downloads/Catan saved games/`. The extension only reads colonist.io's own WebSocket traffic for the signed-in player's games; it sends nothing anywhere.

## Contributing / making changes

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Short version: **every change gets documented in `CONVERSATION.md` and verified by replay before it ships.**
