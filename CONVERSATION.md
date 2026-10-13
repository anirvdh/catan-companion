# Catan Companion — Build & Debug Conversation Log

A full record of the sessions building out the **Catan Companion** Chrome extension
(MV3) for real-time strategy on colonist.io 1v1 games. Chronological, with the key
requests, discoveries, decisions, code changes, and validations.

**Current version:** `1.62` (see manifest.json). **Scope:** 1v1 only. No
player-to-player trading (bank/port trades only). **`CLAUDE.md` was deleted** — this
file is the single source of truth for a fresh session.

**Project dirs — FLATTENED in v1.17 (manifest sits at the top; no more double-nesting):**
- macOS:   `<your>/Desktop/catan-extension/`  ← manifest.json is here; load THIS folder in Chrome.
- Windows: `<your>\OneDrive\Desktop\catan-extension\catan-extension\` was still double-nested
  as of this writing — **when syncing, flatten it the same way** (move the inner files up so
  `manifest.json` is at the top) so both machines match.
- The outer folder also holds `CONVERSATION.md` and `ml/` (the learning pipeline). Chrome ignores
  non-extension files, so they can live alongside `manifest.json` harmlessly.

---

## 🔎 For an external reviewer — current state, findings & open questions

*(Added so another model/person can form an opinion without reading the whole log. Everything below
is grounded in the 111-game corpus; §19 has the narrative, the table at the bottom has per-version detail.)*

**What it is.** MV3 Chrome extension that hooks colonist.io's WebSocket (MessagePack), reconstructs
full game state, and assists **1v1, 15-VP, discard-at-10** games in real time: a **Setup/placement
Advisor**, a mid-game **Turn Coach**, **opponent-hand + balanced-dice models**, and a post-game
**Review**. Every finished game auto-saves as a structured record (+ full raw messages since v1.23)
to `Downloads/Catan saved games/`, forming a **111-game corpus** analysed offline in `ml/`.

**What the data has taught us (111 games; 54 with raw):**
1. **Placement is near its ceiling; the MID-GAME decides games.** Opening "regret" is ~equal in wins
   and losses (1.7 vs 1.6). What separates them: **cities (corr +0.37), largest army (+0.34, held
   59% of wins vs 25% of losses), dev cards (+0.30), longest road (+0.26)**. Luck is minor (won-games
   dice-luck 103 vs lost 97) — the user is **not** primarily losing to dice.
2. **The Turn Coach currently coaches the wrong things.** It only does hold-vs-trade + robber-on-7,
   which correlate ~0 / negatively with winning (over-limit-at-7 −0.11, got-robbed −0.01). A rebuild
   around the winning engine (cities/army/dev/road) is **queued but not built**.
3. **Win rate declined over the corpus: 56%→56%→44%→40% (chronological quartiles, flat luck).**
   Unresolved whether that's tougher opponents (climbing MMR) or over-tuned placement advice pulling
   the user off instinct. An honest A/B backtest showed **placement-weight tuning does NOT generalise**
   (out-of-sample it's a wash-to-worse; current weights hold up).
4. **Board archetype matters (user's thesis, data-validated).** OWS vs road vs balanced boards want
   different strategies; the advisor now classifies the board and leans the weights accordingly. On
   OWS boards, OWS-heavy openings win 57% vs 47%. Second-seat is the biggest positional leak (42% vs
   60% as first).
5. **A silent data-capture bug (cities read 0 in 95/100 games) had corrupted the earlier ore analysis.**
   Fixed in v1.30; ore is now correctly valued for the 15-VP city/dev engine. Cautionary tale about
   trusting derived signals before validating the capture.

**Where we'd genuinely value an outside opinion:**
- The learning **target is `luck-adjusted production`**, but that correlates only **0.25 with actually
  winning**. Should the target be winning directly, or a cities/army/road composite? Is the whole
  "learn resource weights from production" framing chasing the wrong quantity?
- With ~111 noisy human games, is **any** learned placement model justified, or should we stay
  rule-based until a **self-play Catan simulator** exists? (We have a validated balanced-dice model but
  no game simulator.) Cross-validated R² has been **negative** at every checkpoint (−1.78→−0.73→−0.29).
- We've re-tuned resource weights across **10+ versions** (wheat up/down, ore up/down, scarcity in then
  out). The backtest says this is near a low ceiling and fine-tuning overfits. **Is continued
  weight-tuning worth it, or should all effort move to the mid-game coach + a simulator?**
- Board-archetype **lean values are hand-set** (v1, pending the user's test-game feedback). Is there a
  principled way to set them from 111 games without overfitting?
- How much of the **42% second-seat** rate is irreducible first-player advantage vs coachable?

**Immediate next step (agreed):** rebuild the Turn Coach around the winning engine (build #2). The user
is currently playing **test games with the save toggle OFF** to give qualitative feedback on the new
board-archetype reads before those leans are finalised.

---

## 🚨 PERMANENT RULE — never delete `raw/`

```text
RAW GAME CAPTURES  →  IMMUTABLE  →  NEVER DELETE
Every derived artifact is regenerable. Raw is not.
```

Records, grades, scores and analyses are **derived** — if replay or scoring has a bug we re-run it over raw and
regenerate them. Raw cannot be rebuilt from anything. Deleting it destroys the game permanently, including for
every future fix.

This is not hypothetical: on 2026-09-16 a clean-slate reset deleted `raw/` along with the records, and with it the
only statistically significant finding the project ever had (the seat split, Fisher p=0.023, n=111) plus the 39%
concession baseline. Those cannot be recomputed. **Clearing the corpus means deleting `game-*.json` only.**

---

## ⚠ Switching between computers — read this first

The project lives on **two machines** (Windows + macOS) and is edited on both. It is **not
in git**, so there is no automatic sync. Before starting work on either machine:

1. **Get the latest code.** Whichever machine has the newest edits is authoritative — check
   `manifest.json` `version` and this file's Version-history table. Copy the whole project
   folder across (OneDrive/USB/zip). All source is plain files at the TOP level now:
   `manifest.json`, `interceptor.js`, `content_bridge.js`, `background.js`,
   `sidepanel/index.html`, `sidepanel/sidepanel.js`, `sidepanel/fonts/`, `icons/`, plus `ml/`
   and this file. No build step.
2. **Reload in Chrome** after copying: `chrome://extensions` → the extension → **Reload**
   (or Load unpacked → the **catan-extension** folder, now that manifest is at the top). Hard-
   refresh colonist.io so `interceptor.js` re-injects at `document_start`.
3. **Saved games are per-machine and NOT synced.** Finished games auto-save to
   **`Downloads/Catan saved games/game-<id>.json`** (small structured records: board + your
   picks + candidate choice-sets + luck-adjusted outcome). To pool: copy the `game-*.json`
   files from the other machine's `Catan saved games` folder into this one (dedupe by gameId).
   *(A separate rolling raw debug capture still lands in `Downloads/catan-logs/` — not the corpus.)*
4. **The count in the Review tab** ("N games saved") reflects games archived on THIS machine
   (chrome.storage, which does NOT sync). The definitive pooled total is what `ml/analyze.py`
   reports once you've copied both machines' files into one folder.
5. **The learning pipeline** (`ml/`) reads `~/Downloads/Catan saved games/game-*.json` directly —
   no export step. `python3 ml/analyze.py` (no installs) or `python3 ml/train.py` (needs
   `pip install -r ml/requirements.txt`). See `ml/README.md`.

---

## Architecture (unchanged throughout)

```
interceptor.js (MAIN world, document_start)   hooks window.WebSocket before colonist loads
  → decodes binary MessagePack frames
  → CustomEvent → content_bridge.js → chrome.runtime → background.js (durable capture + relay)
  → port → sidepanel.js (game state model + UI)
```

Files: `manifest.json`, `interceptor.js`, `content_bridge.js`, `background.js`,
`sidepanel/index.html`, `sidepanel/sidepanel.js`, `msgpack.js` (unused), `icons/`.

---

## 1. "Read the folder and figure out what we've built. We need to improve the plugin."

Read the whole extension. Findings:
- Pipeline (WS intercept → MessagePack decode → side panel) was solid.
- Dice tracking worked; UI shell complete.
- **Risks:** resource-index mapping was a guess; unclear whether opponent hand is even
  broadcast; board/hex tracking was dead code; builds/robber/trades/dev were stubs.
- Biggest opportunity: mine `gameLogState` (the structured in-game log) as the single
  source of truth instead of brittle string-matching.

**Decision:** focus on the **opponent hand model**, and first build a capture logger so a
full game could be recorded for offline protocol analysis.

---

## 2. Capture logger (v1.2)

Built an auto-saving, full-fidelity WebSocket capture:
- `interceptor.js` adds base64 raw bytes for small/undecodable frames.
- Side panel records every frame's full decoded tree; auto-saves a rolling JSON to
  `Downloads/catan-logs/catan-capture-latest.json` + "Save Archive" for timestamped copies.
- New "Capture Logger" panel in the Debug tab.
- Added `downloads` permission.

Chrome can't write into the project folder, so captures land in Downloads and are read from there.

---

## 3. "The plugin is very unstable — Chrome lags and colonist won't load." (v1.3)

Root causes found and fixed:
1. **Decoder could hang the tab** — the MessagePack decoder had no bounds checking; a
   non-MessagePack control frame could misread a length and loop forever (a hang, not a
   throw). Added `need()`/`cap()` bounds guards.
2. **Heavy work ran synchronously in the WS callback** (full decode + two whole-tree
   `JSON.stringify` per message). Added a **time-sliced queue** (~6 ms/tick, drop-oldest
   past 1000) so the page thread never blocks; made classify/summary cheap for big frames.
3. **Side panel re-rendered everything per event** → coalesced via `requestAnimationFrame`,
   throttled the capture counter, and gated Debug-tab DOM writes to when it's visible.

---

## 4. "Manifest not readable"

Diagnosed: the manifest was valid — the project is **double-nested**
(`catan-extension/catan-extension/`), so Chrome must load the **inner** folder. Also
removed a junk `{icons,sidepanel}` directory. Advised the exact folder to load and the
OneDrive-lock retry.

---

## 5. First real capture — protocol decoded, opponent model rewritten (v1 → validated)

Analyzed the first 615-message game. Key discoveries:
- **Core channel:** `data.type === 91` messages carry `payload.diff` with all game state.
- **Resource enums (via `bankState`):** `1=wood, 2=brick, 3=sheep, 4=wheat, 5=ore`, `0=hidden`.
- **`playerStates.<color>.resourceCards.cards` is a LIST OF CARD ENUMS** (one per card),
  **not** a count array. The client sees its own cards; the **opponent's come through as
  all `0`s (hidden)** — so we always know the opponent's exact *count*, never the breakdown.
- **Decoder bug:** missing `0xcf` (uint64, used by `startTime`) mis-aligned the offset and
  corrupted ~10 messages (dropping dice/turn data). Fixed by adding `0xcf`/`0xd3`/ext types
  (returning `Number`, never `BigInt`).
- **Dice diff quirk:** `diceState` omits a die when it repeats — but `gameLogState type 10`
  (`firstDice`+`secondDice`) is always complete → used as the reliable dice source.
