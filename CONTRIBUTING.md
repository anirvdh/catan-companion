# Making changes to Catan Companion

The single rule: **every change is documented and verified before it ships.**

This project's history is a long list of confident conclusions that turned out to be wrong because
a number was never checked — dropped cities, a backwards VP category, an award field that was wrong
in 28% of records. The discipline below exists because of those, not in spite of them.

---

## Every change

### 1. Verify against real data, not reasoning

Behaviour claims must be checked by replaying **real captured games through the real code path**.
Not a mock, not the offline reviewer standing in for the live path — the actual function that runs
in the browser. The city-upgrade bug survived for months because the offline path was tested and
the live path was not.

```bash
node tools/winpath_check.js      # live state vs end-game ground truth
node tools/winpath_logic.js      # decision-logic assertions
node tools/winpath_e2e.js 165    # advisor on real boards
node tools/setup_regression.js   # opening advisor unchanged (fingerprinted)
node tools/replay_check.js       # saved-record fields reproduce exactly
node -c sidepanel/sidepanel.js   # syntax
```

Run the full set before committing. If you add behaviour, add an assertion for it.

**A check that cannot fail is worth nothing.** When adding a validation, prove it catches the thing
it claims to catch — damage a capture deliberately and confirm it is rejected.

### 2. Record it in `CONVERSATION.md`

One row per version, at the top of the table. Say **what changed, why it mattered, and what the
measurement was** — before and after numbers, not adjectives.

> Bad: *"Fixed a bug in city tracking."*
> Good: *"A settlement→city upgrade arrives carrying only `buildingType: 2` with `owner` omitted, so the live handler skipped it and dropped every city: live city count matched truth in 8/60 games. Fix resolves omitted fields from prior state — now 342/342."*

If a number in the primer, the README or an analysis doc becomes stale, update it in the same
commit. Stale documentation is worse than none, because it gets trusted.

### 3. Bump the right version

Four layers move independently. Bump only what actually changed:

| Constant | Bump when |
|---|---|
| `manifest.json` `version` | any shipped change |
| `CAPTURE_VERSION` | the interceptor's capture behaviour changes |
| `PROTOCOL_PARSER_VERSION` | the decoder changes |
| `REPLAY_VERSION` | `reviewAnalyze`'s interpretation changes |
| `RECORD_SCHEMA_VERSION` | `buildGameRecord`'s shape changes |
| `PLACEMENT_SCORER_VERSION` / `V150` constants | **see below — don't** |

`scorerConfigHash` catches the nastiest case: a scorer version left unchanged while its constants
were quietly edited.

### 4. Commit

Imperative subject, then the why. Reference the measurement.

```
Fix city-upgrade diff dropping every city in live state

The upgrade carries only buildingType:2 with owner omitted, so the
live handler skipped it. Live city count matched end-game truth in
8/60 games; the coach said "toward your first city" all game.

Now 342/342 player-slots match. Added a permanent assertion.
```

---

## Rules that are not negotiable

### Never delete `raw/`

Derived records are regenerable from raw. Raw is not regenerable from anything. A clean-slate reset
once deleted it alongside the records and recovery was luck. Game data lives outside this repo and
is gitignored; back it up separately.

### Never overwrite `capturedScorer`

It means *"the scorer whose advice the player actually saw."* If a record is ever regenerated under
a newer scorer, this field must be **carried forward**, never recomputed — otherwise historical
advice gets relabelled as coming from a model that did not exist when the game was played.

### Don't tune the scorer on the current sample

The placement scorer (`PLACEMENT_SCORER_VERSION`, the `V150` weights, board lean, engine
thresholds) is **frozen** for the current collection run. There are ~86 decided outcomes; detecting
a realistic win-rate change needs thousands. An honest out-of-sample test already showed
data-derived weights performing *worse* than the hand-set priors.

Target ≈150 decided games before revisiting, and prefer **intermediate metrics** (first-city timing,
blocked income, dev-card pace) over win rate — they converge in tens of games rather than thousands.

### The advisor must stay honest

- Your VP is exact. The opponent's is **visible only**.
- Hidden VP is an *upper bound* from their unplayed dev-card count — never an assumption they hold any.
- **No dice prediction.** "Affordable" means from cards in hand, now.
- The panel shows **no scores**. The opponent's position drives the advice; it never becomes the advice.

---

## Traps worth knowing before you touch the protocol

| Trap | Consequence |
|---|---|
| `tileCornerStates` upgrades omit `owner` | every city dropped — resolve omitted fields from prior state |
| `victoryPointsState` is a **partial diff** | last-value tracking reads a 15-VP player as 3 — merge cumulatively |
| Award mechanic states are partial diffs too | replacing instead of merging made `awards.lrMe` wrong in 46/165 records |
| `victoryPoints` is category → **count**, not points | a naive sum flags 100% of games as concessions |
| VP category `3` is **Largest Army**, `4` is **Longest Road** | both are worth 2 VP, so totals hide the mistake |
| A decided winner can exceed 15 VP | hidden VP cards all reveal at once — assert `>= vpToWin`, never `== 15` |
| The server names a winner who may be **behind** on VP | use `leaderVP` for board position, `winner` for match outcome |
| A valid raw file may be a **partial** game | `captureIntegrity` / `researchEligible` exist for exactly this |

Full detail in [`CATAN_1V1_PRIMER.md`](CATAN_1V1_PRIMER.md).