- **`gameLogState` event enum:** `10`=roll, `47`=resource distribution (`cardsToBroadcast`,
  dist 0=setup / 1=roll — **broadcasts gains for BOTH players**), `4`=setup build (free),
  `5`=main build (costs), `116`=bank/port trade, `14`=you stole / `15`=you robbed.

**Result:** the opponent hand is fully reconstructable from public events (no board needed):
setup+roll gains − build costs − dev-buy(−1 sheep/wheat/ore) ± steals, reconciled against the
exact count. **Validated 24/24 checkpoints, 0 mismatches.** Rewrote the side panel around this:
auto-detect "me" (no picker), turn detection via `currentTurnPlayerColor`, removed My-Hand
section, opponent breakdown + confidence.

---

## 6. UI polish (v1.4)

- **Font:** bundled **Public Sans** locally (`sidepanel/fonts/`) — no network dependency;
  all sizes +2 px.
- **Colors:** higher-contrast palette (esp. `--text-muted`).
- **7s tracker:** count 7s per player (attributed via the roller on `type 10`). Then, per
  request, moved it to the **footer** strip (You / OPP) and removed the standalone section
  and the header turn count.

---

## 7. Balanced-dice probability engine (v1.6)

Using the real colonist `DiceControllerBalanced` source the user provided:
- It's a **36-card deck** drawn without replacement, reshuffled when < 13 remain (~every 24
  rolls); **recent-5 damping** (−34%/occurrence; 3× in 5 → weight 0); **per-player
  7-balancing** (imbalance + streak).
- Built a faithful replica → **"Next Roll Odds"** section: live per-roller probability bars
  (hot/cold vs fair), a **7-risk split** ("7 on YOUR roll" vs "OPP roll"), and deck state.
- Validated: e.g. an under-rolled player showed ~33% 7 vs ~11% for the other. Probabilities sum to 1.

Also (v1.5) moved the **capture to the background service worker** (durable, survives panel
closed — the board snapshot is never missed) and dropped auto-save to **60 s, only while a
game is actively producing state** (no more lobby-time downloads / clobbering).

Confirmed **card discard limit = 9** and identity/turn-order come from the game-start snapshot.

---

## 8. Board awareness — Setup Advisor (v1.8 → v1.9)

- **Board decodes exactly** from `gameState.mapState.tileHexStates` = `{x,y,type,diceNumber}`
  (`type` uses the same enum as resources; `0`=desert). Verified 100% against a screenshot.
- **Corner→hex geometry (confirmed vs setup grants):** corner `(x,y,z=0)` → hexes
  `(x,y),(x+1,y-1),(x,y-1)`; `z=1` → `(x,y),(x-1,y+1),(x,y+1)`. Corner adjacency (distance
  rule) = share exactly 2 of the 3 hex-coords.
- **Ranker:** pip-equity × adaptive weights (mild city/dev premium × scarcity × board lean) +
  diversity + complement bonus.
- **Draft-aware:** reads `playOrder` → first player picks #1 & #4, second picks #2 & #3.

**v1.9 enhancements (per request):**
- Trimmed to **2–3 options as collapsible dropdowns** (first open).
- **"If you're going first"** each option simulates your likely **#4** pick + what the
  opponent will likely grab in between.
- **Road direction + cut-off logic:** each rec aims a road at the best legal expansion corner
  2 steps out; flags **⚠ CONTESTABLE** when the opponent still places after you (and the
  target ≥ 8 pips), or **✓ safe** when you place last. Advisor hides once 4 settlements are
  down or the first roll happens.

---

## 9. Turn Coach + opponent-hand bug fix (v1.10)

**Cross-check (7 captured games):** opponent hand reconciled exactly in all; colors are
arbitrary (saw 1, 2, 5, 11); code is color-agnostic.

**Dev-card enums fully confirmed** (via `type-20` "played dev card" `{playerColor, cardEnum}`
and effects):

| enum | card | evidence |
|---|---|---|
| 11 | Knight | robber move + steal |
| 12 | Victory Point | never played (passive) |
| 13 | Monopoly | log `type-86 {amountStolen, cardEnum}` |
| 14 | Road Building | played, no card cost |
| 15 | Year of Plenty | log `type-21 {cardEnums}` (took 2 from bank) |

**Opponent-hand over-count bug (user monopolied ore expecting 7, got 2):** two root causes:
1. **Year of Plenty (type-21) and Monopoly (type-86) were not processed** — card movements
   we ignored, so the breakdown drifted.
2. **Cross-game state leak** — the "new game" reset relied on the turn counter regressing,
   which misfired on rematches/reconnects, bleeding one game's opponent hand into the next.

**Fixes:** handle YoP + Monopoly; **reset reliably on `gameSettings.id` change** (a changed
game id = new game; same id = reconnect → keep state); and **`reconcileHand()`** forces the
opponent breakdown to sum to the exact known count on every update (trims phantom cards).
**Validated:** the monopoly victim now reads **2 ore = actual `amountStolen: 2`**, drift = 0
across all 7 games, and it told 6 real games from 1 reconnect.

**Turn Coach (new):** on your turn in the main game (hidden in setup / opponent's turn):
- Ranked affordable builds — City (with best settlement to upgrade), Settlement (best open
  spot from the ranker), Dev card, Road.
- **Trade-to-complete hints** (4:1 bank) when you're one resource short.
- **Discard warning** vs the 9-card limit.
- **Build-VP snapshot** (settlements + cities; longest-road / largest-army / dev VP not yet
  included).

---

## 10. "Can you tell what dev card the opponent pulled?"

**No — by design.** colonist only sends real dev-card types for **your own** cards; the
opponent's bought cards are face-down (`enum 10`) until played. (When I saw "player 2"
holding revealed cards, it was a game where *you* were player 2.) We *can* show: the
opponent's held **count**, detect each **buy** (deduct 1 ore/wheat/sheep), and reveal each
card's type the instant it's **played** (`type-20`). Offered to add a **probability** estimate
of unplayed opponent dev cards from the tracked deck composition.

---

## 11. Robber advice + tab cleanup (v1.11)

Session resumed on a new (macOS) machine — no local captures present. Built two of three
requested features; the third (ports) is blocked on a live capture.

- **Robber placement advice (Turn Coach).** When *I* owe a robber move — I rolled a 7
  (`type 10`, total 7, my color) or played a Knight (`type 20`, `cardEnum 11`, my color) —
  the Turn Coach shows a ranked "🥷 Move the Robber" block. Each candidate hex is scored:
  `(oppBuildings − 0.8·myBuildings) × P(number) × boardResourceValue`, where `oppBuildings`
  counts opponent settlements (1) / cities (2) touching the hex (reverse of the confirmed
  corner→hex geometry), `P(number)` is the **live balanced-dice probability** (so it already
  reflects the numbers rolled so far), and resource value reuses the ranker's scarcity
  weights. Self-blocking hexes get a ⚠. Also names the steal target + their exact card count.
  Flag clears on the next roll, on a resolved steal (`type 14`), or when the turn leaves me.
- **Scrapped the Strategy tab.** Its 3 tips duplicated the Opponent Hand + Turn Coach panels,
  and the "7s overdue" tip contradicted the balanced-dice engine. Removed
  `generateStrategyTips`/`renderStrategy`; **renamed the middle tab "Review"** and reserved it
  for the post-game coach (static "coming soon" placeholder for now).
- **Ports in the Setup Advisor — DONE (decoded from a recovered capture).** Found the
  auto-saved captures in `~/Downloads` (Chrome keeps the file but renames it to a UUID after
  the download-history erase). Decoded `portEdgeStates` = `{x,y,z,type}` (9 ports):
  - **Edge geometry (validated 24/24 edges):** a port edge `(x,y,z)` borders hex `(x,y)` and
    hex `(x+dx,y+dy)` with `EDGE_OFF z0→(0,-1) · z1→(-1,0) · z2→(-1,1)`; its two corners are
    the corners whose `tri` contains BOTH hexes.
  - **Port type:** `1` = generic 3:1; `n` = 2:1 for resource enum `n-1` (2=wood…6=ore).
    **Verified against real 2:1 trades:** P1 traded wheat & brick 2:1 and owned settlements on
    exactly the wheat-port `(-2,0,0)` and brick-port `(3,-2,1)` corners.
  - `buildBoardGeo` now builds `cornerPort[id]`; `scoreCorner` adds a port bonus (3:1 = +0.9;
    2:1 = base +0.8, +1.6 if the corner makes the matching resource, +1.2 if your other
    settlement does, +0.3 ore/wheat city-engine premium). Advisor shows a `⚓ 2:1 ore` tag.
    Replaced the schema-dump with `reportPortsOnce` (logs "⚓ Ports decoded: …").

**Note (at the time):** `CLAUDE.md` was stale (still described the v1.1 "protocol unknown"
state). → Resolved in §12: it was **deleted** in favour of this file.

---

## 12. CLAUDE.md deletion + UI refinements (v1.12 → v1.13)

**"Why regenerate CLAUDE.md?"** — Explained that `CLAUDE.md` is the doc a fresh Claude session
auto-loads, but it was frozen at v1.1 ("protocol unknown", referenced deleted functions like
`catanSetBoard`/`processDiceEvent`) so it was worse than nothing. Since `CONVERSATION.md` is a
fuller, accurate record, the decision was to **delete `CLAUDE.md`** (not regenerate) and treat
this file as the single source of truth.

**UI refinements batch 1 (v1.12):**
- **Development Cards** — removed the "14 knight / 5 VP / …" remaining line; moved the
  `N in deck · M bought` summary to small text on the far right of the section header
  (`#devDeckState`). The boxes now show **played counts** in one row (`renderDevCards`).
- **Next Roll Odds** — removed the "Live balanced-dice model ✓ · bars = …" note line entirely
  (`#diceNote` deleted).
- **Opponent Hand** — dropped the HIGH/MED/LOW confidence badge and the big "cards total"
  block; the exact **card count now sits on the far right of the header** (`.hdr-count`).
- **Total-rolls bug** — the "X rolls" count was reading `state.rolls.length`, an array trimmed
  to 30 for the last-rolls strip, so it froze at 30. Added an uncapped `state.totalRolls`
  (used by the header + footer + hot/cold ratio). Confirmed the captured game had **71 rolls**.

**UI refinements batch 2 (v1.13):**
- **Knight counter** — added a **KN** box to the Dev row (now KN · RB · YOP · MONO played counts).
- **7-risk boxes** — "7 on YOUR roll" / "7 on OPP roll" laid out on a **single line each**
  (shorter boxes; same green/red).
- **Game-tab reorder** — Placement Advisor · Dice Distribution · Next Roll Odds · Opponent Hand ·
  Turn Coach · Dev Cards · Last Rolls (`renderAll` order matched to DOM).
- **Setup Advisor lifetime** (requested) — it used to vanish as soon as settlements were placed.
  Now it **persists through my last setup road**: tracks my settlement placement order
  (`state.setupMySettles`, set from new corner-ownership while `rolls===0`) and `player.roads`,
  and walks the phases settlement#1 → road#1 → settlement#2 → road#2, aiming each road from its
  just-placed settlement, hiding only once both roads are down. Validated the exact 4-step
  lifecycle by replaying the capture (I was P2 / first player; last road was the final setup act).

---

## 13. Post-game Review coach (v1.14)

Recovered the auto-saved captures from `~/Downloads` (Chrome keeps the file but renames it
to a UUID after the download-history erase — the schema is still `catan-capture/v1`). Used a
real 1819-message game to build and **validate** a full post-game analyzer.

**New protocol fields discovered/confirmed (all from the game-start `gameState`):**
- `mechanicRobberState = {locationTileIndex, isActive}` — robber position (index into `tileHexStates`).
- `playerStates.<c>.bankTradeRatiosState = {1..5: ratio}` — per-resource trade ratio; `2` = a
  2:1 port for that resource, `3` (all five) = a 3:1 generic port. **Directly reveals ports held.**
- `mechanicLongestRoadState.<c> = {longestRoad, hasLongestRoad}` · `mechanicLargestArmyState.<c> = {hasLargestArmy}`.
- `mechanicSettlementState/CityState/RoadState.<c> = {bank…Amount}` — pieces left in reserve.
- `playerStates.<c>.victoryPointsState` (sparse; unreliable → VP computed from buildings+awards+own VP cards instead).
- `type-45 {playerColor}` = winner. `type-47 {cardsToBroadcast, distributionType}` per player (0=setup, 1=roll).

**Analyzer (`reviewAnalyze`, pure/geometry-independent; validated in a VM sandbox vs the real game):**
- **Result & VP** — winner + my VP (buildings + longest road + largest army + my dev VP cards); opp visible VP.
- **Opening grade** — ranks each of my setup settlements among the *legal spots available at that pick*
  (reconstructed from setup placement order) → "best available" or regret vs the best spot.
- **Dice luck** — timing-independent: weights the actual roll distribution by my *final* board vs fair
  (`Σ rollCount·fp / (rolls·Σ P·fp)`). Chosen because corner ownership only arrives in periodic
  snapshots, so roll-time footprint lags (real income 92 > roll-time-fp 59 in the test game).
  Actual resources collected come from the authoritative `type-47` sum.
- **Hand/7s** — cards lost to 7-discards (both totals are exact), times over the limit, steal ledger.
- **Ports/trades** — ports held (from `bankTradeRatiosState`) vs trades made (flags an unused 2:1).
- **Economy/dev** — buildings, dev plays, awards.
- **Takeaways** — prioritised, specific coaching (opening, luck, production gap, port use, hoarding, awards).

UI: Review tab now has **🔍 Analyze last game** and auto-runs on game over (`type-45`). Report renders
as compact sections with a Takeaways block on top. Validated on the real game: won, textbook opening
(both picks #1), out-produced 92–71, opponent leaned on 2:1 ports (15 trades vs my 3), opp had Longest Road.

**Note:** `CLAUDE.md` was deleted — `CONVERSATION.md` is the single source of truth.

---

## 14. Setup Advisor readability + fallback rework (v1.15)

After more games, the advisor read as cluttered and its plan was fragile ("you give me one
spot and one out — what if the opponent takes my out?"). Reworked each recommendation card:
- **Removed** the `Gives wood, wheat` line and the separate port-explanation line (declutter).
- **Road line** reformatted to one line: `🛣 Road → to <target>[ & <port>] (Safe|Contestable)`.
  `roadAdvice` now collects every legal expansion corner across all directions, returns the best
  as `toward` plus an `alt` **backup** (first non-adjacent runner-up) — shown when Contestable.
- **#4 fallbacks (first pick only):** `fourthPickSim` now returns `my4` + `my4Fallbacks` (top 2
  spots that stay legal if the opponent grabs my #4 — i.e. excluding my4 and its neighbours,
  since the distance rule would forbid them). Rendered as `↳ if taken → A · B`. Second-pick
  (back-to-back) keeps the simple `Pair with …` line — no fallback needed there.
- **Divider** (`.adv-div`) separates my plan from the dim `Opp likely grabs: …` line.
- Validated by replaying a capture to the first-pick state (P2/first player): fallbacks are
  correctly non-adjacent to the taken target.

Helper `clean(s)` strips the ` ⚓<port>` tag from a corner label and re-appends it as `& 2:1 X`.

---

## 15. Game Archive — dataset foundation for a learning advisor (v1.16)

Goal (user): compile 100+ games to train a self-learning placement advisor that accounts for
board, first/second pick, and position — beyond the current pip/scarcity heuristic. First step
built: **durable per-game storage + a clean dataset export** (the corpus everything else needs).

- **Auto-archive on game over** (`type-45`) and a **Scan buffer** button: `archiveCompletedGames`
  splits the durable capture by `gameSettings.id`, and for each completed game not yet stored,
  builds a serializable record and saves it to `chrome.storage.local` under key `catanGames`
  (unlimitedStorage → survives the 40k rolling-capture rollover). Dedup by game id.
- **Raw per-game JSON** also written to `Downloads/catan-games/game-<id>.json` (stable name,
  overwrite) via `saveRawGame` — preserves full messages so features can be re-derived offline
  as the model evolves.
- **Record schema** (`buildGameRecord`, ~5KB each, validated fully-serializable on 12 real games):
  identity/playOrder/amFirst, winner/iWon, turns/rolls/rollCounts/sevensBy, luckMe/luckOpp,
  steals, awards, per-player {setts,cities,realIncome,trades,devPlays,ratios}, **opening** (per my
  setup pick: my pick + rank + regret + best + **top-8 candidate choice-set**), and **board** (raw
  hexes/corners/ports). The candidate choice-sets + outcome are what a learning-to-rank / value
  model trains on.
- **Export dataset** button → one `catan-dataset/v1` JSON (all records) for the offline pipeline.
  Archive UI (record count, W/L, 1st-pick count, recent games) lives in the Review tab.
- Cross-machine: `chrome.storage` does NOT sync — the **exported dataset JSON + the raw game
  files are the portable corpus**. Export on each machine and pool them.

**ML roadmap (discussed; not yet built) — the "beast" plan:**
- *RL reality check:* true self-play RL (AlphaGo-style) needs a **Catan simulator** we don't have,
  and 100 human games is orders of magnitude too little to train RL directly. Not the first tool.
- *Our edge:* we decoded the balanced-dice model + exact production, so we can compute
  **luck-adjusted outcomes** — clean training targets from few games (single-game W/L is mostly dice noise).
- *Pragmatic path:* (1) this data foundation → (2) offline Python featurise+label (per candidate
  spot: pips, scarcity, port synergy, diversity, 6/8, draft position, board lean, contestedness +
  interactions) → (3) learn the ranker weights via regression / gradient-boosted trees, backtest
  advisor-vs-my-picks, export learned weights back into the extension → (4) *later* build a 1v1
  simulator + MCTS/search for true lookahead. Training is OFFLINE (Python); the extension collects
  data and runs the lightweight learned model at pick time.

---

## 16. Offline learning pipeline — decision + `ml/` scaffold

Discussed how to build a self-learning placement advisor. Decisions (user):
- **Training env: offline Python** (pandas/scikit-learn). The extension collects data + will run
  the *trained* weights; heavy training is offline.
- **Target: luck-adjusted production** — `real_income / (luckMe/100)`. Removes dice noise so the
  signal reflects opening/engine quality (what placement controls), not fortune. Clean from few games.
- **Direction: data-tuner first** (corrects the current heuristic's weights from real games),
  NOT the simulator yet. Considered a self-play simulator (we have the validated dice model) —
  agreed it's the highest-ceiling path but a big build, and its value is gated by BOT policy
  quality (garbage bots → garbage opening values), so deferred to a later phase.

Built `ml/` (lives in the OUTER folder, not part of the extension):
- `features.py` — pure-stdlib feature + target extraction from a `catan-dataset/v1` export
  (dedupe by gameId; features = opening profile: pips, resources covered, 6/8, ports, diversity,
  amFirst, heuristic score; target = luck_adj_production).
- `analyze.py` — dependency-free report (correlations, 1st-vs-2nd, heuristic backtest). Runs today.
- `train.py` — gradient-boosted + linear models → `learned_weights.json` with **suggested
  per-resource weights** that map onto `base` in `buildBoardGeo`. Needs `requirements.txt`.
- `README.md` — workflow, sample-size table (<25 plumbing · 40–50 first trust · 100+ tuned).

Validated `analyze.py` on the 12-game corpus: runs clean; early directional hints (n_res +0.49,
covers_brick +0.46 vs production) and a heuristic backtest `corr(my_regret, production) = −0.52`
(when you deviated from the advisor you produced less → today's heuristic isn't bad). All caveated
as too-few-games. `train.py` syntax-checked (libs not installed here; user installs offline).

**Cross-machine:** pool the exported `dataset-*.json` from both machines into one folder and run
the scripts on all of them (records dedupe by gameId).

**First analysis run (51 games, v1.22):** `covers_wheat` was the strongest production predictor
(+0.20) — data-backs the wheat weight bump. `amFirst` +0.21 vs winning; `covers_ore` −0.19 vs
production (ore weak without wheat — watch the ore nudge). Counterintuitive signals (total_pips
−0.21 / n_6or8 −0.19 vs win) treated as NOISE at this sample; one `production=0` outlier present.

**50-game BASELINE train (`train.py`, snapshot in `ml/learned_weights_51games.json`):**
- **Cross-validated R² = −0.83** → model NOT predictive out-of-sample yet (memorising noise). Do NOT
  apply the raw weights. This is the baseline to compare against a ~100-game run (watch R² climb).
- Robust/consistent: **wheat strongly + (coef +5.35, suggested 1.36)**; `heuristic_score` dominant
  (importance 0.50 — current formula has real signal); `amFirst` +.
- Surprise: model wants **ore DOWN hard** (coef −7.70, suggested 0.70) and sheep down (0.75) —
  reads as "ore is dead without wheat" (good theory). Suggests my ore bump 1.15→1.18 was the wrong
  direction; the ore+wheat synergy bonus is the right lever, not a flat ore premium. BUT confounded
  by collinearity + negative R² → NOT actioned.
- **No plugin changes made** (user's call). Re-run at ~100 games; if R²>0 and ore-negative holds,
  revert the ore bump (~1.0) and keep the wheat premium + synergy.
- Installed pandas 3.0.3 / scikit-learn 1.9.0 / numpy 2.5.1 (global, Python 3.14) to run train.py.

---

## 17. Flatten folder + simplify the saving flow (v1.17)

Per user feedback (too many manual steps; wanted one folder + a count):
- **Un-nested the project.** Moved the inner `catan-extension/catan-extension/*` up one level so
  `manifest.json` sits at the top of `<your>/Desktop/catan-extension/`. Load THAT folder.
  (`ml/` + `CONVERSATION.md` live alongside; Chrome ignores them.)
- **One saved-games folder.** Games now auto-save (on game over) to
  `Downloads/Catan saved games/game-<id>.json` as the compact **structured record** (was raw
  messages in `catan-games/`). This single folder IS the corpus — the Python reads it directly.
- **Removed the manual dance.** Dropped the **Export dataset** and **Clear** buttons. The routine
  is now just *play*; a one-time **"Save games in memory"** button catches games already buffered.
  The offline pipeline reads `game-*.json` straight from the folder (no export/merge step), and
  you can drop another machine's `game-*.json` into the same folder to pool.
- **Live count in the Review tab.** Next to *Analyze last game* there's now **"N games saved"**
  (this machine's archived count). At ~50, run `train.py`.
- Pipeline updated: `features.load_dataset` accepts per-game record files (and old bundles),
  `default_paths()` globs the new folder; `analyze.py`/`train.py` auto-read it. Validated on
  synthetic per-game files (real corpus was cleared from Downloads; will rebuild from play + the
  user's Windows games).

Why the steps existed before (answered for the user): the old flow used `chrome.storage` (can't be
read by Python) + an Export button to bridge to disk; "Scan buffer" caught pre-existing games.
Now that games write straight to a readable folder, only *play* + a one-time catch-up remain, and
Python reads the folder. Training results (`learned_weights.json`) do NOT auto-apply — that's a
deliberate manual step where the weights get swapped into `buildBoardGeo` and re-validated.

---

## 18. Turn Coach rework + Review polish (v1.20)

- **Opponent hand:** removed the per-resource bar; tightened spacing (`.opp-note` only spaces when non-empty).
- **Dev cards:** removed `.dev-top` bottom margin so top/bottom padding match.
- **Turn Coach — now genuinely smart** (was a static list + spurious 4:1 hints). Removed the card-count
  and Build-VP lines. Gives **ONE concrete step** chosen by value AND context:
  - Added **road/edge tracking** (`state.edgeOwner` + `geo.edgeCorners` via `EDGE_OFF`) → `myNetworkCorners`,
    `reachableSettleNow` (only suggest settlements my roads actually reach), `bestExpansion` (road target).
  - Added `myResProd` (expected cards/roll per resource from my buildings) + opponent 7-risk
    (`dicePredict(opp)[7]`). `decideHoldOrTrade`: default **HOLD** (a 4:1 wastes cards) unless a discard
    threat looms (over limit + opp 7 ≥13%) or a build is genuinely stuck on a resource I don't produce.
    Validated: "5 brick / 1 sheep / 1 wheat, I produce wood, low 7" → **"Hold — build next turn"** (the
    exact dumb-4:1 case the user flagged); over-limit + high-7 → trade to build before the robber.
- **Review "Opening" now matches the live advisor** — `reviewGeo`/`reviewScoreCorner` were simplified
  (raw pips, no board weights); replaced with the SAME adaptive weights + bonus/port logic as
  `buildBoardGeo`/`scoreCorner`. Reworded to **per-pick boxes**: "1st pick / 4th pick: your <spot> ranked
  #R/T — better pick was <spot>" (or "you took the best spot ✓"). Added `pickNo` (position 1..4 in the
  overall setup order) + `matched` flag + `ordinal()`. The **"#R/T"**: T = legal open corners at that pick,
  R = your pick's rank among them by advisor score.
- **Saved Games section** made a collapsible `<details>` (collapsed by default).

Note: the 14 already-saved records were built with the OLD (simplified) opening scorer; they'll be
regenerated with the aligned scorer as new games accumulate (raw captures for the old 14 are gone).

---

## 19. The 111-game analysis arc (v1.21 → v1.35) — narrative

*(The version table below has per-version specifics; this ties the recent arc together thematically,
since it's the most substantive part and where a reviewer's opinion is most useful.)*

**(a) The weight-tuning saga (v1.22–v1.27).** Once real games accumulated, the placement advisor's
resource weights were re-tuned repeatedly off user examples: wheat was under-valued (v1.22, bumped to
1.30 + a strong-wheat reward), then **over**-valued (v1.24 keystone fix over-corrected → advisor
suggested wheatless-then-wheatless picks), then ore needed symmetric protection (v1.25 ore-security),
then the whole thing was **over-buffing wheat multiplicatively** and ranking 9-pip wheat corners over
a 12-pip ore powerhouse (v1.27 "production-dominant rebalance" — tightened the weight band, killed the
additive wheat bonus, shrank every bonus). Lesson that recurs: **stacked multiplicative bonuses produce
pathological rankings**; keep pips leading and weights a gentle tilt.

**(b) The offline ML pipeline and the honest R² story (v1.16, v1.26, v1.30).** Built `ml/` (features →
`analyze.py` dependency-free / `train.py` GBM+linear → `learned_weights.json`). Target = **luck-adjusted
production**. Ran it at 51 / 75 / 100 games. The blunt result every time: **cross-validated R² stayed
negative (−1.78 → −0.73 → −0.29)** — the model cannot predict engine quality from the opening out-of-
sample, so we **never blindly adopted its weights**. Only ONE stable, multiply-corroborated signal was
actioned (ore-alone is weak → v1.26 ore base 1.18→1.0). The trainer *also* kept saying "lower ore,"
which we later learned was an **artifact** (see (c)). `ml/compare.py` regenerates the 50/75/100 trajectory.

**(c) The cities bug and the 15-VP realization (v1.30).** Diagnosing "why so many losses," we found
`me.cities` read **0 in 95/100 games** — impossible next to `setts:6–8`. Root cause: a settlement→city
upgrade arrives as a diff carrying only `buildingType:2` (owner omitted); `reviewAnalyze` bailed on
`owner==null` and dropped every upgrade. Fixed → cities/game 0.00→2.56. This **flipped the ore verdict**:
with the city payoff finally counted, **≥2 cities → 47% win vs <2 → 14%**; the trainer's "ore is bad"
was because the luck-adjusted-**production** target is structurally blind to ore's payoff (cities). Also
confirmed the user **always plays 15-VP / discard-at-10** — a mode where the city/dev engine matters MORE,
so ore was NOT lowered.

**(d) Second-seat & the joint pair optimizer (v1.29, v1.31).** Win rate split was **60% first vs 42%
second**. The advisor's 2nd-seat branch was *greedy* (best single spot + bolt-on complement); rebuilt as
a **joint pair optimizer** (`scoreOpeningPair`/`rankOpeningPairs`, shared by live + Review) since the
2nd player's real edge is coordinating the back-to-back #2/#3 pair. Also fixed the Review falsely flagging
order-swapped picks as misses (v1.29). Validated on 28 raw 2nd-seat games.

**(e) The reckoning — the analyses that reframed everything (v1.32).** The user reported losing more
"since we built this plugin." Checked honestly: **win rate declined 56%→40% chronologically, luck flat**
— real, not dice. A turn-coach retro over 54 raw games showed **the coach coaches the wrong things**
(its topics correlate ~0 with winning; the ignored engine levers dominate). And the user's own
**board-archetype thesis validated** (win 52% OWS vs 46% road/balanced; user over-indexes OWS on road
boards). This set the agenda: mid-game coach + board-aware placement.

**(f) Board-archetype placement + the scarcity removal (v1.33–v1.34).** Added `boardArchetype(resPips)`
→ classifies ows/road/balanced and leans weights INTO the board's strong axis, with a board-read banner
atop the advisor. First pass multiplied base × scarcity × lean and produced **incoherent** effective
weights (wood≠brick; sheep below brick on an OWS board) because the per-board scarcity term fought the
archetype. Fix (v1.34): **dropped scarcity entirely** — weight = base × archetype-lean — so weights are
board-independent and predictable (wood always = brick; OWS resources always outrank road resources on
OWS boards). Coverage of scarce/lacking resources is left to the complement + ore/wheat-security bonuses.

**(g) Data hygiene + UX (v1.21, v1.28, v1.33, v1.35).** Hardened `content_bridge.js` against the MV3
"context invalidated" error; unified empty states; added a **save toggle** (OFF ⇒ test games aren't
persisted) and later moved it into the header, removing the redundant Reset button. Backfilled the 43
raw-backed records with corrected cities.

**Current open threads:** (1) build the mid-game engine coach (agreed next); (2) finalise the
archetype lean values from the user's test games; (3) the deferred second-seat mid-game tempo/denial
nudges; (4) the long-term question of a self-play simulator vs continued rule-based tuning.

---

## Confirmed protocol reference

- **Message envelope:** `{ id:"130", data:{ type:<n>, payload:{ diff:{…} | gameState:{…} } } }`.
  `type 91` = game-state diffs.
- **Game-start snapshot:** `payload.gameState` with siblings `payload.playerColor`
  (authoritative "me"), `payload.playOrder` (setup order), `payload.gameSettings`
  (`cardDiscardLimit`, `victoryPointsToWin`, `diceSetting`, `id`). Board in
  `gameState.mapState` (`tileHexStates` / `tileCornerStates` / `tileEdgeStates` / `portEdgeStates`).
- **Resources:** `1=wood 2=brick 3=sheep 4=wheat 5=ore`, `0=hidden`.
- **gameLogState `text.type`:** `10` roll · `47` resource dist · `4` setup build · `5` main
  build · `116` bank/port trade · `14`/`15` steal · `20` dev played (`cardEnum`) · `21` YoP ·
  `86` monopoly · `45` game over.
- **Dev deck:** 25 (14 knight / 5 VP / 2 road-building / 2 year-of-plenty / 2 monopoly);
  `mechanicDevelopmentCardsState.bankDevelopmentCards.cards.length` = exact remaining.
- **Placements:** `mapState.tileCornerStates.<id> = {x,y,z, owner, buildingType}` (1=settlement, 2=city).
- **Ports:** `mapState.portEdgeStates.<id> = {x,y,z,type}` — 9 ports. `type 1` = 3:1 generic;
  `type n` = 2:1 for resource enum `n-1`. Edge `(x,y,z)` borders hex `(x,y)` + hex `(x+dx,y+dy)`
  (`z0→(0,-1) · z1→(-1,0) · z2→(-1,1)`); its two corners share both hexes. Validated vs trades.

---

## Version history

| ver | change |
|---|---|
| 1.1 | starting point |
| 1.2 | capture logger + `downloads` permission |
| 1.3 | stability: bounds-checked decoder, time-sliced queue, render coalescing |
| 1.4 | Public Sans (bundled), bigger fonts, contrast, per-player 7s |
| 1.5 | capture moved to background (durable), 60 s save only during active games |
| 1.6 | balanced-dice "Next Roll Odds" engine |
| 1.7 | snapshot: identity via `playerColor`, discard limit, board stored; dev deck tracker |
| 1.8 | Setup Advisor (opening-pick ranker) |
| 1.9 | Advisor: 2–3 dropdowns, "likely #4", road direction + cut-off logic |
| 1.10 | dev enums fully mapped; opponent-hand bug fixed (YoP/mono/reset/reconcile); Turn Coach |
| 1.11 | robber placement advice (Turn Coach); ports decoded + scored in Setup Advisor; Strategy tab scrapped → "Review" reserved for post-game coach |
| 1.12 | deleted stale CLAUDE.md; UI polish — Dev section shows RB/YOP/MONO **played** counts (deck/bought → header), removed the Next-Roll-Odds note, opponent card count moved to header (dropped confidence badge + big total), fixed total-rolls display (was capped at 30 via `state.rolls`; now uncapped `state.totalRolls`) |
| 1.13 | added Knight (KN) played counter; 7-risk boxes → single line (shorter); Game-tab reorder (advisor · dice · odds · opp · coach · dev · last rolls); **Setup Advisor now lives through my last setup road** — tracks my settlement order (`setupMySettles`) + `player.roads`, guides each road from its just-placed settlement, hides only after both roads are down (validated 4-step lifecycle vs capture) |
| 1.14 | **Post-game Review coach** in the middle tab — replays the durable capture and grades opening / dice luck / production / hand-7s / ports / dev + takeaways; new fields decoded (robber tile, trade ratios, awards, winner); analyzer validated end-to-end in a sandbox vs a real game |
| 1.15 | Setup Advisor rework — cleaner cards (dropped "Gives"/port lines), one-line road `→ to X & port (Safe/Contestable)` with a backup, **#4 fallbacks** for first pick (legal if opp grabs my #4), divider before "Opp likely grabs" |
| 1.16 | **Game Archive** — durable per-game storage (chrome.storage + raw JSON to Downloads), auto-archive on game over + Scan-buffer, serializable records (board + candidate choice-sets + luck-adjusted outcome), Export-dataset for the offline learning pipeline |
| 1.17 | **Flattened** the project (manifest at top, no double-nesting); games auto-save as records to one folder; removed Export/Clear buttons; **"N games saved" count** next to Analyze in the Review tab; ml pipeline reads the folder directly |
| 1.18 | Matched the save folder to the user's **`Downloads/Catan saved games/`** (extension + ml paths). Converted the 145 overlapping capture snapshots pooled there → **12 distinct complete-game records** (13 games, 1 partial) via the JS analyzer; validated `analyze.py` reads them |
| 1.19 | **Fixed downloads landing as UUID files at Downloads root** — Chrome ignored the `filename` suggestion for blob URLs, so added a `chrome.downloads.onDeterminingFilename` listener in background.js (side panel queues the path via `QUEUE_DOWNLOAD_NAME`; forced FIFO). **Removed the 60s rolling auto-capture** (the file-every-minute flood) + the hidden-panel save; games persist as records on game over only. Cleaned root (deleted 24 capture files, moved 2 stray records in). Corpus now **14 clean records** in the folder |
| 1.20 | **Smart Turn Coach** (one context-aware step; hold-vs-trade using production + 7-risk + road-network reach; no more spurious 4:1); opponent-hand bar removed + spacing; dev-card padding; **Review opening now matches the live advisor** (aligned scorer) + reworded to per-pick boxes with ordinals; Saved Games section collapsible |
| 1.21 | `content_bridge.js` hardened against the MV3 **"Extension context invalidated"** error — orphaned content scripts (in tabs open when the extension is reloaded) now go quiet via a `chrome.runtime.id` check + try/catch instead of throwing on every WS message. Always hard-refresh colonist.io after reloading the extension |
| 1.22 | **Wheat undervaluation fixed** in the opening ranker — diagnosed on 51 real boards (15/51 had the #1 pick lacking strong wheat while a strong-wheat spot was within 10%). Wheat base weight 1.15→1.30 (highest), added strong-wheat reward (`wheatPips×0.35`) + ore+wheat city-engine synergy (+0.8), ore 1.15→1.18. Applied to BOTH `scoreCorner` and `reviewScoreCorner`. Result: #1 pick has wheat 48/51 (strong 40/51), non-wheat only when genuinely dominant. **Corpus now 51 games** (added Windows raw capture → 17 new records) — at the ~50 training threshold |
| 1.23 | **Raw games now preserved** for the future Turn Coach learner — `saveGameRaw` writes each completed game's full messages to `Catan saved games/raw/game-<id>.json` (schema `catan-game-raw/v1`) alongside the small record (staggered 300ms so the onDeterminingFilename FIFO doesn't race). From raw we can replay per-turn advisor-suggestion-vs-my-action with ANY coach version. NOTE: the existing 55 records have NO raw (captures were converted+deleted earlier) → Turn Coach corpus starts fresh from now. Verified robber-on-a-7 advice intact. **55 games.** |
| docs | **`CATAN_1V1_PRIMER.md` rewritten as v2 (2026-09-16).** Brought up to date with everything since the v1.40-era original, and — importantly — it now **explicitly corrects the claims it used to repeat** rather than quietly editing them: the cities/army/dev/road correlations and the "<2 cities → 14% win" line were **concession artifacts** (39% contamination), and the "56%→40% decline" was **not significant** (p=0.10; seat-mix artifact). New/changed content: the **13-VP building ceiling** (5 settlements + 4 cities = 13 < 15, so dev VP or an award is structurally mandatory — the sharpest argument for the ore/wheat/sheep tilt); real win composition from **decided games only** (97% held ≥1 VP card, 85% 3-4 cities, 70% largest army, 67% longest road); the retired hard archetypes replaced by the **continuous board lean** (11/18 neutral, 1.5σ half-width) with interpolated weight endpoints; the **v1.50 architecture** (weights price production only, pair-level soft terms, engine **gate** with STRONG/WEAK/FRAGILE/**MISSING** and scale-aware allowances); **starting-card tempo** (only the 2nd settlement grants cards → pair order matters); why the pair-opportunity lean is **disabled**; the seat split as the **only** robustly surviving claim (Fisher p=0.023); and the power limit (singular design matrix, ~2,200 games to detect +3pp → weight tuning is unfalsifiable at n≈111). Ends with six reading rules for any future analysis. |
| repo | **Project published to GitHub — `github.com/anirvdh/catan-companion` (public).** Initialised git at v1.62 and pushed 43 files on `main`. **Deliberately excluded and gitignored:** all game data (the 171 saved records + raw captures live in `~/Downloads/Catan saved games/`, are ~60 MB, and the raw ones are irreplaceable — see the never-delete-raw rule), `.claude/settings.local.json` (machine-specific paths), `__pycache__`, and `tools/timeline_cache.json` (a regenerable derived cache). `tools/setup_fingerprint.json` IS committed — it is the regression baseline for the opening advisor, not an output. Three local-path lines in this changelog that leaked machine usernames were genericized **before** the first commit, so they never entered git history. Commit authored as `anirvdh` via GitHub's noreply email using repo-LOCAL git config, leaving the global identity untouched for other projects. **Added three documentation files to make the changelog discipline a rule rather than a habit:** `README.md` (overview, install, verification commands, doc index), `CONTRIBUTING.md` (the full workflow — verify against real captures → record in CONVERSATION.md with before/after numbers → bump the correct version constant → commit; plus the non-negotiables and the protocol-traps table), and `CLAUDE.md` (loaded automatically by Claude Code in this repo, encoding the same rules so future sessions follow them without being told). Standard set explicitly: "fixed a bug in city tracking" is not acceptable; "live city count matched truth in 8/60 games, now 342/342" is. |
| 1.62 | **The city-upgrade diff trap — fixed in the LIVE path (it bit twice).** User reported the Turn Coach saying "Build your engine toward your first city" long after they had built a city. Root cause: a settlement→city upgrade arrives carrying only `buildingType: 2` with **`owner` omitted** (the owner didn't change, so the diff doesn't repeat it), and `processStateObject` required an owner before recording the corner — so **every city upgrade was silently dropped from live state**. Measured on 60 replayed captures: live city count matched end-game truth in only **8/60** games. **This is the exact bug fixed in `reviewAnalyze` back in v1.4x and documented in the primer as a known trap — the live path never got the fix.** Three symptoms, all user-visible: (1) the objective read "toward your first city" for the entire game; (2) `bestCityTarget` reads `myBuildings(1)`, which still contained upgraded corners, so the advisor offered to **build a city on a corner that was already a city**; (3) `myResProd` weighted cities ×1 instead of ×2, under-reporting production and skewing both the bottleneck and the engine-tier ranking. Fix resolves `owner` AND `buildingType` from the previous known corner state whenever the diff omits them (mirroring the reviewAnalyze fix). **Now 342/342 player-slots match end-game piece counts**, and "toward your first city" drops from effectively every engine-tier objective to **35% of sampled objectives** (the genuine early game), with the rest correctly progressing to production growth, the Largest Army push, and closing out. Added a **permanent assertion** to `tools/winpath_check.js` (live settlements+cities == end-game counts) plus an e2e guard (objective never says "first city" when a city exists — 0 violations in 1,484 calls), so this cannot regress a third time. Replay/schema untouched (reviewAnalyze was already correct); scorer untouched (`v1.50`/`ee784b36`). |
| ui | **Dice sections merged into one content switcher.** "Dice Distribution" and "Next Roll Odds" became a single section with a segmented control (Roll odds · Dice distribution). Dropped the `deck N/36 · reshuffle in N` readout (the reshuffle LOGIC is untouched — `MIN_RESHUFFLE` still drives the balanced-dice prediction, it's just no longer displayed). The roll count moved into the shared header and shows **only** when Dice distribution is selected. Underlying charts (`oddsChart`, `sevenRisk`, `diceChart`) and their render functions are unchanged — they just live in two swapped panes. Verified in-browser against the real markup/CSS: pane visibility, active-pill state and header meta all toggle correctly. |
| 1.61 | **Win-Path panel — the Turn Coach becomes score-aware.** Replaced the fixed priority ladder (city>settlement>dev>road), which gave identical advice at 3 VP and 14 VP, with a tiered engine reading the live score of BOTH players: `win` / `win-maybe` / `defend` / `closing` / `engine` / `fallback`. **Stage 1 (live state):** wired five fields that were already arriving in the stream but parsed only by the offline reviewer — `victoryPointsState`, `mechanicLargestArmyState`, `mechanicLongestRoadState` (which also carries each player's **road chain length**, so the Longest Road race needs NO graph search), `mechanicRobberState`, `bankTradeRatiosState` — plus per-colour knight counts from log type-20 (`state.dev.played` is deck-wide and unusable for the LA race) and my own dev-card enums (revealed for my colour; the opponent's are all enum 10). **Every one of these arrives as a PARTIAL DIFF and must be merged, never replaced** — naive last-value tracking reads a player truly on 15 VP as **3**; merged cumulatively, my live VP matches end-game truth **165/165** and the opponent's matches truth-minus-their-hidden-VP-cards **165/165** (their VP cards are the only thing we cannot see). **Stage 2 (engine):** candidates carry the VP they certainly add, so "does this win?" is a comparison not a special case. Encodes: a city is a **net +1** (it replaces a settlement); **playing a knight already in hand is FREE** and can win outright via Largest Army (evaluated first — the most-missed winning move); awards must be **exceeded, not matched**; taking an award off the opponent is a **4-VP swing**; Longest Road is only chased within 3 segments; bank trades honour live 2:1/3:1 port ratios and spend only genuine spares. **UI shows four rows — OBJECTIVE / BOTTLENECK / DO NEXT / ALTERNATIVE (+ CHANGES IF) — and NO scores**: my VP, the opponent's VP, their hidden-VP estimate and their unplayed-card count all drive the logic and none are printed, because Colonist already shows them. **TWO BUGS FOUND:** (1) **VP categories 3 and 4 were documented backwards** — 3 is Largest Army, 4 is Longest Road; both are worth 2 VP so every total and every arithmetic check was unaffected, which is why it survived; caught by cross-checking against the award mechanic states, 330/330 both ways. (2) **`reviewAnalyze` REPLACED the award mechanic states instead of merging**, and only ~7% of longest-road frames carry `hasLongestRoad`, so **`awards.lrMe` was wrong in 46/165 saved records** (now 0/165) — any past analysis using it is suspect. Corrected per-award stats: **Largest Army 81.2% vs 39.5%, Longest Road 84.8% vs 37.5%**, and LR is common (46/86 decided), not rare as previously reported. **Verification:** 36 decision-logic assertions, live-state check on all 165 captures, 1477 advisor calls on real board geometry with **0 exceptions and 0 score leaks**, and a fingerprinted setup-advisor regression (60/60, 0 drift). Replay bumped to 1.61. **Scorer, weights, board lean and engine thresholds untouched** (`v1.50` / `ee784b36`). New tools: `winpath_check.js`, `winpath_logic.js`, `winpath_e2e.js`, `setup_regression.js`. |
| 1.60 | **Data-semantics audit of the first 66 fresh games — schema clarity, no scorer change.** Fourth external review audited the `Games after v.156` corpus against its own raw captures and found the recording healthy (66/66 on every integrity check, 66/66 unique `sourceHash`, 4,106 rolls with no distributional anomaly) but flagged four semantic ambiguities. All four verified against the data before changing anything, then fixed. **(1) Turn counting:** `turns` (= server `completedTurns`) is `endGame.totalTurnCount - 1` in **66/66** games — turns *finished* vs the turn the game *ended on*. Neither is wrong; both now recorded explicitly as `completedTurns` + `terminalTurnNumber` (`turns` kept as an alias) so no future "average game length" silently mixes them. **(2) Two different winners:** the server designates a winner who can be **behind on VP** when the leader concedes — found in **3/66** games (e.g. 8-7 with the 7-VP player recorded as winner). Added `leader`/`leaderVP` (= `max(finalVP)`) alongside `winner`/`winnerVP`, and **`decided` now derives from `leaderVP >= vpToWin`** ("did anyone reach the target") — strictly more robust, and verified to classify all 66 games **identically** to the old rule. **(3) The "exactly 15" claim was wrong** — the fresh data has a genuine **16-VP winner** (3 setts + 3 cities + 3 VP cards + LR + LA = 16), which is expected since hidden VP cards all reveal at once on the winning turn. Primer corrected from `== 15` to `>= vpToWin` in §12/§14. **(4) `mmrComplete`** flag — 2/66 games (`sail6757`, `path1301`) have one player's MMR null; kept **null, never imputed**, with the flag so strength-controlled analysis self-filters. **Confirmed `scorer: v1.50` is intentional** — it is the scoring-model *family*, independent of the build number; all 66 games carry `v1.50`/`ee784b36` identically, so the run is uncontaminated. `RECORD_SCHEMA_VERSION` 2→**3** (purely additive), `REPLAY_VERSION` 1.56→**1.60**. Added **`ml/features.py::upgrade_record()`** deriving all three new fields for schema-2 records **on read**, so the 66 existing games stay comparable with **zero files rewritten**, and **`tools/replay_check.js`** — a vm-sandboxed harness replaying every preserved raw capture through the current code and diffing against the stored record (all 67 reproduce every stable field byte-identically). Explicitly **NOT** changed, per the review and the power analysis: no weights, engine thresholds, board lean, recipe balance or port scoring — 31 decided games (29 MMR-complete) cannot move any of them. Notable behavioural signal logged for later: **21 of 35 concessions (60%) ended with the user AHEAD on VP.** |
| 1.59 | **Recording integrity audit — the pre-collection safety net.** Third external review asked for integrity checks rather than features; implemented the high-value ones. **`captureIntegrity`** block on every record (rawWritten, rawMessageCount, replayCompleted, boardValid [19 hexes/1 desert/18 numbered], setupValid [4 placements + valid snake], firstRollSeen, rollCount, endGameMessageSeen, captureComplete) plus a hard **`researchEligible`** flag with `researchExclusionReason` (`missing_raw`/`replay_error`/`invalid_board`/`invalid_setup`/`missing_first_roll`/`missing_end_game`) — because a partial capture is valid JSON that replays fine and would otherwise enter the dataset silently. **Negative-tested**: empty → `missing_raw`, 3-message → `invalid_setup`, and critically a capture **truncated just before the end-game message** (full setup, 101 rolls, looks normal) → correctly `missing_end_game`. Added **`sourceHash`** (FNV-1a over raw frame metadata; 138/138 unique → duplicate detection), **`startedAt`/`endedAt`** from raw message timestamps, ordered **`rollSequence`** (verified length==rolls and histogram matches), and **per-settlement detail in `openingState`** (hexes, port, and the advisor's rank/regret AT PLACEMENT TIME, not hindsight). Clarified `capturedScorer` semantics: it is the scorer the player was SHOWN and must be carried forward, never overwritten, if a record is regenerated. All 138 real captures: 138/138 pass every integrity check and researchEligible. Primer gained a capture-integrity subsection in §12, v1.59 rows in §15, and **§16 a 10-point manual QA checklist for the first ~10 fresh games**. Still deferred by agreement: canonical event timeline, regeneration CLI, expected-vs-realized. |
| docs | **Primer restructured into two parts (v2.1).** Part I = the game + scoring logic; **Part II = the data layer**, added at the user's request: **§11 recording pipeline** (interceptor→bridge→background→pure replay→record, what's reconstructed from which message type, the four independently-versioned layers, and the city-upgrade diff trap), **§12 what's in a saved game** (fully annotated record schema + why the `type===45` end-game message is the single most valuable field, with the category→count VP decode and its validation), §13 dataset/never-delete-raw, §14 verification, and **§15 a recording changelog** covering every recording change v1.53→v1.58 with the reason each mattered, the two bugs worth remembering (dropped city upgrades; deleting raw), what was deferred (event timeline, regeneration CLI, expected-vs-realized) and what was skipped (canonical-model layer). Also corrected stale figures in §9/§10 (39%→53% concessions; power caveat). |
| 1.58 | **Corpus reinstated + v1.56/v1.57 validated on real data + primer re-verified.** User restored the deleted games and reorganised into `Games before v1.56/` (111 v1.40-era records + 54 raw, plus `v150/` = 84 records + 84 raw from v1.50-v1.55) and `Games after v.156/` for new games. `CORPUS_DIR` and `ml/features.py` repointed; `features.CORPORA` now exposes three generations (`current` / `v150` / `v140`) since each was graded by a different scorer. **Validated by replaying all 138 raw captures through the current code**: 138/138 replayed clean, end-game payload + both-player MMR + `openingState` recovered on 138/138, **65/65 decided winners land EXACTLY on 15 VP with 0 above** (re-confirming the VP category decode on a set 2x larger than before), `decided === (winnerVP>=vpToWin)` holds, `scorerConfigHash` stable, and setup order verified (P1's 2nd settlement is always pick #4 n=47, P2's always #3 n=37; `seat` always matches `amFirst`). **Key corrected finding: concessions are far worse than thought — 53% overall (v1.50-era 62%, v1.40-era 39%)**, so unfiltered win rate 49% vs decided-only 57%. Win composition re-derived on 65 decided games (was 33): 98% held a VP card, 88% ended 3-4 cities, **95% held at least one award**, avg split 9.8 VP buildings / 5.2 VP cards+awards. Seat on decided games: P1 66% vs P2 48%. Primer updated throughout + new §11 (three-generation dataset, the never-delete-raw rule, version block, `openingState`) and §12 (verification table). Note: the restored raw folder name contains a narrow no-break space (U+202F) — `raw 8.20.24 PM`. |
| 1.57 | **Reproducibility metadata + first-class opening block + the raw-deletion fix.** Narrowed scope after a second external review agreed most of its architecture asks were already met by v1.56. Added a full `version` block to every record (`capture`, `protocolParser`, `replay`, `recordSchema`, `scorer`, **`scorerConfigHash`**) — these four layers change independently, and the hash catches the nasty case where the scorer version is unchanged but its constants were silently edited (FNV-1a, verified deterministic + change-sensitive). Added **`openingState`**: one first-class block with seat, **explicit setup order** (which settlement was placed first, and which one granted starting cards — P1 #4 / P2 #3, so the two placements are not interchangeable), pair pips, numbers, ports, weighted production, board lean, engine class and starting cards. Unit-tested on a hand-built board (no raw games remain to test against). **Critically: fixed the guidance that caused the data loss** — the v1.55 clear-games note told the user to delete `v150/`, which included `v150/raw/`. Both the button note and the Saved Games panel now say to delete only `game-*.json` and **never** `raw/`, and CONVERSATION.md carries it as a permanent top-level rule. Deferred (all derivable from raw, so not urgent): event timeline, offline regeneration CLI, expected-vs-realized analytics. Skipped: the canonical-model abstraction layer — `reviewAnalyze` is already a pure replay. |
| 1.56 | **End-game (`data.type === 45`) capture — ground truth, recording only.** No scoring/weights touched. That message arrives once per game with NO `gameState`/`diff`, so `reviewAnalyze` used to `continue` straight past it and discard it. Now captured: `endGameState` (per-player VP by category, rank, winner flag, `totalTurnCount`, `gameDurationInMS`, `diceStats` histogram, `resourceStats` income/loss breakdown, `activityStats` incl. `resourceIncomeBlocked`) and `rankedUserStates` (**both players' MMR before/after/delta** → opponent-strength control). **Decoded `victoryPoints`**: it is CATEGORY→COUNT, not points — `VP_CATEGORY_POINTS = {0:settlement 1, 1:city 2, 2:VP card 1, 3:longest road 2, 4:largest army 2}`. Verified on 54 raw games: **no winner exceeds 15**, 33 land exactly on 15, and every category max matches the real limits (5/4/5/1/1). A naive sum wrongly flagged 100% of games as concessions. **Concession detection**: `decided = winnerVP >= vpToWin`; **21/54 = 39% of the legacy corpus was conceded** (independently reproducing the earlier finding). Impact: raw win rate 41% vs **decided-only 48%**. New record fields: `endGame`, `finalVP`, `winnerVP`, `decided`, `conceded`, `mmr`. |
| 1.55 | **"Clear saved games" control (clean-slate reset).** Games live in TWO stores: the Downloads folder (what the Python pipeline reads) and the `catanGames` index in `chrome.storage.local` (what the Review tab shows **and** what `archiveCompletedGames` dedups against via `if (idx[g.id]) continue`). Deleting only the files left the index believing those games were saved, so they would **never be re-written** — a silent desync. New 🗑 button in the Saved Games section clears the index (two-step confirm, 5s arm window) and drops the capture buffer, then tells you which folder to delete to finish the reset. |
| 1.54 | **Setup Advisor UI declutter.** All three recommendation cards now render **expanded by default** (were collapsed except #1) so the alternatives are visible without a click; since `[open]` no longer distinguishes the top pick, the accent border moved to a new `.adv-top` class on card #1. **Removed the v1.50 engine/score/why diagnostic line** (`engine STRONG · score 22.3 (prod 20.9 +1.35)` + `why: …`) — it read as clutter and, on first-seat cards, landed awkwardly after "Opp likely grabs". Scoring still drives the ranking; the numbers live in `V151_VALIDATION_REPORT_FINAL.md`. A card is now just: road line (+ backup), then either `#4` + fallbacks + "Opp likely grabs" (1st seat) or "Then take X" (2nd seat). |
| 1.53 | **Corpus separation — v1.50 games no longer mix with the v1.40-era set.** New games save to **`Downloads/Catan saved games/v150/`** (raw to `v150/raw/`) via a single `CORPUS_DIR` constant; the existing 111 games + 54 raws stay untouched in the root. Rationale: the two corpora were graded by **different scorer models** (51% of picks rank differently), so pooling them silently blends two versions into one time series. Records already carry `capturedScorer {version, weights, lean}` as belt-and-braces pinning. Review tab now shows the split (`N on v1.50 · M legacy`) and W/L for the current corpus only. `ml/features.py` gained `default_paths(which='current'|'legacy'|'all')` + `corpus_summary()`; `train.py`/`analyze.py`/`compare.py` accept `--legacy`/`--all` and **always print which corpus they used** (falls back to legacy while `v150/` is empty). **111 legacy games; v1.50 corpus starts at 0.** |
| 1.52 | **Phase A completion — second external review implemented.** The reviewer caught that `V150_VALIDATION_REPORT.md` was **stale** (generated before the final `coverage 0.30→0.28` / `rollCoverage 0.04→0.025` changes) — regenerated as **`V151_VALIDATION_REPORT_FINAL.md`** with a config hash + source hash, and the stale file deleted so two constant sets can never be mixed. **`pairOpportunityLean` DISABLED in live weights** (`opportunityLeanWeight` 0.30→**0.00**, kept as a diagnostic): its `topKMean/mean` normalisation is a **tail-concentration index**, not absolute opportunity — a family that is weak overall but concentrated scores high, which explains the −0.22 correlation with supply and sign disagreement on 56/111 boards. Raising the log scale would have hidden the saturation, not fixed the semantics. **`replaceability` REMOVED** (not zeroed) — 100% zero-rate, 0/111 top-1 changes; true replaceability is state-dependent and belongs in the deferred denial/lookahead phases. **Engine gate reworked:** 4 classes (STRONG/WEAK/**FRAGILE**/**MISSING** — MISSING = lacks wheat or ore entirely) with **scale-aware allowances** (11%/6%/3% of best raw, clamped) replacing the fixed 2.00/1.00; **zero-wheat-or-ore selections dropped 5 → 1**. **Port engine-bridge tightened**: must own the port, be short on wheat/ore, and hold a real tradeable surplus (previously any port scoring >0.70 promoted a pair to WEAK). Misleading `pairPoolTopK: 60` (applied to CORNERS, of which a board has 54 → could never prune) replaced with explicit `P1_FIRST_CORNER_CANDIDATES: 14` / `P2_RESPONSE_PAIR_SHORTLIST: 80` for the deferred lookahead. **Review is now DUAL-VERSION** — the hybrid is gone; each pick graded under both pure v1.40 and current v1.50, both stored, records version-pinned via `capturedScorer`; 51% of historical picks rank differently between models, so aggregates must be version-pinned (the 1.7-vs-1.6 opening-regret figure is a v1.40 number). **§4 ablation ladder OVERTURNED my earlier claim**: I said the weights drove the divergence; controlled one-change-at-a-time shows **pair architecture 52%**, weight system only **13%**, opportunity lean 8% — the reviewer predicted this exact error. **Full port ablation** (additive + bridge disabled) → 0 top-1, 1 top-3, 0 order, 0 gate changes, mean rank shift 2.7 → fails the removal bar, **port retained**. Added corner-**ID-permutation** symmetry test (111/111) alongside iteration-order (111/111). Live-state exhaustiveness confirmed separately from the clean-board 1359 figure (live P2 = 1162 pairs, 0 illegal). Perf p50 **50ms** / p95 52ms. Phases B–D remain deferred. **111 games.** |
| 1.51 | **Phase A hardening from the external review** (`CATAN_V150_COMPLETE_CLAUDE_REVIEW_AND_NEXT_ACTIONS.md`). Three of my own errors corrected: (i) `20×1200×1200` is **28.8 million**, not billion; (ii) a *smaller* lean half-width is **aggressive**, not conservative; (iii) the 14%-vs-2% saturation figures were **different leans** and I hadn't said so — now reported separately (`globalSupplyLean` 16/111, `pairOpportunityLean` 43/111, `finalBoardLean` 2/111). `neutralOwsShare` reverted to the theoretical **11/18** (the empirical 0.6139 is only 0.63 SE away — indistinguishable from noise). **Per-component cap audit found two terms clipped into constants:** `rollCoverage` hit its cap on **90.6% of top-10 pairs** (multiplier 0.04 → **0.025**) and `coverage` on **24%** (0.38 → **0.28**); both recalibrated from the unclamped top-10 distributions — all components now ≤2.4% top-10 cap-hit. Renamed `numberCoverage`→`rollCoverage`, `sync`→`recipeCoProduction` (they measure genuinely different things). Added an explicit **deterministic comparator** (score → raw → engine → tempo → stable id); shuffled corner-iteration reproduces top-1 on **111/111**. **Code-path isolation:** `roadAdvice` was ranking road targets with v1.40 bonuses under the v1.50 flag — fixed. Confirmed **direct P2 selection was already EXHAUSTIVE** (54 corners vs `pairPoolTopK` 60 → the shortlist was a no-op); now documented. Full **BROKEN audit**: all 4 boards are *"a STRONG pair exists but the raw sacrifice exceeds the 2.00 allowance"* (2.28–3.52), not *"none exists"* — gate correct in every case. Generated `V150_VALIDATION_REPORT.md` (§14 report incl. a human-label queue for the 60 disagreements; dominant reason is **rawProduction on 46/60**, so most divergence comes from the weights/lean, not the new soft terms) and `V150_OPEN_QUESTIONS.md` (6 open decisions: dead `replaceability` term, `pairOpportunityLean` correlating **−0.22** with supply lean and saturating 38.7%, Review-mode half-migration, symmetry-test depth, inert `port` term, human labels). Perf p50 **55ms** / p95 60ms / max 72ms (steps 1–12 only). **111 games.** |
| 1.50 | **v1.50 placement scoring implemented** (from `CATAN_COMPANION_V1_50_PLACEMENT_SCORING_SPEC.md`, steps 1–12, behind `PLACEMENT_SCORER_VERSION` flag; v1.40 path kept intact and reachable). Architecture: **resource weights price PRODUCTION ONLY**; convertibility/coverage/tempo/ports/risk/uniqueness are priced by pair-level functions. New: continuous board lean (−1 road … +1 OWS) replacing hard 0.57/0.63 buckets, lerped weight endpoints (wood≡brick invariant enforced), raw production separated from all bonuses, **engine-viability GATE** (STRONG/WEAK/BROKEN — replaces additive security penalties so a productive-but-broken opening can't outrank a real city base), coverage utility (smoothstep threshold, replaces binary diversity/complement), recipe-balance bonus, unique-number coverage, recipe synchronisation, surplus-vs-demand port valuation, **starting-card tempo** (only the 2nd settlement grants cards → pair ORDER now matters; never modelled before), robber-concentration risk, replaceability. Wired into all three setup situations (2nd-seat joint pair, 1st-seat judged by the {#1,#4} pair it leads to, complement pick). UI: continuous lean banner + per-card engine class, score breakdown and "why" reasons. **3 deliberate deviations from the spec, all data-driven:** (a) lean half-width 0.05 → **0.0698** (=1.5σ; calibrated on 111 real boards, mean share 0.6139 — spec's 0.05 saturated 27% of boards at full lean, now 2%); (b) **soft-term scale 0.60 added** — spec's component caps sum to 7.75 vs a 2.50 aggregate cap, so **56% of pairs pinned at the cap** and the soft term became a constant; scaling before the clamp restores discrimination (saturation now 0.3%, p99 2.41, real 0.6–1.0 spread across each board's top-10); (c) replaceability computed in **O(n)** via a top-2-per-resource index instead of the spec's O(n²) (identical result, ~1000× cheaper). Also pruned pair pools (top-60) — the spec's nested P1 lookahead would be ~1.4M pair-scorings. Validated on 111 boards: §25 invariants pass, perf **56ms mean / 69ms max**, engine class of top pick STRONG 106 / WEAK 1 / BROKEN 4, and v1.50 differs from v1.40 on **54%** of top pairs. **Deferred (spec steps 13–17):** road-expansion value, opponent denial, P1 robust minimax lookahead. **111 games.** |
| 1.40 | **Cut extension load to stop the connection drops** (user: colonist WS keeps dropping while playing with the plugin ON — internet itself fine, confirmed on a 2nd device; colonist.io verified UP with 4.3k online). Root suspicion: the always-on capture pipeline bloating the tab until heartbeats miss. Fixes: (a) **b64 raw bytes dropped from every frame** — now only kept for frames that FAILED to decode (was doubling the relayed+stored payload on every message); (b) **durable capture gated on the Save toggle** — in test mode (Save OFF) the background no longer accumulates/persists the buffer at all → extension stays lightweight, live advisor still works via the direct panel relay; (c) **CAP_MAX 40000→8000** (~4-5 games) — far less SW memory; (d) removed the redundant keepAlive periodic `persist()`; (e) removed the per-text-frame `console.log`. Test: play with **Save OFF** on v1.40 — if stable, the capture pipeline was the cause. **111 games.** |
| 1.39 | **Interceptor hardened so it can NEVER block a game from loading** (user reported games not joining/reconnecting). The real socket is now created + returned before any hooking, and every hook step (addEventListener, send override, `window.WebSocket=` install) is try/caught → on any failure colonist keeps an untouched, working WebSocket. NOTE: recent 1.36–1.38 changes were side-panel-only and cannot affect page loading; the likely real cause was orphaned/duplicate scripts after repeated extension reloads without a hard refresh (always disable→enable the extension + open a FRESH colonist tab). Decisive test if it recurs: disable the extension and try to join — loads ⇒ it's us; still broken ⇒ not us. **111 games.** |
| 1.38 | **2nd-seat advisor showed the same pick 3× (regression from the v1.31 pair optimizer).** The top spot pairs well with several partners (A+B, A+C, A+D), so `rankOpeningPairs().slice(0,3)` gave three pairs all leading with the SAME first settlement → three identical-looking cards. Fix: dedupe by lead settlement — keep the best pair per unique `first.id` → 3 genuinely distinct opening plans. Verified 10/10 boards now show 3 distinct lead spots. **111 games.** |
| 1.37 | **Setup road no longer points at your own next pick (full fix).** v1.32 only excluded the 2nd-seat pair's other half; the FIRST-seat #4 (+ its fallbacks) and the live road-placement step for 1st seat were still uncovered, so the road kept aiming at a spot you'd settle for free. Now the road's target-exclusion set includes ALL of your planned setup settlements: (a) pick-cards — 1st seat excludes #4 + `my4Fallbacks`, 2nd seat excludes the pair's other spot; (b) live road step — excludes your simulated #4 (1st seat) or best-complement (2nd seat). `roadAdvice` provably can't return an excluded corner (skipped as route-through AND fails `legalToSettle`), so a setup road now always opens a build-later lane, never "into" a free setup spot. **111 games.** |
| 1.36 | **User-set weights.** Base sheep 0.9→1.0 (wood/brick/sheep now all 1.0 at base; wheat 1.15, ore 1.1 unchanged). Archetype leans back-solved to the user's target effective weights: **OWS** Wo0.92/Br0.92/Sh1.10/Wh1.21/Or1.21 (lean wood·brick 0.92, sheep 1.10, wheat 1.05, ore 1.10); **ROAD** Wo1.20/Br1.20/Sh1.00/Wh1.15/Or1.00 (lean wood·brick 1.20, ore 0.909); **BALANCED** = base Wo1.00/Br1.00/Sh1.00/Wh1.15/Or1.10. Verified exact. **111 games.** |
| 1.35 | **Header cleanup — Reset removed, Save toggle moved to header.** Removed the top-left ↺ Reset button (it did an in-memory `softReset`; user just refreshes colonist.io to re-init the WS, so it was redundant) and its `resetGame` fn + listener. `softReset` KEPT (still fires on new-game detection). Removed the separate save-bar inside the Game panel; the save toggle now lives in the header as "💾 Save game [ON/OFF]" where Reset was. Note: `.btn-reset` is a SHARED generic-button class (Analyze/Save/Clear/etc.) — its CSS was restored after an accidental delete. **111 games.** |
| 1.34 | **Removed the scarcity multiplier — weights are now coherent.** User (correctly) flagged the v1.33 effective weights as incoherent: wood≠brick, and sheep (0.91) fell BELOW brick (1.09) on an OWS board. Cause: weight = base × **scarcity** × archetype-lean, and the per-board scarcity term (rarer=higher) overrode the archetype (docked abundant sheep on a sheep-rich OWS board, boosted scarce brick). Fix: dropped scarcity entirely — **weight = base × archetype-lean** — coverage of scarce/lacking resources is already handled by the complement + ore/wheat-security bonuses. Weights now depend ONLY on archetype (board-independent, predictable): OWS → Wo/Br 0.92, Sh 1.03, Wh/Or 1.21 (all 3 OWS resources above both road); ROAD → Wo/Br 1.20, Sh 0.90, Wh 1.15, Or 0.94; BALANCED → base (Wo/Br 1.0, Sh 0.9, Wh 1.15, Or 1.1). wood ALWAYS = brick now. Lean values tuned (ows sheep 1.15/wheat 1.05/ore 1.10/wood·brick 0.92; road wood·brick 1.20/ore 0.85). Applied to both buildBoardGeo + reviewGeo; reviewAnalyze clean on all 54 raw games. **111 games.** |
| 1.33 | **Board-archetype-aware placement + save toggle.** New `boardArchetype(resPips)` classifies each board by OWS pip-share: **ows** (≥63% → city/dev engine), **road** (≤57% → expansion/longest-road), **balanced** (else). Folded into weights as a two-sided strategic lean (boost the strong axis, trim off-axis) strong enough to actually move the pick past the scarcity multiplier — road boards now lead Brick 1.16/Wheat 1.15/Wood 1.08 (ore trimmed to 1.11, but ore/wheat-security still forces a city base on the complement); OWS boards lead Ore 1.42/Wheat 1.22. Shared by live `buildBoardGeo` + `reviewGeo` (Review matches). New **board-read banner** atop the Setup Advisor showing archetype + plan + pip breakdown (replaces the weak "leaning X" line). Split on 111 boards: 42 ows / 41 balanced / 28 road; user wins 52%/41%/54% (balanced boards are the weak spot). **Save toggle** (top of Game tab, persisted): OFF ⇒ completed games are NOT saved (gates `archiveCompletedGames`) so test games don't pollute the corpus. Lean strengths are the tuning knob for the user's upcoming test-game feedback. Validated: reviewAnalyze runs clean on all 54 raw games. **111 games.** |
| 1.32 | **Road bug fix + honest decline/board analysis (111 games).** Fixed: 2nd-seat setup road was aimed AT the pair's other settlement ("road into your own next pick") — now excludes the planned 2nd spot from road targets in both the pick-selection view and the live road-placement step. Analysis (user reported losing more): win rate DECLINED chronologically **56%→56%→44%→40%** with flat luck (~99-102) — real, not dice; 2nd-seat collapsed 44%→32%. Board-archetype thesis VALIDATED: win 52% OWS-boards vs 46% road/balanced; user over-indexes OWS on every board (opening 60% OWS on 56%-OWS road boards → fighting the board); on OWS boards, OWS-heavy openings win 57% vs 47%. Turn-coach retro over 54 raw games: **the coach coaches the WRONG things** — its focus (hold/trade + 7-defense) has near-zero correlation with winning (overTimes −0.11, robbed −0.01) while the levers it IGNORES dominate: cities +0.37, largest army +0.34 (held 59% W vs 25% L), dev +0.30, longest road +0.26 (18% W vs 3% L). Next builds queued: board-archetype-aware placement + turn-coach rebuild around the winning engine. **111 games.** |
| 1.31 | **Second-seat strategy — joint pair optimizer.** Root issue: win rate 60% as 1st vs **42% as 2nd**; the advisor's 2nd-seat branch was *greedy* (best single spot, then bolt on a complement) instead of optimizing the back-to-back **pair** (2nd's one real edge: picks #2 & #3 with no opp pick between). New shared helpers `scoreOpeningPair` / `rankOpeningPairs` (used by BOTH the live advisor via `scoreCorner` and Review via `reviewScoreCorner`) rank non-adjacent legal pairs by joint value (each corner scored, 2nd crediting the 1st as prior, best ordering) + coordination (guaranteed ore+wheat city engine, resource breadth) + a **moderate tempo lean** (2:1-port-you-feed trade engine, a strong 6/8, minus stacking the engine on one hot number). Live: 2nd-seat first pick now shows the coordinated pair ("Then take X · why this pair: …"). Review: `pairOptimal` check — if your two spots ≈ the best pair (tol 1.0), both grade GREEN ("part of your optimal back-to-back pair ✓") even when neither was the single #1; genuine deviations still flagged. Validated via VM on the real code path over 28 raw 2nd-seat games: 19/28 pair-optimal, **4 non-#1 single picks rescued (2 were wins)**, wins 82% vs losses 59% pair-optimal. Scope: opening only (mid-game tempo/denial nudges deferred). **100 games.** |
| 1.30 | **Cities-capture bug fixed** (the big one). `me.cities` read 0 in 95/100 saved games — impossible against `setts:6–8`. Root cause: a settlement→city upgrade arrives as a diff carrying only `buildingType:2` (owner omitted, already known); `reviewAnalyze` bailed at `cv.owner == null` and dropped every diff-based upgrade. Fix: resolve the owner from the prior settlement record before counting. Validated by replaying the 43 raw games: cities/game **0.00 → 2.56** (dist 0:5 1:2 2:10 3:16 4:10). **Flips the ore verdict** — with the payoff finally counted, **≥2 cities → 47% win vs <2 cities → 14%**; the earlier "ore openings lose" signal was an artifact of not measuring cities, so ore weight was NOT lowered. Confirmed user plays a **15-VP / discard-at-10** mode always (live advisor already reads both from `gameSettings`; only pre-load defaults are 10/7). 100-game trainer: CV R² climbing **−1.78→−0.73→−0.29** (still negative → weights not adopted); win rate **50% overall, 60% as 1st, 42% as 2nd** — second-seat play is the real leak. Added `ml/compare.py` (50/75/100 trajectory tool). **100 games.** |
| 1.29 | Review opening: **order-swap no longer flagged as a miss** — as 2nd player (picks #2/#3 back-to-back, or even 1st player #1/#4) you sometimes take the advisor's two spots in swapped order; the per-pick grader marked one orange. Added `myPickIds` set + `bestTakenByMe` flag: if the advisor's #1 for a pick is a spot I took on my OTHER pick, it shows GREEN ("you took both best spots, just in a different order ✓") and isn't counted in the takeaway. Validated on 31 raw games → 6 order-swaps now green, genuine deviations still flagged. **88 games.** |
| 1.28 | UI: Dice/Odds empty states unified (both 11px, `align-self:center` — same size + centered); Connected/Active status right-aligned (`.header-status` justify center→flex-end); Reset ↺ icon enlarged (15px). Confirmed footer 7-count is organic dice 7s only (knights never touch `player.sevens`). |
| 1.27 | **Production-dominant rebalance** (user: advisor ranking 9-pip wheat corners over a 12-pip ore powerhouse; on `deck4256` wheat weight had ballooned to **1.89** and the double-ore spot sat at **#16**). Root cause: wheat value stacked multiplicatively (base 1.30 × scarcity 0.75–1.5 × lean 1.12) AND an additive `wheatPips×0.35` on top. Fixes: **tighter weight band** (base wood/brick 1.0, sheep 0.9, wheat 1.15, ore 1.1; scarcity clamp 0.75–1.5 → **0.9–1.15**; lean 1.12 → 1.05; wheat keystone floor kept), **removed the additive wheat bonus**, and **shrank all bonuses** (diversity 1.2→0.6, synergy 0.8→0.5, complement 1.4→1.0, 6/8 1.2→0.8, security rewards 0.5/0.45→0.2 & penalties 2.5/2.0→2.0/1.5, ports scaled down). Mirrored in `reviewScoreCorner`. Result on `deck4256`: ore powerhouse **#16→#1**. Across 79 boards: **#1 pick within 1 pip of the max on 73/79** (avg give-up 0.46 pip — quality tie-breaks only), city engine (both ore & wheat) still **79/79**. **79 games.** |
| 1.26 | **Ore base weight 1.18 → 1.0** (user-approved, data-backed). 50- and 75-game `train.py` both said ore-alone is a drag (suggested ~0.70–0.75, `covers_ore` coef −7.7→−4.6) while `covers_wheat` is the #1 driver (+5.4→+6.5); R² −0.83→−0.70 (still negative → not blindly adopted, only this one stable signal actioned). Ore's city value stays carried by the ore+wheat synergy + ore-security, so opening still has both ore & wheat on 75/75 boards. Only the blanket ore premium removed. **75 games.** |
| 1.25 | **Ore-security (symmetric to wheat)** — v1.24 over-corrected: cities need ore AND wheat, but only wheat was protected, so 5/67 boards got a no-ore opening (27/67 no strong ore). Added mirror `orePips` reward on the complement: if the other settlement lacks ore, reward strong ore + −2.0 if still <3 ore pips. Now the advisor's opening (top pick + best complement) has BOTH ore & wheat on **67/67 boards** (both strong on 45/67), 0 missing either. Mirrored in `reviewScoreCorner`. **67 games.** |
| 1.24 | **Keystone-wheat fix** (user example `game-land2394`: advisor rated a wheatless `6-wood/5-ore/11-brick` as the best 2nd pick after a no-wheat 1st). Root cause: the scarcity multiplier *discounted* wheat when abundant (board weight fell to 1.21, below scarce ore 1.39 / brick 1.50). Fixes: (a) wheat scarcity floored at 1.0 (abundance never discounts the keystone) → weight 1.46, now highest; (b) ore+wheat synergy only when wheat ≥3 pips (a token 2/12-wheat isn't a city engine); (c) **wheat-security**: if the other settlement has no wheat, big reward for strong wheat here + −2.5 if still <3 wheat pips. Mirrored in `reviewScoreCorner`. Verified: on that board the wheatless 2nd pick dropped #1→#10, the user's picks became #1; across 60 boards #1-pick has any wheat 59/60 (strong 49/60), over-valued-no-wheat flags 15/51→4/60. **60 games.** |

## Open / future ideas
- **Cross-game Review** — aggregate patterns across all saved games (recurring leaks, opening tendencies, win rate).
- Probability of unplayed opponent dev-card types (from deck composition).
- Robber advice: confirm the exact "move robber" turnState/actionState so triggering is event-exact (currently a heuristic flag).
- Review: exact robber-denial income (needs build-timing; currently omitted in favour of luck + steal ledger).
