// sidepanel.js - Game state management and UI
// Protocol model validated against real colonist.io captures (see logs/README.md).
// All game state is reconstructed from the type:91 diff channel:
//   gameLogState  — the authoritative event log (rolls, gains, builds, trades, steals)
//   playerStates  — exact card COUNT per player (own breakdown revealed; opponent hidden as 0s)
//   currentState  — whose turn it is
//   mechanicDevelopmentCardsState — dev-card buys

// ─── Resource enums (confirmed via bankState) ────────────────────────────────
// 1=wood 2=brick 3=sheep 4=wheat 5=ore ; 0 = hidden card (opponent)
const RES_ENUM  = { 1: 'wood', 2: 'brick', 3: 'sheep', 4: 'wheat', 5: 'ore' };
const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const RES_ICONS = { wood: '🪵', brick: '🧱', wheat: '🌾', ore: '⛏️', sheep: '🐑' };
const RES_CLASS = { wood: 'res-wood', brick: 'res-brick', wheat: 'res-wheat', ore: 'res-ore', sheep: 'res-sheep' };

// pieceEnum → piece; main-game build costs
const PIECE = { 0: 'road', 2: 'settlement', 3: 'city' };
const BUILD_COST = {
  0: { wood: 1, brick: 1 },                          // road
  2: { wood: 1, brick: 1, sheep: 1, wheat: 1 },      // settlement
  3: { wheat: 2, ore: 3 },                           // city
};

// Expected dice probabilities (out of 36)
const EXPECTED = { 2:1, 3:2, 4:3, 5:4, 6:5, 7:6, 8:5, 9:4, 10:3, 11:2, 12:1 };

// ─── Balanced-dice model ───────────────────────────────────────────────────
// Faithful replica of colonist's DiceControllerBalanced. Not independent dice:
// a 36-card deck drawn without replacement (reshuffled when <13 remain), with a
// recent-5 damping and per-player 7-balancing. Lets us predict the NEXT roll's
// real odds instead of the static 6/36. Validated against captured games.
const DICE_STD = { 2:1,3:2,4:3,5:4,6:5,7:6,8:5,9:4,10:3,11:2,12:1 };
const REDUCE_RECENT = 0.34, REDUCE_STREAK = 0.4, RECENT_MEM = 5, MIN_RESHUFFLE = 13;

function newDiceModel() {
  return { remaining: { ...DICE_STD }, cardsLeft: 36, recentRolls: [], recentCount: {},
           sevensByPlayer: {}, playersRolled: new Set(), streakColor: null, streakCount: 0, rollsSeen: 0 };
}

// Apply one observed roll (mirrors drawWeightedCard's state updates)
function diceApplyRoll(m, total, roller) {
  roller = roller == null ? null : String(roller);
  if (m.cardsLeft < MIN_RESHUFFLE) { m.remaining = { ...DICE_STD }; m.cardsLeft = 36; } // reshuffle
  if (roller != null) { if (m.sevensByPlayer[roller] === undefined) m.sevensByPlayer[roller] = 0; m.playersRolled.add(roller); }
  if (m.remaining[total] > 0) { m.remaining[total]--; m.cardsLeft--; } else if (m.cardsLeft > 0) m.cardsLeft--;
  m.recentRolls.push(total); m.recentCount[total] = (m.recentCount[total] || 0) + 1;
  if (m.recentRolls.length > RECENT_MEM) { const old = m.recentRolls.shift(); m.recentCount[old]--; }
  if (total === 7 && roller != null) {
    m.sevensByPlayer[roller] = (m.sevensByPlayer[roller] || 0) + 1;
    if (roller === m.streakColor) m.streakCount++; else { m.streakColor = roller; m.streakCount = 1; }
  }
  m.rollsSeen++;
}

// Colonist's per-player 7 weight multiplier (imbalance + streak), clamped [0,2]
function diceSevenAdjustment(m, roller) {
  roller = roller == null ? null : String(roller);
  let streakAdj = 0;
  if (m.streakColor != null) streakAdj = REDUCE_STREAK * m.streakCount * (m.streakColor === roller ? -1 : 1);
  const size = m.playersRolled.size || 1;
  const totalSevens = Object.values(m.sevensByPlayer).reduce((a, b) => a + b, 0);
  let imb = 1;
  if (totalSevens >= size) {
    const mine = (roller != null && m.sevensByPlayer[roller] != null) ? m.sevensByPlayer[roller] : 0;
    const pct = totalSevens > 0 ? mine / totalSevens : 0;
    imb = 1 + ((1 / size - pct) / (1 / size));
  }
  const adj = imb + streakAdj;
  return adj < 0 ? 0 : adj > 2 ? 2 : adj;
}

// Predicted probability of each total on the NEXT roll, for a given roller
function dicePredict(m, roller) {
  let rem = m.remaining, cardsLeft = m.cardsLeft;
  if (cardsLeft < MIN_RESHUFFLE) { rem = { ...DICE_STD }; cardsLeft = 36; }
  const w = {}; let sum = 0;
  for (let k = 2; k <= 12; k++) {
    let weight = (rem[k] || 0) / cardsLeft;
    weight *= (1 - REDUCE_RECENT * (m.recentCount[k] || 0));
    if (weight < 0) weight = 0;
    if (k === 7) weight *= diceSevenAdjustment(m, roller);
    w[k] = weight; sum += weight;
  }
  const p = {}; for (let k = 2; k <= 12; k++) p[k] = sum > 0 ? w[k] / sum : 0;
  return p;
}

// ─── Opening-pick ranker (setup phase) ─────────────────────────────────────
// Confirmed geometry: corner (x,y,z=0) touches hexes (x,y),(x+1,y-1),(x,y-1);
// z=1 touches (x,y),(x-1,y+1),(x,y+1). Validated against real setup grants.
const SETUP_PIPS = { 2:1, 3:2, 4:3, 5:4, 6:5, 7:0, 8:5, 9:4, 10:3, 11:2, 12:1 };
const HEX_RES = { 0:'desert', 1:'wood', 2:'brick', 3:'sheep', 4:'wheat', 5:'ore' };
// Port geometry — verified against a real capture (2:1 trades matched port-corner ownership):
// a port at edge (x,y,z) borders hex (x,y) and hex (x+dx,y+dy); its two corners are the
// corners that touch BOTH hexes. z ∈ {0,1,2} picks the edge orientation.
const EDGE_OFF = { 0: [0, -1], 1: [-1, 0], 2: [-1, 1] };
// portEdgeStates.type: 1 = generic 3:1; n = 2:1 for resource enum (n-1). Verified via trades.
const PORT_RES = { 2: 'wood', 3: 'brick', 4: 'sheep', 5: 'wheat', 6: 'ore' };

// ─── Board archetype ───────────────────────────────────────────────────────────
// Read the board FIRST, then play the right game. Classify by where the pips concentrate:
//   ows      → ore+wheat+sheep rich → city / dev-card engine (largest army, VP cards)
//   road     → wood+brick rich      → expansion + longest-road game
//   balanced → no strong tilt       → mixed, take the best pips
// Returns the archetype, its OWS pip-share, a readable label, and a per-resource strategic-lean
// multiplier folded into the weights (we lean INTO the board's strong axis — data shows OWS-heavy
// openings win 57% vs 47% on OWS boards, and forcing OWS on road boards underperforms).
// Thresholds + tilts live here, in one place, deliberately simple to tune from test-game feedback.
function boardArchetype(resPips) {
  const ows = resPips.sheep + resPips.wheat + resPips.ore;
  const road = resPips.wood + resPips.brick;
  const share = (ows + road) ? ows / (ows + road) : 0.6;
  // Two-sided lean: boost the board's strong axis AND trim the off-axis premium, strong enough to
  // actually move the pick (a mild lean gets swamped by the scarcity multiplier). Ore/wheat are only
  // trimmed on road boards — the ore/wheat-SECURITY bonuses in scoreCorner still force the complement
  // pick to grab a city base, so you lead with wood/brick but never end up city-less. ← tune here.
  // Base is wood/brick/sheep 1.0, wheat 1.15, ore 1.1. Leans back-solved to hit the target effective
  // weights below (effective = base × lean). ← tune here.
  if (share >= 0.63) return { archetype: 'ows', owsShare: share, lean: { wood: 0.92, brick: 0.92, sheep: 1.10, wheat: 1.05, ore: 1.10 }, label: 'OWS-favoring — city / dev engine (ore·wheat·sheep)' };  // → Wo0.92 Br0.92 Sh1.10 Wh1.21 Or1.21
  if (share <= 0.57) return { archetype: 'road', owsShare: share, lean: { wood: 1.20, brick: 1.20, ore: 0.909 }, label: 'Road-favoring — expansion & longest road (wood·brick)' };                    // → Wo1.20 Br1.20 Sh1.00 Wh1.15 Or1.00
  return { archetype: 'balanced', owsShare: share, lean: {}, label: 'Balanced — mixed engine, take the best pips' };                                                                                    // → Wo1.00 Br1.00 Sh1.00 Wh1.15 Or1.10
}

// ═══════════════════════════════════════════════════════════════════════════════
// v1.50 PLACEMENT SCORING  (spec: CATAN_COMPANION_V1_50_PLACEMENT_SCORING_SPEC.md)
// Core architectural rule: RESOURCE WEIGHTS PRICE PRODUCTION ONLY. Convertibility, coverage,
// tempo, ports, risk and uniqueness are priced by PAIR-level functions. This is what stops the
// v1.40 failure mode where stacked multiplicative/additive bonuses produced pathological ranks.
// v1.40 stays available via PLACEMENT_SCORER_VERSION so both can be compared on saved boards.
// Geo-agnostic: works with buildBoardGeo (live) and reviewGeo (Review) alike.
// ═══════════════════════════════════════════════════════════════════════════════
const PLACEMENT_SCORER_VERSION = 'v1.50';        // 'v1.40' | 'v1.50'

// ─── Reproducibility metadata ─────────────────────────────────────────────────
// Four layers can change INDEPENDENTLY while the raw capture stays byte-identical, and a result is
// only reproducible if you know which version of each produced it. A replay bug and a scoring bug
// are different problems; without these you cannot tell them apart after the fact.
//   capture  → interceptor + bridge + background (what bytes we kept)
//   parser   → MessagePack decoding (how bytes became objects)
//   replay   → reviewAnalyze (how events became a game model)
//   schema   → the shape of the saved record itself
// Bump the one that changed. scorerConfigHash catches the nastier case: scorer VERSION unchanged
// but its constants silently edited.
const CAPTURE_VERSION = '1.56';
const PROTOCOL_PARSER_VERSION = '2';             // bounds-checked decoder incl. 0xcf/0xd3/ext
// 1.60: `decided` now derives from leaderVP (max final VP) instead of the server's winnerVP.
// Verified to give IDENTICAL classification on all 66 schema-2 games, so the series is continuous.
// 1.61: award mechanic states are MERGED per colour instead of replaced — `awards.lrMe` was wrong
// in 46/165 records. Re-derived records now match end-game truth 165/165 on both awards.
const REPLAY_VERSION = '1.61';                   // bumped when reviewAnalyze's interpretation changes
// schema 3 (v1.60) is PURELY ADDITIVE over 2 — completedTurns/terminalTurnNumber, leader/leaderVP,
// mmrComplete. Every schema-2 field kept its name and meaning, so the two mix safely in analysis.
const RECORD_SCHEMA_VERSION = '3';               // bumped when buildGameRecord's shape changes

// Small deterministic hash (FNV-1a). Not cryptographic — it only needs to change when the config does.
function configHash(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const V150 = {
  // Board lean.
  // NEUTRAL: theoretical 11/18 = 0.6111 (OWS holds 11 of 18 producing hexes). The 111-board sample
  // mean was 0.6139, but that is only 0.63 standard errors away (SE = 0.0465/√111 = 0.0044) — i.e.
  // statistically indistinguishable from the theoretical value. Prefer the principled constant.
  // HALF-WIDTH: the spec's 0.05 is AGGRESSIVE (a smaller half-width reaches ±1 sooner) and pinned
  // 27% of real boards at full globalSupplyLean. 1.5σ = 0.0698 is softer and better grounded.
  neutralOwsShare: 11 / 18,
  globalLeanHalfWidth: 0.0698,
  // OPPORTUNITY LEAN DISABLED IN LIVE WEIGHTS (kept as a diagnostic only).
  // Reason: `topKMean(family) / mean(family)` is a TAIL-CONCENTRATION index, not the absolute
  // draftable-opportunity signal it claimed to measure. A family that is weak overall but
  // concentrated in a few pairs scores HIGH, so the term could push an OWS lean on a road-rich
  // board. Measured on 111 boards: correlation with globalSupplyLean −0.22, signs disagreeing on
  // 56/111, saturating 38.7%. Raising opportunityLogScale would only hide the saturation, not fix
  // the semantics. Pair draftability is already priced by the pair-level functions (viability,
  // recipes, coverage, tempo, ports), so a second competing archetype signal also double-counts.
  globalLeanWeight: 1.00,
  opportunityLeanWeight: 0.00,
  opportunityTopK: 8,
  opportunityLogScale: 0.25,
  // Production weight endpoints — interpolated continuously by board lean. wood===brick always.
  weights: {
    balanced: { wood: 1.00, brick: 1.00, sheep: 1.00, wheat: 1.15, ore: 1.10 },
    ows:      { wood: 0.95, brick: 0.95, sheep: 1.06, wheat: 1.20, ore: 1.20 },
    road:     { wood: 1.15, brick: 1.15, sheep: 1.00, wheat: 1.12, ore: 1.03 },
  },
  // Engine gate. Allowances are now SCALE-AWARE: a fixed 2.00 was too tight relative to ~26-point
  // raw production and let four boards select openings with ZERO wheat or ZERO ore — which obeys the
  // constant but contradicts the whole point of the gate in a 15-VP game. Candidate values to test,
  // not proven constants.
  engine: { strongWheat: 3, strongOre: 3, weakWheat: 2, weakOre: 2,
            strongPct: 0.11, strongMin: 2.25, strongMax: 3.00,
            weakPct: 0.06, weakMin: 1.25, weakMax: 1.75,
            fragilePct: 0.03, fragileMin: 0.60, fragileMax: 0.90,
            bridgePort: 0.70, bridgeSurplusPips: 5 },
  coverage: { target:     { wood: 2.5, brick: 2.5, sheep: 2.5, wheat: 3.0, ore: 3.0 },
              importance: { wood: 1.00, brick: 1.00, sheep: 0.95, wheat: 1.15, ore: 1.10 },
              // multiplier calibrated so the cap binds at ~p99 of TOP-10 pairs (unclamped base p99
              // = 5.61 → 1.60/5.61 ≈ 0.28). At the spec's 0.38 the term clipped on 24% of top-10
              // pairs, destroying discrimination among exactly the candidates that matter.
              multiplier: 0.28, cap: 1.60 },
  // CALIBRATION FIX (not in the spec): the component caps sum to 7.75 while the aggregate cap is
  // 2.50, so on real boards 56% of pairs pinned at +2.50 — the soft term became a CONSTANT and
  // stopped discriminating exactly among the top pairs it exists to separate. Scaling the summed
  // soft terms before the clamp preserves every relative weighting from the spec but lands the
  // distribution inside the band (p99 ≈ 2.3), so it works as a tie-breaker again.
  soft: { min: -2.00, max: 2.50, scale: 0.60 },
  // rollCoverage: how many DISTINCT strong roll outcomes activate the opening.
  // recipeCoProduction: when a roll fires, does it deliver complementary build resources together?
  // These are genuinely different (6-wheat+8-ore has better roll coverage; 6-wheat+6-ore has better
  // co-production) and are kept as separate small terms, per review §7.1.
  // multiplier 0.04 → 0.025: the unclamped base (sum of distinct-number pips) maxes at 24, so 0.04
  // capped the term for 90.6% of top-10 pairs — it was a constant, not a discriminator. 0.60/24
  // makes the cap bind only at the theoretical maximum.
  rollCoverage: { multiplier: 0.025, cap: 0.60 },
  recipeCoProduction: { roadPair: 0.08, cityPair: 0.10, devSet: 0.08, cap: 0.35 },
  ports: { max2: 1.35, max3: 1.00, cap: 1.60, second: 0.50 },
  tempoCap: 1.40, robberCap: 1.00,
  expansionMin: -0.50, expansionMax: 1.00,
  // Shortlist constants for the DEFERRED nested P1 lookahead only. The old `pairPoolTopK: 60` was
  // misleading: it was applied to CORNERS, and a board has 54, so it could never prune anything.
  // These replace it explicitly. P2_RESPONSE_PAIR_SHORTLIST applies to generated PAIRS (after pair
  // generation, via a multi-criteria union) and must be validated against exhaustive search before
  // use. Direct P2 advice remains exhaustive and uses neither constant.
  P1_FIRST_CORNER_CANDIDATES: 14,
  P2_RESPONSE_PAIR_SHORTLIST: 80,
};

const V150_RECIPES = {
  road:       { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 },
  city:       { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 },
  dev:        { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 },
};

const V150_BUILD_MIX = {
  balanced: { road: 1.00, settlement: 0.80, city: 1.10, dev: 1.00 },
  ows:      { road: 0.70, settlement: 0.70, city: 1.40, dev: 1.30 },
  road:     { road: 1.40, settlement: 1.00, city: 0.80, dev: 0.80 },
};

// ── helpers ───────────────────────────────────────────────────────────────────
function v150Clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function v150Lerp(a, b, t) { return a + (b - a) * t; }
function v150Sat(x, scale) { return x <= 0 ? 0 : 1 - Math.exp(-x / scale); }   // → 1.0 as x grows
function v150Smooth01(x) { const t = v150Clamp(x, 0, 1); return t * t * (3 - 2 * t); }
function v150Zero() { return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; }
function v150Add(a, b) { const o = {}; for (const r of RESOURCES) o[r] = (a[r] || 0) + (b[r] || 0); return o; }

// Hexes touching a corner, WITH hex identity (needed for robber concentration + number sync).
function v150CornerHexes(geo, id) {
  const c = geo.corners[id]; const out = [];
  if (!c) return out;
  for (const k of c.tri) {
    const h = geo.hexByCoord[k];
    if (h && h.res && h.res !== 'desert' && h.dice) out.push({ key: k, res: h.res, dice: h.dice });
  }
  return out;
}
function v150CornerPips(geo, id) {
  const out = v150Zero();
  for (const h of v150CornerHexes(geo, id)) out[h.res] += SETUP_PIPS[h.dice] || 0;
  return out;
}
// NOTE: if both settlements touch the same hex, BOTH produce from it → pair pips are the sum of the
// two corner vectors, not the pips of unique hexes. (Spec §3.3.)
function v150PairPips(geo, aId, bId) { return v150Add(v150CornerPips(geo, aId), v150CornerPips(geo, bId)); }

// ── Step 2: continuous board lean (−1 ROAD … 0 balanced … +1 OWS) ─────────────
function v150GlobalLean(resPips) {
  const ows = resPips.sheep + resPips.wheat + resPips.ore;
  const road = resPips.wood + resPips.brick;
  const share = ows / Math.max(1e-9, ows + road);
  return v150Clamp((share - V150.neutralOwsShare) / V150.globalLeanHalfWidth, -1, 1);
}
// Global supply can hide unusable distributions (lots of sheep but no draftable wheat+ore corner).
// Correct it by how good the BEST pairs actually are on each axis, normalised against that axis'
// own board-wide mean so unlike units don't distort the comparison.
function v150OpportunityLean(geo) {
  const ids = geo.cornerIds;
  const pips = {}; for (const id of ids) pips[id] = v150CornerPips(geo, id);
  const owsV = [], roadV = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (geo.adj(ids[i], ids[j])) continue;
      const p = v150Add(pips[ids[i]], pips[ids[j]]);
      const city = Math.min(p.wheat / 2, p.ore / 3);
      const dev  = Math.min(p.sheep, p.wheat, p.ore);
      const road = Math.min(p.wood, p.brick);
      const sett = Math.min(p.wood, p.brick, p.sheep, p.wheat);
      owsV.push(0.65 * city + 0.35 * dev);
      roadV.push(0.70 * road + 0.30 * sett);
    }
  }
  if (!owsV.length) return 0;
  const EPS = 1e-9;
  const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const topK = (a, k) => mean([...a].sort((x, y) => y - x).slice(0, k));
  const K = Math.min(V150.opportunityTopK, owsV.length);
  const relOWS  = topK(owsV, K)  / Math.max(EPS, mean(owsV));
  const relRoad = topK(roadV, K) / Math.max(EPS, mean(roadV));
  // Log ratio is symmetric: doubling and halving are equal magnitudes in opposite directions.
  return v150Clamp(Math.log(relOWS / Math.max(EPS, relRoad)) / V150.opportunityLogScale, -1, 1);
}
function v150BoardLean(geo) {
  return v150Clamp(V150.globalLeanWeight * v150GlobalLean(geo.resPips)
                 + V150.opportunityLeanWeight * v150OpportunityLean(geo), -1, 1);
}

// ── Step 3: effective production weights (continuous interpolation) ───────────
function v150Weights(lean) {
  const B = V150.weights.balanced, T = lean >= 0 ? V150.weights.ows : V150.weights.road;
  const t = Math.abs(lean), out = {};
  for (const r of RESOURCES) out[r] = v150Lerp(B[r], T[r], t);
  out.brick = out.wood;                      // hard invariant: wood and brick are consumed together
  return out;
}

// ── Step 4: raw production (NO bonuses ever added here) ───────────────────────
function v150RawCorner(geo, id, W) {
  let total = 0;
  for (const h of v150CornerHexes(geo, id)) total += (SETUP_PIPS[h.dice] || 0) * (W[h.res] || 1);
  return total;
}
// Standalone corner score — for pruning + UI display only. Never reuse pair bonuses on one corner.
function v150StandaloneCorner(geo, id, W) {
  const raw = v150RawCorner(geo, id, W);
  const seen = new Set(); let breadth = 0;
  for (const h of v150CornerHexes(geo, id)) if (!seen.has(h.dice)) { seen.add(h.dice); breadth += SETUP_PIPS[h.dice] || 0; }
  return raw + v150Clamp(0.02 * breadth, 0, 0.20);
}

// ── Step 5: engine viability (a GATE, not an additive penalty) ────────────────
// The v1.40 security penalties were additive, so a productive-but-broken opening could still
// outrank a real city base. Gating fixes that structurally.
// A port only BRIDGES a missing city base if the pair could actually trade into wheat/ore: it must
// own the port, be short on wheat or ore, and have a genuine surplus to trade away (for a 2:1, the
// surplus must be the port's own resource). Previously any port whose generic value cleared 0.70
// promoted a pair to WEAK — including a 3:1 scoring high purely on imbalance.
function v150ValidPortBridge(geo, aId, bId, pairPips) {
  const E = V150.engine;
  if (pairPips.wheat >= E.strongWheat && pairPips.ore >= E.strongOre) return false;   // not short
  const ports = [geo.cornerPort && geo.cornerPort[aId], geo.cornerPort && geo.cornerPort[bId]].filter(Boolean);
  for (const p of ports) {
    if (p.ratio === 2 && p.res && pairPips[p.res] >= E.bridgeSurplusPips) return true;
    if (p.ratio === 3 && RESOURCES.some(r => pairPips[r] >= E.bridgeSurplusPips + 2)) return true;
  }
  return false;
}
// Four classes: MISSING (lacks wheat or ore entirely) is strategically different from FRAGILE
// (has both, but thin) and must not be hidden inside one "BROKEN" bucket.
function v150Viability(pairPips, bestPortValue, validBridge) {
  const w = pairPips.wheat, o = pairPips.ore, E = V150.engine;
  if (w >= E.strongWheat && o >= E.strongOre) return 'STRONG';
  const bridge = validBridge && (bestPortValue || 0) >= E.bridgePort;
  if ((w >= E.weakWheat && o >= E.weakOre) || (Math.min(w, o) >= 1 && bridge)) return 'WEAK';
  if (w >= 1 && o >= 1) return 'FRAGILE';
  return 'MISSING';
}
const V150_CLASS_ORDER = ['STRONG', 'WEAK', 'FRAGILE', 'MISSING'];
// Prefer the best engine class reachable without sacrificing too much production. Allowances scale
// with the board's own production level. At each tier, pairs of that class OR BETTER stay eligible.
function v150GateEligible(scored) {
  if (!scored.length) return scored;
  let bestRaw = -Infinity;
  for (const x of scored) if (x.rawProduction > bestRaw) bestRaw = x.rawProduction;
  const E = V150.engine;
  const allow = [
    v150Clamp(E.strongPct * bestRaw, E.strongMin, E.strongMax),
    v150Clamp(E.weakPct * bestRaw, E.weakMin, E.weakMax),
    v150Clamp(E.fragilePct * bestRaw, E.fragileMin, E.fragileMax),
  ];
  for (let tier = 0; tier < 3; tier++) {
    const cls = V150_CLASS_ORDER[tier];
    if (scored.some(x => x.viability === cls && x.rawProduction >= bestRaw - allow[tier])) {
      const ok = new Set(V150_CLASS_ORDER.slice(0, tier + 1));
      return scored.filter(x => ok.has(x.viability));
    }
  }
  return scored;                              // no engine reachable without a severe sacrifice
}

// ── Step 6: coverage utility (replaces binary diversity + complement bonuses) ─
// A 2-pip and a 6-pip source of a resource are NOT equivalent; reward reaching a usable
// threshold, with small diminishing value for surplus beyond it.
function v150CoverageUtility(res, pips) {
  const target = V150.coverage.target[res];
  return v150Smooth01(pips / target) + 0.20 * v150Sat(Math.max(0, pips - target), 4.0);
}
function v150CoverageBonus(pairPips) {
  let t = 0;
  for (const r of RESOURCES) t += V150.coverage.importance[r] * v150CoverageUtility(r, pairPips[r]);
  return v150Clamp(V150.coverage.multiplier * t, 0, V150.coverage.cap);
}

// ── Step 7: recipe balance (raw production is linear; build recipes are not) ──
function v150RecipeRates(p) {
  return {
    city: Math.min(p.wheat / 2, p.ore / 3),
    dev: Math.min(p.sheep, p.wheat, p.ore),
    road: Math.min(p.wood, p.brick),
    settlement: Math.min(p.wood, p.brick, p.sheep, p.wheat),
  };
}
function v150RecipeBonus(pairPips, lean) {
  const ows = Math.max(0, lean), road = Math.max(0, -lean);
  const c = {
    city: 0.65 + 0.20 * ows - 0.10 * road,
    dev: 0.45 + 0.20 * ows - 0.05 * road,
    road: 0.45 + 0.25 * road - 0.10 * ows,
    settlement: 0.30 + 0.10 * road,
  };
  const r = v150RecipeRates(pairPips);
  return v150Clamp(c.city * v150Sat(r.city, 1.8) + c.dev * v150Sat(r.dev, 3.5)
                 + c.road * v150Sat(r.road, 3.0) + c.settlement * v150Sat(r.settlement, 2.5), 0, 1.80);
}

// ── Step 8: number coverage + recipe synchronisation ─────────────────────────
// Pips already price 6/8 correctly — no second binary "has a 6/8" bonus. Instead reward covering
// several DISTINCT strong roll outcomes ({6,8,9} beats {6,6,9}) without calling duplicates bad.
function v150RollCoverage(geo, aId, bId) {
  const seen = new Set(); let total = 0;
  for (const id of [aId, bId]) for (const h of v150CornerHexes(geo, id))
    if (!seen.has(h.dice)) { seen.add(h.dice); total += SETUP_PIPS[h.dice] || 0; }
  return v150Clamp(V150.rollCoverage.multiplier * total, 0, V150.rollCoverage.cap);
}
// Complementary resources on the SAME roll improve build tempo. (Mild tension with the term above
// by design — both are small and capped, so neither dominates.)
function v150RecipeCoProduction(geo, aId, bId) {
  const byNum = new Map();
  for (const id of [aId, bId]) for (const h of v150CornerHexes(geo, id)) {
    if (!byNum.has(h.dice)) byNum.set(h.dice, new Set());
    byNum.get(h.dice).add(h.res);
  }
  const C = V150.recipeCoProduction; let total = 0;
  for (const [num, set] of byNum.entries()) {
    const s = (SETUP_PIPS[num] || 0) / 5;
    if (set.has('wood') && set.has('brick')) total += C.roadPair * s;
    if (set.has('wheat') && set.has('ore')) total += C.cityPair * s;
    if (set.has('sheep') && set.has('wheat') && set.has('ore')) total += C.devSet * s;
  }
  return v150Clamp(total, 0, C.cap);
}

// ── Step 9: ports valued by SURPLUS vs the build mix, not mere presence ──────
function v150BuildMix(lean) {
  const B = V150_BUILD_MIX.balanced, T = lean >= 0 ? V150_BUILD_MIX.ows : V150_BUILD_MIX.road;
  const t = Math.abs(lean), out = {};
  for (const k of Object.keys(B)) out[k] = v150Lerp(B[k], T[k], t);
  return out;
}
function v150TargetDemandShare(lean) {
  const mix = v150BuildMix(lean), demand = v150Zero();
  for (const [build, w] of Object.entries(mix)) for (const r of RESOURCES) demand[r] += w * V150_RECIPES[build][r];
  const total = RESOURCES.reduce((s, r) => s + demand[r], 0), share = {};
  for (const r of RESOURCES) share[r] = demand[r] / Math.max(1e-9, total);
  return share;
}
function v150ShareOf(pairPips) {
  const total = RESOURCES.reduce((s, r) => s + pairPips[r], 0), share = {};
  for (const r of RESOURCES) share[r] = pairPips[r] / Math.max(1e-9, total);
  return share;
}
function v150ValuePort(port, pairPips, lean) {
  const prod = v150ShareOf(pairPips), target = v150TargetDemandShare(lean);
  if (port.ratio === 2 && port.res) {
    const surplus = Math.max(0, prod[port.res] - target[port.res]);
    const strength = v150Clamp(pairPips[port.res] / 8.0, 0, 1);
    return v150Clamp(0.10 + 2.40 * surplus + 0.35 * strength, 0, V150.ports.max2);
  }
  if (port.ratio === 3) {
    let imbalance = 0, lowCount = 0;
    for (const r of RESOURCES) { imbalance += Math.abs(prod[r] - target[r]); if (pairPips[r] < 2) lowCount++; }
    return v150Clamp(0.15 + 1.10 * (imbalance * 0.5) + 0.40 * (lowCount / RESOURCES.length), 0, V150.ports.max3);
  }
  return 0;
}
function v150PortValue(geo, aId, bId, pairPips, lean) {
  const ports = [geo.cornerPort && geo.cornerPort[aId], geo.cornerPort && geo.cornerPort[bId]].filter(Boolean);
  if (!ports.length) return { total: 0, best: 0 };
  const vals = ports.map(p => v150ValuePort(p, pairPips, lean)).sort((a, b) => b - a);
  const total = (vals[0] || 0) + V150.ports.second * (vals[1] || 0);
  return { total: v150Clamp(total, 0, V150.ports.cap), best: vals[0] || 0 };
}

// ── Step 10: starting-card tempo (ONLY the 2nd settlement grants cards) ──────
// This is why pair ORDER matters — a real effect v1.40 never modelled at all.
// Starting cards are 1 per adjacent producing hex (not pips).
function v150StartingCards(geo, id) {
  const cards = v150Zero();
  for (const h of v150CornerHexes(geo, id)) cards[h.res] += 1;
  return cards;
}
function v150RecipeFraction(cards, recipe) {
  let missing = 0, cost = 0;
  for (const r of RESOURCES) { cost += recipe[r]; missing += Math.max(0, recipe[r] - cards[r]); }
  return 1 - missing / Math.max(1, cost);
}
function v150CanBuild(cards, recipe) { return RESOURCES.every(r => cards[r] >= recipe[r]); }
function v150TempoValue(geo, startingId, lean) {
  if (!startingId) return 0;
  const cards = v150StartingCards(geo, startingId);
  const ows = Math.max(0, lean), road = Math.max(0, -lean);
  let s = (0.55 + 0.15 * road - 0.10 * ows) * v150RecipeFraction(cards, V150_RECIPES.road)
        + (0.55 + 0.15 * ows - 0.05 * road) * v150RecipeFraction(cards, V150_RECIPES.dev)
        + (0.25 + 0.10 * ows) * v150RecipeFraction(cards, V150_RECIPES.city);
  if (v150CanBuild(cards, V150_RECIPES.road)) s += 0.25;
  if (v150CanBuild(cards, V150_RECIPES.dev)) s += 0.35;
  return v150Clamp(s, 0, V150.tempoCap);
}

// ── Step 11: robber concentration risk (small — concentration can still be good) ──
function v150RobberPenalty(geo, aId, bId, W, rawProduction) {
  const exposure = new Map();
  for (const id of [aId, bId]) for (const h of v150CornerHexes(geo, id))
    exposure.set(h.key, (exposure.get(h.key) || 0) + (SETUP_PIPS[h.dice] || 0) * (W[h.res] || 1));
  if (!exposure.size) return 0;
  const maxBlocked = Math.max(...exposure.values());
  const ratio = maxBlocked / Math.max(1e-9, rawProduction);
  let penalty = 0.80 * ratio * ratio;
  const pairPips = v150PairPips(geo, aId, bId);
  for (const crit of ['wheat', 'ore']) {
    const total = pairPips[crit];
    if (total <= 0) continue;
    let maxOne = 0;
    for (const id of [aId, bId]) for (const h of v150CornerHexes(geo, id))
      if (h.res === crit) maxOne = Math.max(maxOne, SETUP_PIPS[h.dice] || 0);
    if (maxOne / total >= 0.70) penalty += 0.20;      // whole wheat/ore engine on one blockable hex
  }
  return v150Clamp(penalty, 0, V150.robberCap);
}

// ── Step 15: full pair score ─────────────────────────────────────────────────
// FINAL = RAW_WEIGHTED_PRODUCTION + clamp(sum of soft terms, −2.00, +2.50)
// Raw production stays dominant (~20-25) so pips always lead; soft terms are ~10% tie-breakers.
function v150ScorePair(geo, aId, bId, ctx) {
  const { W, lean, startingId, expansionValue } = ctx;
  const pairPips = v150PairPips(geo, aId, bId);
  const rawProduction = v150RawCorner(geo, aId, W) + v150RawCorner(geo, bId, W);
  const port = v150PortValue(geo, aId, bId, pairPips, lean);
  const viability = v150Viability(pairPips, port.best, v150ValidPortBridge(geo, aId, bId, pairPips));

  const b = {
    coverage: v150CoverageBonus(pairPips),
    recipes: v150RecipeBonus(pairPips, lean),
    rollCoverage: v150RollCoverage(geo, aId, bId),
    recipeCoProduction: v150RecipeCoProduction(geo, aId, bId),
    port: port.total,
    tempo: v150TempoValue(geo, startingId, lean),
    expansion: expansionValue || 0,
    // replaceability REMOVED: measured 100% zero-rate and 0/111 top-1 changes. Its exact definition
    // can only be non-zero for the single best pair per resource, so it was structurally inert. True
    // replaceability is state-dependent (what access remains AFTER a move) and belongs in the
    // deferred denial / lookahead phases, not as a static pair term.
    robber: v150RobberPenalty(geo, aId, bId, W, rawProduction),
  };
  const softRaw = b.coverage + b.recipes + b.rollCoverage + b.recipeCoProduction + b.port + b.tempo
                + b.expansion - b.robber;
  const softAdjustment = v150Clamp(softRaw * V150.soft.scale, V150.soft.min, V150.soft.max);

  return { aId, bId, pairPips, rawProduction, viability, softAdjustment,
           score: rawProduction + softAdjustment, breakdown: b };
}

// Grade ONE of my setup picks under the current v1.50 model, for the Review tab's dual-version
// display. Mirrors the live advisor: the opening pick is judged standalone; the complement pick is
// judged as the completing half of the PAIR with my already-placed settlement.
function v150ReviewGrade(geo, pickId, legal, myPickIds, priorRes) {
  const W = geo.weights150 || geo.weights, lean = geo.lean150 || 0;
  const placed = [...myPickIds].find(id => id !== pickId && priorRes && priorRes.size);
  let ranked, mineScore;
  if (placed && geo.corners[placed]) {
    ranked = legal.map(id => ({ id, s: v150ScorePair(geo, placed, id, { W, lean, startingId: id, expansionValue: 0 }).score }));
    const m = v150ScorePair(geo, placed, pickId, { W, lean, startingId: pickId, expansionValue: 0 });
    mineScore = m.score;
  } else {
    ranked = legal.map(id => ({ id, s: v150StandaloneCorner(geo, id, W) }));
    mineScore = v150StandaloneCorner(geo, pickId, W);
  }
  ranked.sort((a, b) => b.s - a.s);
  const rank = ranked.findIndex(x => x.id === pickId) + 1;
  const best = ranked[0];
  return { rank, total: ranked.length, regret: best ? +Math.max(0, best.s - mineScore).toFixed(2) : 0,
           matched: !!(best && best.id === pickId), bestTakenByMe: !!(best && best.id !== pickId && myPickIds.has(best.id)) };
}

// Explicit deterministic ordering — never rely on engine sort stability (review §12.2).
// Tie-break: final score → raw production → engine class → starting tempo → stable pair id.
const V150_ENGINE_RANK = { STRONG: 0, WEAK: 1, FRAGILE: 2, MISSING: 3 };
function v150CompareScored(x, y) {
  if (y.score !== x.score) return y.score - x.score;
  if (y.rawProduction !== x.rawProduction) return y.rawProduction - x.rawProduction;
  const e = V150_ENGINE_RANK[x.viability] - V150_ENGINE_RANK[y.viability];
  if (e) return e;
  const t = (y.breakdown ? y.breakdown.tempo : 0) - (x.breakdown ? x.breakdown.tempo : 0);
  if (t) return t;
  const kx = `${x.firstId}|${x.secondId}`, ky = `${y.firstId}|${y.secondId}`;
  return kx < ky ? -1 : kx > ky ? 1 : 0;
}

// Human-readable "why this pair" reasons, ranked by contribution.
function v150Reasons(s) {
  const b = s.breakdown, out = [];
  if (s.viability === 'STRONG') out.push(`${s.pairPips.wheat}-pip wheat + ${s.pairPips.ore}-pip ore city base`);
  else if (s.viability === 'WEAK') out.push('thin city base — needs a port or a later ore/wheat spot');
  else if (s.viability === 'FRAGILE') out.push(`⚠ very thin city base (${s.pairPips.wheat} wheat / ${s.pairPips.ore} ore)`);
  else out.push(`⚠ NO city base — ${s.pairPips.wheat === 0 ? 'no wheat' : 'no ore'} at all`);
  const named = [
    [b.recipes, 'balanced for real builds'], [b.coverage, 'broad resource coverage'],
    [b.port, 'port pays off on surplus'], [b.tempo, 'starting cards give instant tempo'],
    [b.rollCoverage, 'spread across strong numbers'], [b.expansion, 'good expansion lane'],
    [b.recipeCoProduction, 'city resources hit on the same roll'],
  ].filter(x => x[0] >= 0.25).sort((x, y) => y[0] - x[0]).slice(0, 3).map(x => x[1]);
  out.push(...named);
  if (b.robber >= 0.35) out.push('⚠ heavy robber exposure on one hex');
  return out;
}

// Rank all legal PAIRS for the second seat (picks #2 and #3 back-to-back). Both orders are scored
// because only the SECOND settlement grants starting cards, so order changes the tempo term.
function v150RankPairs(geo, legalIds) {
  const W = geo.weights150 || geo.weights, lean = geo.lean150 || 0;
  // Prune by cheap standalone production first (spec's full pool is fine here, but this keeps the
  // later P1 lookahead affordable and costs nothing in quality at top-60).
  const pool = legalIds.map(id => ({ id, raw: v150StandaloneCorner(geo, id, W) }))
    .sort((a, b) => b.raw - a.raw).map(x => x.id);
  const pairs = [];
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      if (!geo.adj(pool[i], pool[j])) pairs.push([pool[i], pool[j]]);
  if (!pairs.length) return [];
  const scored = pairs.map(([a, b]) => {
    const ab = v150ScorePair(geo, a, b, { W, lean, startingId: b, expansionValue: 0 });
    const ba = v150ScorePair(geo, a, b, { W, lean, startingId: a, expansionValue: 0 });
    return ab.score >= ba.score ? { ...ab, firstId: a, secondId: b } : { ...ba, firstId: b, secondId: a };
  });
  return v150GateEligible(scored).sort(v150CompareScored);
}

// Build the advisor's recommendation cards under v1.50. Handles all three setup situations:
// second seat opening (joint pair), first seat opening (first pick judged by the {#1,#4} pair it
// leads to), and the complement pick (one settlement already down).
function v150BuildRecs(geo, legal, ownedIds, ownedSet, owned, myPlaced, amFirst, oppPicksAfterMe) {
  const W = geo.weights150 || geo.weights, lean = geo.lean150 || 0;
  const disp = id => scoreCorner(id, null, null);      // label / pips / port for display only

  // ── Complement pick: one settlement already placed → the pair is fixed on one side. The corner
  //    being placed now is my SECOND settlement, so it grants the starting cards.
  if (myPlaced === 1) {
    const mineId = ownedIds.find(id => String(owned[id].owner) === state.myColor);
    if (mineId && geo.corners[mineId]) {
      const cands = legal.map(id => ({
        ...v150ScorePair(geo, mineId, id, { W, lean, startingId: id, expansionValue: 0 }),
        firstId: id,
      }));
      const top = v150GateEligible(cands).sort(v150CompareScored).slice(0, 3);
      return top.map(s => ({
        ...disp(s.firstId),
        road: roadAdvice(s.firstId, new Set([...ownedIds, s.firstId]), oppPicksAfterMe),
        v150: s, followup: { kind: 'reasons', tags: v150Reasons(s) },
      }));
    }
  }

  // ── Second seat opening: optimise the back-to-back pair jointly, one card per distinct lead spot.
  if (myPlaced === 0 && amFirst === false) {
    const ranked = v150RankPairs(geo, legal);
    const seen = new Set(); const top = [];
    for (const s of ranked) { if (seen.has(s.firstId)) continue; seen.add(s.firstId); top.push(s); if (top.length === 3) break; }
    return top.map(s => ({
      ...disp(s.firstId),
      road: roadAdvice(s.firstId, new Set([...ownedIds, s.firstId, s.secondId]), oppPicksAfterMe),
      v150: s,
      followup: { kind: 'pair', spot: disp(s.secondId), tags: v150Reasons(s) },
    }));
  }

  // ── First seat opening: don't take the best standalone corner — judge each candidate by the
  //    {#1, #4} PAIR it actually leads to after the opponent's likely grabs.
  if (myPlaced === 0 && amFirst === true) {
    const pool = legal.map(id => ({ id, raw: v150StandaloneCorner(geo, id, W) }))
      .sort((a, b) => b.raw - a.raw).slice(0, V150.P1_FIRST_CORNER_CANDIDATES);
    const sims = [];
    for (const c of pool) {
      const sim = fourthPickSim(c.id, ownedSet);
      if (sim && sim.my4) sims.push({ id: c.id, sim });
    }
    if (sims.length) {
      const cands = sims.map(x => ({
        ...v150ScorePair(geo, x.id, x.sim.my4.id, { W, lean, startingId: x.sim.my4.id, expansionValue: 0 }),
        firstId: x.id, sim: x.sim,
      }));
      const top = v150GateEligible(cands).sort(v150CompareScored).slice(0, 3);
      return top.map(s => {
        const exclude = new Set([...ownedIds, s.firstId]);
        if (s.sim.my4) exclude.add(s.sim.my4.id);
        (s.sim.my4Fallbacks || []).forEach(x => exclude.add(x.id));
        return { ...disp(s.firstId), road: roadAdvice(s.firstId, exclude, oppPicksAfterMe), v150: s,
                 followup: { kind: 'fourth', ...s.sim, tags: v150Reasons(s) } };
      });
    }
  }
  return null;                                   // nothing applicable → caller falls back to v1.40
}

function buildBoardGeo(mapState) {
  const hexByCoord = {};
  for (const h of Object.values(mapState.tileHexStates || {})) hexByCoord[h.x + ',' + h.y] = { res: HEX_RES[h.type], dice: h.diceNumber || 0 };
  const corners = {};
  for (const [id, c] of Object.entries(mapState.tileCornerStates || {})) {
    const tri = (c.z === 0 ? [[c.x,c.y],[c.x+1,c.y-1],[c.x,c.y-1]] : [[c.x,c.y],[c.x-1,c.y+1],[c.x,c.y+1]]).map(([x,y]) => x + ',' + y);
    const res = tri.map(k => hexByCoord[k]).filter(h => h && h.res !== 'desert');
    corners[id] = { id, tri, res };
  }
  const cornerIds = Object.keys(corners);
  const adj = (a, b) => { let n = 0; for (const t of corners[a].tri) if (corners[b].tri.includes(t)) n++; return n === 2; };
  // Precompute corner adjacency graph (for the distance rule + road/expansion reasoning)
  const neighbors = {};
  for (const id of cornerIds) neighbors[id] = cornerIds.filter(o => o !== id && adj(id, o));

  // Adaptive weights: mild city/dev premium × scarcity × board lean
  const resPips = { wood:0, brick:0, sheep:0, wheat:0, ore:0 };
  for (const h of Object.values(hexByCoord)) if (h.res !== 'desert') resPips[h.res] += SETUP_PIPS[h.dice] || 0;
  const base = { wood:1.0, brick:1.0, sheep:1.0, wheat:1.15, ore:1.1 };
  const arch = boardArchetype(resPips);                          // strategic lean, INTO the board's strong axis
  const lean = arch.lean;
  // weight = base × archetype lean. The old per-board SCARCITY multiplier was removed — it fought the
  // archetype (discounted sheep on an OWS board because sheep was abundant, so brick outranked it) and
  // broke wood≠brick. Coverage of scarce/lacking resources is already handled by the complement +
  // ore/wheat-security bonuses in scoreCorner. So weights depend only on the archetype now → wood
  // always equals brick, and OWS resources always outrank road resources on an OWS board.
  const weights = {};
  for (const r of RESOURCES) weights[r] = base[r] * (lean[r] || 1);

  // v1.50: continuous board lean + interpolated production weights (computed once per board).
  const geoLite = { hexByCoord, corners, cornerIds, adj, resPips };
  const lean150 = v150BoardLean(geoLite);
  const weights150 = v150Weights(lean150);
  const activeWeights = PLACEMENT_SCORER_VERSION === 'v1.50' ? weights150 : weights;

  // Ports → the two corners that carry each port (settlement/city there = the trade rate).
  const cornerPort = {};
  for (const pt of Object.values(mapState.portEdgeStates || {})) {
    const off = EDGE_OFF[pt.z]; if (!off) continue;
    const h1 = pt.x + ',' + pt.y, h2 = (pt.x + off[0]) + ',' + (pt.y + off[1]);
    const ends = cornerIds.filter(id => corners[id].tri.includes(h1) && corners[id].tri.includes(h2));
    const res = PORT_RES[pt.type] || null;
    const info = res ? { ratio: 2, res, label: '2:1 ' + res } : { ratio: 3, res: null, label: '3:1 any' };
    for (const id of ends) cornerPort[id] = info;
  }

  // Edges → the two corners each road connects (same geometry as ports), for road-network reach.
  const edgeCorners = {};
  for (const [eid, e] of Object.entries(mapState.tileEdgeStates || {})) {
    if (e.x === undefined) continue;
    const off = EDGE_OFF[e.z]; if (!off) continue;
    const h1 = e.x + ',' + e.y, h2 = (e.x + off[0]) + ',' + (e.y + off[1]);
    edgeCorners[eid] = cornerIds.filter(id => corners[id].tri.includes(h1) && corners[id].tri.includes(h2));
  }

  return { hexByCoord, corners, cornerIds, adj, neighbors, weights: activeWeights, weights140: weights, weights150, lean150, resPips, cornerPort, edgeCorners, archetype: arch.archetype, owsShare: arch.owsShare, archLabel: arch.label, leanTo: arch.archetype };
}

// A corner is a legal settlement spot if it's unowned and no neighbour is owned (distance rule).
function legalToSettle(id, ownedSet) {
  if (ownedSet.has(id)) return false;
  return !state.board.geo.neighbors[id].some(n => ownedSet.has(n));
}

// Best road direction from a just-placed settlement: aim at the highest-value legal
// expansion corner 2 steps away, penalising ones the opponent can still snipe first.
function roadAdvice(settlementId, ownedSet, oppPicksAfterMe) {
  const geo = state.board.geo;
  // Every legal expansion corner two steps out, across all road directions.
  const byId = {};
  for (const N of geo.neighbors[settlementId]) {                 // road runs settlement → N
    if (ownedSet.has(N)) continue;
    for (const M of geo.neighbors[N]) {
      if (M === settlementId || !legalToSettle(M, ownedSet)) continue;
      // CODE-PATH ISOLATION: under v1.50, rank road targets by v1.50 standalone production — not the
      // v1.40 prior-based bonus score, which would silently leak old scoring into the new advisor.
      const s = scoreCorner(M, null, null);
      if (PLACEMENT_SCORER_VERSION === 'v1.50') s.score = v150StandaloneCorner(geo, M, geo.weights150 || geo.weights);
      if (!byId[M] || s.score > byId[M].score) byId[M] = s;      // best per target (reachable ≥1 way)
    }
  }
  const ranked = Object.values(byId).sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const toward = ranked[0];
  // Contest risk: opponent still places after me and the target is strong enough to deny.
  const contest = oppPicksAfterMe > 0 && toward.pips >= 8;
  // Backup must stay legal if the primary target is taken → not adjacent to it.
  const alt = ranked.slice(1).find(s => !geo.adj(s.id, toward.id)) || null;
  return { toward, alt, contest, val: toward.score, options: ranked.length };
}

// If you're first, simulate the opponent taking their two best spots, then your best #4 complement.
function fourthPickSim(myFirstId, ownedSet) {
  const geo = state.board.geo;
  const owned = new Set(ownedSet); owned.add(myFirstId);
  const avail = () => geo.cornerIds.filter(id => legalToSettle(id, owned));
  const take = () => { const s = avail().map(id => scoreCorner(id, null, null)).sort((a, b) => b.score - a.score)[0]; if (s) { owned.add(s.id); } return s; };
  const opp1 = take(), opp2 = take();                            // opponent's likely picks #2,#3
  const priorRes = new Set(), priorNum = new Set();
  for (const h of geo.corners[myFirstId].res) { priorRes.add(h.res); priorNum.add(h.dice); }
  const my4Ranked = avail().map(id => scoreCorner(id, priorRes, priorNum)).sort((a, b) => b.score - a.score);
  const my4 = my4Ranked[0];
  // Fallbacks assume the opponent grabbed my #4 → exclude it AND its now-illegal neighbours.
  const my4Fallbacks = my4 ? my4Ranked.filter(s => s.id !== my4.id && !geo.adj(s.id, my4.id)).slice(0, 2) : [];
  return { my4, my4Fallbacks, oppLikely: [opp1, opp2].filter(Boolean) };
}

// ─── Second-seat opening: joint pair optimizer ─────────────────────────────
// The 2nd player places settlements #2 and #3 back-to-back, so its real edge is choosing the best
// coordinated PAIR — not the best single spot then a reaction (what a greedy ranker does). Score a
// pair by its JOINT value: each corner scored, the second crediting the first as its "prior" so
// complement value counts, taking whichever placement order is better; then add coordination bonuses
// on the COMBINED profile + a MODERATE tempo lean (2nd is behind on initiative → nudge toward a port
// trade-engine and a strong 6/8 that leapfrogs, only when it's otherwise close). `scoreFn(id,pr,pn)`
// wraps scoreCorner (live) or reviewScoreCorner (Review) so both judge 2nd-seat openings identically.
function scoreOpeningPair(geo, A, B, scoreFn) {
  const resPipsAt = (id, res) => geo.corners[id].res.reduce((s, h) => s + (h.res === res ? (SETUP_PIPS[h.dice] || 0) : 0), 0);
  const s1 = A.score + scoreFn(B.id, new Set(A.kinds), new Set(A.nums)).score;   // place A first, B complements
  const s2 = B.score + scoreFn(A.id, new Set(B.kinds), new Set(B.nums)).score;   // place B first, A complements
  const [first, second] = s1 >= s2 ? [A, B] : [B, A];
  let joint = Math.max(s1, s2);
  const kinds = new Set([...A.kinds, ...B.kinds]);
  const nums = [...A.nums, ...B.nums];
  const wheatP = resPipsAt(A.id, 'wheat') + resPipsAt(B.id, 'wheat');
  const oreP   = resPipsAt(A.id, 'ore')   + resPipsAt(B.id, 'ore');
  const tags = [];
  // Coordination on the combined profile — the way a 15-VP game is won.
  if (kinds.has('ore') && kinds.has('wheat') && wheatP >= 3 && oreP >= 3) { joint += 1.0; tags.push('ore+wheat city engine'); }
  if (kinds.size >= 4) { joint += (kinds.size - 3) * 0.3; tags.push(kinds.size + ' resources'); }
  // Moderate tempo lean (only the 2nd-seat path calls this): a port that pays off across the pair,
  // plus at least one strong 6/8 for faster builds.
  const ports = [geo.cornerPort[A.id], geo.cornerPort[B.id]].filter(Boolean);
  for (const pt of ports) {
    if (pt.ratio === 2 && kinds.has(pt.res)) { joint += 0.6; tags.push('2:1 ' + pt.res + ' engine'); }
    else if (pt.ratio === 3) { joint += 0.25; tags.push('3:1 port'); }
  }
  if (nums.some(n => n === 6 || n === 8)) { joint += 0.3; tags.push('strong 6/8'); }
  const highs = nums.filter(n => n === 6 || n === 8);
  if (highs.length >= 2 && new Set(highs).size === 1) joint -= 0.4;   // don't stack the whole engine on ONE hot number
  return { first, second, joint, tags };
}

// Rank all non-adjacent pairs of legal corners by joint value (top 24 singles → ≤276 pairs, cheap).
function rankOpeningPairs(geo, legalIds, scoreFn) {
  const base = legalIds.map(id => scoreFn(id)).sort((a, b) => b.score - a.score).slice(0, 24);
  const pairs = [];
  for (let i = 0; i < base.length; i++)
    for (let j = i + 1; j < base.length; j++)
      if (!geo.adj(base[i].id, base[j].id)) pairs.push(scoreOpeningPair(geo, base[i], base[j], scoreFn));
  pairs.sort((x, y) => y.joint - x.joint);
  return pairs;
}

function scoreCorner(id, priorRes, priorNum) {
  const geo = state.board.geo, c = geo.corners[id], W = geo.weights;
  let pips = 0, wprod = 0; const kinds = new Set(), nums = [];
  for (const h of c.res) { const p = SETUP_PIPS[h.dice] || 0; pips += p; wprod += p * (W[h.res] || 1); kinds.add(h.res); nums.push(h.dice); }
  let bonus = (kinds.size - 1) * 0.6;                             // diversity (mild tie-breaker only)

  // Wheat/ore VALUE now lives in the resource weights above (a modest tilt), NOT in a big additive
  // bonus — so raw production (pips) leads. Keep only a small ore+wheat "city-engine" nudge, and
  // only when the wheat is reliable (≥3 pips) — a token 2/12-wheat isn't a city engine.
  const wheatPips = c.res.reduce((s, h) => s + (h.res === 'wheat' ? (SETUP_PIPS[h.dice] || 0) : 0), 0);
  const orePips   = c.res.reduce((s, h) => s + (h.res === 'ore'   ? (SETUP_PIPS[h.dice] || 0) : 0), 0);
  if (kinds.has('ore') && wheatPips >= 3) bonus += 0.5;

  if (priorRes) {
    for (const k of kinds) if (!priorRes.has(k)) bonus += 1.0;     // covers a resource you lack
    const has68 = nums.some(n => n === 6 || n === 8);
    const priorHas68 = priorNum && [...priorNum].some(n => n === 6 || n === 8);
    if (has68 && !priorHas68) bonus += 0.8;                        // adds a strong 6/8
    // CITY-ENGINE SECURITY: cities/dev need BOTH ore and wheat. On the complement pick, gently steer
    // to whichever the OTHER settlement lacks, and PENALISE ending up unable to build cities.
    if (!priorRes.has('wheat')) { bonus += wheatPips * 0.2;  if (wheatPips < 3) bonus -= 2.0; }
    if (!priorRes.has('ore'))   { bonus += orePips   * 0.2;  if (orePips   < 3) bonus -= 1.5; }
  }

  // Port bonus (scaled to the smaller bonus budget so it doesn't out-weigh production).
  const port = geo.cornerPort && geo.cornerPort[id];
  if (port) {
    if (port.ratio === 3) bonus += 0.7;
    else {
      let syn = 0.6;                                               // base: you can build toward it
      if (kinds.has(port.res)) syn += 1.2;                        // this corner makes the match
      else if (priorRes && priorRes.has(port.res)) syn += 0.9;    // pairs with your other spot
      if (port.res === 'ore' || port.res === 'wheat') syn += 0.2; // city-engine premium
      bonus += syn;
    }
  }

  const portTag = port ? ` ⚓${port.label}` : '';
  const label = (c.res.slice().sort((a, b) => (SETUP_PIPS[b.dice] || 0) - (SETUP_PIPS[a.dice] || 0))
    .map(h => `${h.dice}-${h.res}`).join(' / ') || 'coast (no production)') + portTag;
  return { id, pips, score: wprod + bonus, kinds: [...kinds], nums, label, port };
}

// ─── Turn Coach (mid-game) ─────────────────────────────────────────────────
function myBuildings(bt) {
  return Object.entries(state.cornerOwner)
    .filter(([, cv]) => String(cv.owner) === state.myColor && cv.buildingType === bt)
    .map(([id]) => id);
}
function bestCityTarget() {
  if (!state.board || !state.board.geo) return null;
  const setts = myBuildings(1).filter(id => state.board.geo.corners[id]);
  if (!setts.length) return null;
  return setts.map(id => scoreCorner(id, null, null)).sort((a, b) => b.pips - a.pips)[0];
}

// ─── WIN-PATH ENGINE (v1.61) ─────────────────────────────────────────────────
// The old coach ran a FIXED ladder (city > settlement > dev > road) and was score-blind: it gave
// identical advice at 3 VP and at 14 VP. This engine reads the live score of both players and asks
// "what is the fastest legal route to 15 from here, and is the opponent about to get there first?"
//
// HONESTY RULES, enforced throughout:
//   · My own VP is EXACT (validated 165/165 against end-game truth).
//   · The opponent's VP is only what is VISIBLE. Their unplayed dev-card count is a rule-guaranteed
//     UPPER BOUND on hidden VP — never an assumption that they hold any.
//   · No dice prediction. "Affordable" means affordable from cards in hand, now.

function vpOf(color) {
  const cats = state.vp[String(color)] || {};
  let t = 0;
  for (const [cat, n] of Object.entries(cats)) t += (VP_CATEGORY_POINTS[cat] || 0) * (n || 0);
  return t;
}
function holdsAward(which, color) {
  const m = which === 'la' ? state.awards.la : state.awards.lr;
  const v = m[String(color)];
  return !!(v && (which === 'la' ? v.hasLargestArmy : v.hasLongestRoad));
}
function myKnightsInHand() { return (state.myDevCards || []).filter(e => e === 11).length; }

// Can `cost` be paid from `hand`, counting bank/port trades of genuinely spare cards?
// Returns { afford, missing:{res:n}, trades:[{give,n,get}], shortfall }.
function payFor(cost, hand) {
  const missing = {}; let short = 0;
  for (const r of RESOURCES) {
    const d = (cost[r] || 0) - (hand[r] || 0);
    if (d > 0) { missing[r] = d; short += d; }
  }
  if (!short) return { afford: true, missing: {}, trades: [], shortfall: 0 };
  // Spare = what's left after reserving the cost itself. Only spares may be traded away.
  const ratios = state.tradeRatios[state.myColor] || {};
  const ratioOf = r => {
    const e = Object.keys(RES_ENUM).find(k => RES_ENUM[k] === r);
    const v = e != null ? ratios[e] : null;
    return typeof v === 'number' && v > 0 ? v : 4;
  };
  const spare = {}; for (const r of RESOURCES) spare[r] = Math.max(0, (hand[r] || 0) - (cost[r] || 0));
  const trades = []; let remaining = 0;
  for (const [need, n] of Object.entries(missing)) {
    let got = 0;
    // Spend the cheapest ratios first, and the biggest piles first within a ratio.
    const givers = RESOURCES.filter(r => r !== need && spare[r] >= ratioOf(r))
      .sort((a, b) => (ratioOf(a) - ratioOf(b)) || (spare[b] - spare[a]));
    for (const g of givers) {
      while (got < n && spare[g] >= ratioOf(g)) { spare[g] -= ratioOf(g); got++; trades.push({ give: g, n: ratioOf(g), get: need }); }
      if (got >= n) break;
    }
    remaining += (n - got);
  }
  return { afford: remaining === 0, missing, trades, shortfall: remaining };
}

// Everything the recommendation needs, computed once per render.
function winPathFacts() {
  const me = state.myColor, op = state.oppColor;
  const hand = player(me).hand;
  const vpToWin = state.vpToWin || 15;
  const myVP = vpOf(me);
  const oppVisible = op ? vpOf(op) : 0;
  // Rule-guaranteed bound: a VP card is never played, so it is always still in hand. Observed to
  // hold in 165/165 games, with 0 violations.
  const oppHiddenMax = op ? (state.devCount[op] || 0) : 0;
  const oppCeiling = oppVisible + oppHiddenMax;

  const myKnightsPlayed = state.knights[me] || 0;
  const oppKnightsPlayed = op ? (state.knights[op] || 0) : 0;
  const iHaveLA = holdsAward('la', me), oppHasLA = op ? holdsAward('la', op) : false;
  const iHaveLR = holdsAward('lr', me), oppHasLR = op ? holdsAward('lr', op) : false;
  const knightsInHand = myKnightsInHand();
  // Knights needed to TAKE Largest Army: 3 minimum, and strictly more than the current holder.
  const laTarget = oppHasLA ? Math.max(LA_MIN_KNIGHTS, oppKnightsPlayed + 1) : LA_MIN_KNIGHTS;
  const laNeed = iHaveLA ? 0 : Math.max(0, laTarget - myKnightsPlayed);

  const myRoad = state.roadLen[me] || 0, oppRoad = op ? (state.roadLen[op] || 0) : 0;
  const lrTarget = oppHasLR ? Math.max(LR_MIN_ROADS, oppRoad + 1) : LR_MIN_ROADS;
  const lrNeed = iHaveLR ? 0 : Math.max(0, lrTarget - myRoad);

  const deckLeft = state.dev.bankRemaining == null ? 99 : state.dev.bankRemaining;
  const owned = new Set(Object.keys(state.cornerOwner));
  const cityT = bestCityTarget();
  const reach = reachableSettleNow(owned).map(id => scoreCorner(id, null, null)).sort((a, b) => b.score - a.score);

  const costs = { city: { wheat: 2, ore: 3 }, settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
                  dev: { sheep: 1, wheat: 1, ore: 1 }, road: { wood: 1, brick: 1 } };
  const pay = {};
  for (const k of Object.keys(costs)) pay[k] = payFor(costs[k], hand);
  // A city REPLACES a settlement: 2 VP − 1 VP already counted = net +1.
  const cityAvailable = !!cityT;
  const settleAvailable = reach.length > 0;
  const devAvailable = deckLeft > 0;

  return {
    me, op, hand, vpToWin, myVP, oppVisible, oppHiddenMax, oppCeiling,
    need: Math.max(0, vpToWin - myVP),
    myKnightsPlayed, oppKnightsPlayed, knightsInHand, iHaveLA, oppHasLA, laNeed, laTarget,
    myRoad, oppRoad, iHaveLR, oppHasLR, lrNeed,
    deckLeft, cityT, reach, costs, pay, cityAvailable, settleAvailable, devAvailable,
    prod: myResProd(), owned,
    opp7: op ? (dicePredict(state.dice, op)[7] || 0) : 0,
    total: handSum(hand), overLimit: handSum(hand) > state.discardLimit,
  };
}

// Threat level from the opponent's position. Deliberately separates what is CERTAIN (their visible
// score) from what is POSSIBLE (hidden VP cards) — we never assume they hold any.
function oppThreat(F) {
  if (!F.op) return { level: 'none', why: '' };
  if (F.oppCeiling >= F.vpToWin) {
    // Qualitative on purpose. The card count drives the tier but is NOT shown — Colonist already
    // displays it, and naming a number here would also imply they hold VP cards, which we don't know.
    return { level: 'critical', why: F.oppHiddenMax > 0
      ? 'Opponent may already have enough hidden points to win on their turn.'
      : 'Opponent can win on their turn.' };
  }
  if (F.oppVisible >= F.vpToWin - 2) return { level: 'high', why: 'Opponent is within one build or award of winning.' };
  if (F.oppVisible >= F.vpToWin - 4) return { level: 'moderate', why: '' };
  return { level: 'low', why: '' };
}

function computeTurnCoach() {
  if (!state.gameActive || !state.myColor) return { active: false };
  const setupDone = state.rolls.length > 0 || Object.keys(state.cornerOwner).length >= 4;
  if (!setupDone) return { active: false };                        // setup advisor owns this phase
  if (state.currentTurnColor && state.currentTurnColor !== state.myColor) return { active: false };

  const h = player(state.myColor).hand;
  const total = handSum(h);
  const deckLeft = state.dev.bankRemaining == null ? 99 : state.dev.bankRemaining;
  const F = winPathFacts();
  const plan = winPathPlan(F);
  return { active: true, plan, facts: F, robber: state.robberPending ? computeRobberAdvice() : null };
}

// Build the ranked candidate actions, then pick by TIER. Each candidate carries the VP it certainly
// adds now, so "does this win outright?" is a comparison, not a special case.
function winPathCandidates(F) {
  const C = [];
  const r = x => Math.round(x * 100) / 100;

  // Playing a knight already in hand costs NOTHING. If it completes Largest Army it is +2 VP for
  // free — the single most-missed winning move, so it is always considered first.
  if (F.knightsInHand > 0 && !F.iHaveLA && F.laNeed > 0 && F.knightsInHand >= F.laNeed) {
    C.push({ key: 'knight', vp: AWARD_VP, free: true,
      do: F.laNeed === 1 ? 'Play a KNIGHT' : `Play ${F.laNeed} KNIGHTS`,
      why: `Takes Largest Army (+${AWARD_VP} VP)${F.oppHasLA ? ' off the opponent' : ''} — and it costs you nothing but the card.`,
      bottleneck: null });
  } else if (F.knightsInHand > 0 && !F.iHaveLA && F.laNeed > F.knightsInHand) {
    C.push({ key: 'knight-partial', vp: 0, free: true,
      do: 'Play a KNIGHT', why: `Moves you toward Largest Army — ${F.laNeed} more knight${F.laNeed > 1 ? 's' : ''} needed.`,
      bottleneck: `${F.laNeed} more knight${F.laNeed > 1 ? 's' : ''} for Largest Army` });
  }

  if (F.cityAvailable) {
    const p = F.pay.city;
    C.push({ key: 'city', vp: 1, afford: p.afford, pay: p, prodGain: cityProdGain(F.cityT),
      do: `Build a CITY on your ${F.cityT.label}`,
      why: `+1 VP and doubles that hex${F.cityT.pips ? ` (${F.cityT.pips}p)` : ''}.`,
      bottleneck: shortfallText(p) });
  }
  if (F.settleAvailable) {
    const p = F.pay.settlement, t = F.reach[0];
    C.push({ key: 'settlement', vp: 1, afford: p.afford, pay: p, prodGain: t.pips ? t.pips / 36 : 0,
      do: `Build a SETTLEMENT at ${t.label} (${t.pips}p)`,
      why: '+1 VP and new production — your roads already reach it.',
      bottleneck: shortfallText(p) });
  }
  if (F.devAvailable) {
    const p = F.pay.dev;
    C.push({ key: 'dev', vp: 0, afford: p.afford, pay: p,
      do: 'Buy a DEV card',
      why: F.laNeed > 0 && !F.iHaveLA
        ? `${F.deckLeft === 99 ? '' : F.deckLeft + ' left · '}knights drive Largest Army (${F.laNeed} more needed) and a VP card can win outright.`
        : `${F.deckLeft === 99 ? '' : F.deckLeft + ' left · '}a VP card can win outright.`,
      bottleneck: shortfallText(p) });
  }
  // A road only matters for VP if it can actually take Longest Road — and only if that is a
  // REACHABLE ambition. Suggesting a road when the award is 9 segments away is noise, not advice.
  if (F.lrNeed > 0 && F.lrNeed <= LR_CHASE_MAX && !F.iHaveLR) {
    const p = F.pay.road;
    C.push({ key: 'road-lr', vp: F.lrNeed === 1 ? AWARD_VP : 0, afford: p.afford, pay: p, speculative: F.lrNeed === 1,
      do: 'Build a ROAD that extends your longest chain',
      why: F.lrNeed === 1
        ? `One segment takes Longest Road (+${AWARD_VP} VP)${F.oppHasLR ? ' off the opponent' : ''} — if it extends the END of your chain.`
        : `${F.lrNeed} more segments would take Longest Road (+${AWARD_VP} VP).`,
      bottleneck: p.afford ? `${F.lrNeed} road segment${F.lrNeed > 1 ? 's' : ''} from Longest Road` : shortfallText(p) });
  }
  // Expansion road when a settlement is affordable but nothing legal is reachable.
  if (!F.settleAvailable) {
    const exp = bestExpansion(F.owned); const p = F.pay.road;
    if (exp) C.push({ key: 'road-expand', vp: 0, afford: p.afford, pay: p, prodGain: exp.pips ? exp.pips / 36 : 0,
      do: `Build a ROAD toward ${exp.label} (${exp.pips}p)`,
      why: 'No legal settlement spot on your network yet — extend first, then settle.',
      bottleneck: p.afford ? 'no legal settlement spot on your network' : shortfallText(p) });
  }
  return C;
}

function shortfallText(p) {
  if (p.afford) return null;
  const parts = Object.entries(p.missing).map(([r, n]) => `${n} ${r}`);
  return parts.join(' + ') + ' short';
}
// Extra expected cards/roll from upgrading this settlement to a city (it doubles every adjacent hex).
function cityProdGain(t) {
  const geo = state.board && state.board.geo;
  if (!geo || !t || !geo.corners[t.id]) return 0;
  let g = 0;
  for (const hx of geo.corners[t.id].res) g += (EXPECTED[hx.dice] || 0) / 36;
  return g;
}

// ── The tiered decision. NOT a rigid ladder: a guaranteed win always outranks defence, and a
// speculative route never displaces a reliable one without a reason.
function winPathPlan(F) {
  const C = winPathCandidates(F);
  const threat = oppThreat(F);
  const byVal = (a, b) => (b.vp - a.vp) || ((b.prodGain || 0) - (a.prodGain || 0));
  const playable = c => c.free || c.afford;

  // TIER 1 — can I legally reach the target RIGHT NOW?
  // The action must actually CLOSE the gap: `c.vp >= F.need` with `need > 0`. Testing
  // `myVP + c.vp >= vpToWin` alone would mark a 0-VP road as "the winning move" whenever the score
  // is already at the target (seen in real replays once the final build lands).
  const canWin = c => F.need > 0 && c.vp > 0 && c.vp >= F.need;
  const winners = C.filter(c => playable(c) && !c.speculative && canWin(c)).sort(byVal);
  const specWinners = C.filter(c => playable(c) && c.speculative && canWin(c));
  if (winners.length) {
    const w = winners[0];
    return {
      tier: 'win', objective: `Win now — this reaches ${F.vpToWin}`,
      bottleneck: w.pay && w.pay.trades.length ? tradeText(w.pay) : 'none — you can do this on this turn',
      primary: { do: w.do, why: `This is the winning move. ${w.why}` },
      alternative: altFrom(C, w, F),
      changesIf: null, threat,
    };
  }
  if (specWinners.length) {
    const w = specWinners[0];
    return {
      tier: 'win-maybe', objective: `Possible win — Longest Road would reach ${F.vpToWin}`,
      bottleneck: w.bottleneck,
      primary: { do: w.do, why: `${w.why} Check it genuinely lengthens your longest chain before committing.` },
      alternative: altFrom(C, w, F), changesIf: null, threat,
    };
  }

  // TIER 2 — the opponent may be able to win on their next turn. Only act on it if there is
  // something real to do: protecting or denying an award is the only true denial in 1v1.
  if (threat.level === 'critical' || threat.level === 'high') {
    const deny = C.find(c => playable(c) && c.vp >= AWARD_VP);        // taking an award is −2 for them
    const fastest = C.filter(playable).sort(byVal)[0];
    const pick = deny || fastest;
    const losable = (F.iHaveLA && F.oppKnightsPlayed >= F.myKnightsPlayed - 1)
      || (F.iHaveLR && F.oppRoad >= F.myRoad - 1);
    // Keep the urgency even when nothing is affordable — the right action is then to trade or
    // spend down, but the player still needs to know this is a race, not a building turn.
    const act = pick ? { do: pick.do, why: `${pick.why} ${threat.why}`.trim() }
                     : (() => { const l = decideHoldOrTrade(F.hand, F.prod, F.opp7, F.overLimit, F.total);
                                return { do: l.do, why: `${l.why} ${threat.why}`.trim() }; })();
    return {
      tier: 'defend',
      objective: deny ? 'Deny the opponent — take an award before they close' : `Race — the opponent is close to ${F.vpToWin}`,
      bottleneck: (pick && pick.bottleneck)
        || (losable ? 'an award you hold is one play from changing hands'
                    : pick ? 'speed — you need VP faster than they do'
                           : bottleneckOf(F)),
      primary: act,
      alternative: pick ? altFrom(C, pick, F) : altFrom(C, null, F),
      changesIf: losable ? `they take Largest Army or Longest Road from you — a ${2 * AWARD_VP}-VP swing` : null,
      threat,
    };
  }

  // TIER 3 — near the target: prefer whatever adds VP soonest.
  if (F.need <= 3) {
    const vpNow = C.filter(c => playable(c) && c.vp > 0).sort(byVal)[0];
    const vpSoon = C.filter(c => c.vp > 0).sort(byVal)[0];
    const pick = vpNow || vpSoon;
    if (pick) {
      return {
        tier: 'closing', objective: `Close out the game — ${F.need} VP to go`,
        bottleneck: pick.bottleneck || 'none — you can do this on this turn',
        primary: { do: pick.do, why: pick.why },
        alternative: altFrom(C, pick, F),
        changesIf: F.laNeed > 0 && F.laNeed <= 2 && !F.iHaveLA
          ? `you reach ${F.laTarget} knights — Largest Army is +${AWARD_VP} VP and may be faster than building`
          : null,
        threat,
      };
    }
  }

  // TIER 4 — no near-term win: build the engine. Production gain decides, not a fixed order.
  const affordable = C.filter(playable);
  if (affordable.length) {
    const pick = affordable.sort((a, b) => ((b.prodGain || 0) - (a.prodGain || 0)) || (b.vp - a.vp))[0];
    return {
      tier: 'engine', objective: engineObjective(F),
      bottleneck: pick.bottleneck || bottleneckOf(F),
      primary: { do: pick.do, why: pick.why },
      alternative: altFrom(C, pick, F),
      changesIf: F.oppVisible >= F.vpToWin - 4 ? 'the opponent gets within 2 VP — then switch to racing or denial' : null,
      threat,
    };
  }

  // TIER 5 — nothing affordable: trade, or hold deliberately.
  const legacy = decideHoldOrTrade(F.hand, F.prod, F.opp7, F.overLimit, F.total);
  const blocked = C.filter(c => !playable(c)).sort(byVal)[0];
  return {
    tier: 'fallback', objective: engineObjective(F),
    bottleneck: (blocked && blocked.bottleneck) || bottleneckOf(F),
    primary: { do: legacy.do, why: legacy.why },
    alternative: blocked ? { do: blocked.do, why: `Blocked: ${blocked.bottleneck}.` } : null,
    changesIf: blocked && blocked.pay && !blocked.pay.afford
      ? `you draw ${Object.entries(blocked.pay.missing).map(([r, n]) => `${n} ${r}`).join(' + ')}`
      : null,
    threat,
  };
}

function tradeText(pay) {
  if (!pay || !pay.trades.length) return 'none — you can do this on this turn';
  const t = pay.trades.map(x => `${x.n} ${x.give} → 1 ${x.get}`);
  return 'bank trade: ' + t.join(', ');
}
function altFrom(C, chosen, F) {
  const rest = C.filter(c => c !== chosen);
  if (!rest.length) return null;
  const playableRest = rest.filter(c => c.free || c.afford).sort((a, b) => (b.vp - a.vp) || ((b.prodGain || 0) - (a.prodGain || 0)));
  const pick = playableRest[0] || rest.sort((a, b) => (b.vp - a.vp))[0];
  const note = (pick.free || pick.afford) ? pick.why : `Not yet — ${pick.bottleneck}.`;
  return { do: pick.do, why: note };
}
function engineObjective(F) {
  const cities = myBuildings(2).length;
  if (!cities) return 'Build your engine toward your first city';
  if (F.laNeed > 0 && F.laNeed <= 2 && !F.iHaveLA) return `Push for Largest Army — ${F.laNeed} more knight${F.laNeed > 1 ? 's' : ''}`;
  if (F.need > 6) return 'Grow production — more cities and better corners';
  return `Build toward ${F.vpToWin} — ${F.need} VP to go`;
}
// The resource most limiting my next meaningful build, weighted by how little I make of it.
function bottleneckOf(F) {
  const want = F.cityAvailable ? F.costs.city : F.costs.settlement;
  const gaps = [];
  for (const r of RESOURCES) {
    const d = (want[r] || 0) - (F.hand[r] || 0);
    if (d > 0) gaps.push({ r, d, prod: F.prod[r] || 0 });
  }
  if (!gaps.length) return 'none — you can build now';
  gaps.sort((a, b) => (a.prod - b.prod) || (b.d - a.d));
  const g = gaps[0];
  return g.prod < 0.04
    ? `${g.d} ${g.r} short — and you produce almost no ${g.r}, so trade for it`
    : `${g.d} ${g.r} short (you make ${g.prod.toFixed(2)}/roll)`;
}

// My expected cards/roll for each resource, from my current buildings (city = ×2).
function myResProd() {
  const p = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  const geo = state.board && state.board.geo; if (!geo) return p;
  for (const [cid, cv] of Object.entries(state.cornerOwner)) {
    if (String(cv.owner) !== state.myColor) continue;
    const corner = geo.corners[cid]; if (!corner) continue;
    const w = cv.buildingType === 2 ? 2 : 1;
    for (const hx of corner.res) p[hx.res] = (p[hx.res] || 0) + w * ((EXPECTED[hx.dice] || 0) / 36);
  }
  return p;
}

// Corners connected to my stuff (my buildings + my roads' endpoints).
function myNetworkCorners() {
  const geo = state.board && state.board.geo; const set = new Set();
  if (!geo) return set;
  for (const [cid, cv] of Object.entries(state.cornerOwner)) if (String(cv.owner) === state.myColor) set.add(cid);
  for (const [eid, owner] of Object.entries(state.edgeOwner)) if (String(owner) === state.myColor) (geo.edgeCorners[eid] || []).forEach(c => set.add(c));
  return set;
}
function reachableSettleNow(ownedSet) {
  return [...myNetworkCorners()].filter(id => legalToSettle(id, ownedSet));
}
// Best legal corner one road-step out from my network — a road target when I can't settle now.
function bestExpansion(ownedSet) {
  const geo = state.board && state.board.geo; if (!geo) return null;
  const net = myNetworkCorners(); let best = null;
  for (const nc of net) {
    for (const nb of geo.neighbors[nc] || []) {
      const cand = legalToSettle(nb, ownedSet) ? nb : (geo.neighbors[nb] || []).find(m => legalToSettle(m, ownedSet));
      if (!cand) continue;
      const s = scoreCorner(cand, null, null);
      if (!best || s.score > best.score) best = s;
    }
  }
  return best;
}

// Can't afford a strong build → decide the smart move. Default is HOLD (a 4:1 trade wastes
// cards); only trade when a discard threat looms or a build is genuinely stuck on a resource
// I don't produce. Considers my board's production and the opponent's 7 risk.
function decideHoldOrTrade(h, prod, opp7, overLimit, total) {
  const targets = [
    { name: 'city', cost: { ore: 3, wheat: 2 }, val: 5 },
    { name: 'settlement', cost: { wood: 1, brick: 1, sheep: 1, wheat: 1 }, val: 4 },
    { name: 'dev card', cost: { sheep: 1, wheat: 1, ore: 1 }, val: 2.5 },
  ].map(t => {
    const miss = []; let count = 0;
    for (const [r, n] of Object.entries(t.cost)) { const d = n - (h[r] || 0); if (d > 0) { miss.push(r); count += d; } }
    return Object.assign(t, { miss, count });
  }).filter(t => t.count > 0).sort((a, b) => (b.val - b.count * 0.8) - (a.val - a.count * 0.8));

  const tgt = targets[0];
  if (!tgt) return { do: 'Build the strongest piece you can afford', why: '' };
  const iMake = tgt.miss.filter(r => prod[r] >= 0.10);
  const cantMake = tgt.miss.filter(r => prod[r] < 0.04);
  const pct7 = Math.round(opp7 * 100);

  // Discard threat: over the limit AND opponent's 7 is real → act, don't sit fat.
  if (overLimit && opp7 >= 0.13) {
    const give = RESOURCES.find(r => (h[r] || 0) >= 4);
    if (give && cantMake.length) return { do: `Trade 4 ${give} → 1 ${cantMake[0]} (bank)`, why: `You're holding ${total} (limit ${state.discardLimit}) and opp's 7 chance is ${pct7}% — turn dead cards into a ${tgt.name} before you get robbed.` };
    return { do: 'Spend or trade down now', why: `You're at ${total} (limit ${state.discardLimit}) with a ${pct7}% opponent 7 — don't risk losing half your hand.` };
  }
  // I produce everything I'm short on → HOLD (trading 4:1 would waste cards).
  if (iMake.length === tgt.miss.length && !overLimit) {
    return { do: 'Hold — build next turn', why: `You're ${tgt.count} card${tgt.count > 1 ? 's' : ''} from a ${tgt.name} and you produce ${tgt.miss.join(' & ')} yourself. Trading 4:1 wastes cards; 7 risk is only ${pct7}%.` };
  }
  // Stuck on a resource I don't make, with surplus to spare → trade to finish.
  if (cantMake.length && tgt.count <= 2) {
    const give = RESOURCES.find(r => (h[r] || 0) - (tgt.cost[r] || 0) >= 4);
    if (give) return { do: `Trade 4 ${give} → 1 ${cantMake[0]} (bank)`, why: `You don't produce ${cantMake[0]} and it's the last piece for a ${tgt.name}. Only worth it because you're stuck for it.` };
  }
  // Otherwise gather.
  return { do: 'Hold and gather', why: `Nothing worth building yet — you're working toward a ${tgt.name} (need ${tgt.miss.join(', ')}). 7 risk is ${pct7}%, so it's safe to keep your cards.` };
}

// ─── Robber placement advice (fires when I owe a robber move: my 7 or my knight) ──
// Rank every producing hex by how much it HURTS the opponent and how likely its
// number is to roll — using the live balanced-dice odds (which already fold in the
// numbers rolled so far), the opponent's buildings on it, and this board's resource
// value. Hexes that also block my own production are penalised.
function computeRobberAdvice() {
  const geo = state.board && state.board.geo;
  if (!geo) return { fallback: true };

  // Non-7 roll probabilities are roller-independent, so a null roller is fine here.
  const P = dicePredict(state.dice, null);
  const cands = [];

  for (const [hexKey, hx] of Object.entries(geo.hexByCoord)) {
    if (!hx || hx.res === 'desert' || !hx.dice) continue;      // desert / sea produces nothing
    let oppW = 0, myW = 0; const oppColors = new Set();
    for (const id of geo.cornerIds) {
      if (!geo.corners[id].tri.includes(hexKey)) continue;      // corner touches this hex?
      const own = state.cornerOwner[id];
      if (!own || own.owner === undefined || own.owner === null) continue;
      const w = own.buildingType === 2 ? 2 : 1;                 // city counts double
      if (String(own.owner) === state.myColor) myW += w;
      else { oppW += w; oppColors.add(String(own.owner)); }
    }
    if (oppW <= 0) continue;                                    // must sit on an opponent building
    const p = P[hx.dice] || 0;
    const rw = geo.weights[hx.res] || 1;                        // this board's value for the resource
    const score = (oppW - myW * 0.8) * p * rw;                  // deny opp production; penalise self-block
    cands.push({ res: hx.res, dice: hx.dice, p, oppW, myW, score });
  }

  cands.sort((a, b) => b.score - a.score);
  const o = opp();
  const steal = o ? o.total : 0;
  return { fallback: false, top: cands.slice(0, 3), stealCount: steal };
}

function computeSetupAdvice() {
  const b = state.board && state.board.geo;
  if (!b) return { active: false };
  if (state.rolls.length > 0) return { active: false };            // setup ends at the first roll
  const owned = state.cornerOwner || {};
  const ownedIds = Object.keys(owned);
  if (!state.myColor) return { active: true, msg: 'Detecting your colour…' };

  const order = (state.playOrder && state.playOrder.length === 2) ? state.playOrder : null;
  const myPlaced = ownedIds.filter(id => String(owned[id].owner) === state.myColor).length;
  const myRoads = player(state.myColor).roads;                     // setup roads (rolls===0 ⇒ setup only)

  // Setup is done for me once both settlements AND both roads are down — then hand off.
  if (myPlaced >= 2 && myRoads >= 2) return { active: false };

  // In setup each settlement is immediately followed by its road. If I've placed a
  // settlement but not yet its road, guide that road (aimed from the just-placed spot).
  if (myPlaced > myRoads) {
    const ownedSetR = new Set(ownedIds);
    const sid = state.setupMySettles[myRoads];                     // settlement whose road is pending
    const amFirstR = order ? order[0] === state.myColor : null;
    // Placing your FIRST setup road: your OTHER setup settlement isn't down yet. A setup road should
    // open a lane to a corner you'd have to BUILD later — never at a spot you'll settle for FREE next.
    // So exclude your planned next settlement (2nd seat → best complement placed immediately; 1st seat
    // → your simulated #4) from the road's targets.
    if (sid && b.corners[sid] && myPlaced === 1 && myRoads === 0) {
      let planId = null;
      if (amFirstR === false) {
        const aRes = new Set(), aNum = new Set();
        for (const h of b.corners[sid].res) { aRes.add(h.res); aNum.add(h.dice); }
        const planB = b.cornerIds
          .filter(id => !ownedSetR.has(id) && !ownedIds.some(o => b.adj(id, o)) && !b.adj(id, sid))
          .map(id => scoreCorner(id, aRes, aNum)).sort((x, y) => y.score - x.score)[0];
        planId = planB && planB.id;
      } else if (amFirstR === true) {
        const sim = fourthPickSim(sid, new Set(ownedIds));
        planId = sim.my4 && sim.my4.id;
      }
      if (planId) ownedSetR.add(planId);
    }
    let road = (sid && b.corners[sid]) ? roadAdvice(sid, ownedSetR, 0) : null;
    if (!road) {                                                   // fallback: best road across my settlements
      for (const s of ownedIds.filter(id => String(owned[id].owner) === state.myColor && b.corners[id])) {
        const ra = roadAdvice(s, ownedSetR, 0);
        if (ra && (!road || ra.val > road.val)) road = ra;
      }
    }
    return { active: true, roadPhase: true, myRoadNo: myRoads + 1, road };
  }
  const ownedSet = new Set(ownedIds);
  const legal = b.cornerIds.filter(id => !ownedSet.has(id) && !ownedIds.some(o => b.adj(id, o)));

  let priorRes = null, priorNum = null;
  if (myPlaced === 1) {
    priorRes = new Set(); priorNum = new Set();
    const mine = ownedIds.find(id => String(owned[id].owner) === state.myColor);
    if (mine) for (const h of b.corners[mine].res) { priorRes.add(h.res); priorNum.add(h.dice); }
  }

  const scored = legal.map(id => scoreCorner(id, priorRes, priorNum)).sort((x, y) => y.score - x.score);

  // Draft position: how many opponent settlements land AFTER my upcoming pick (cut-off risk)
  const oppColor = order ? order.find(c => c !== state.myColor) : null;
  const snake = order ? [order[0], order[1], order[1], order[0]] : null;
  const nextIdx = ownedIds.length;
  let myNextIdx = nextIdx;
  if (snake) { while (myNextIdx < 4 && snake[myNextIdx] !== state.myColor) myNextIdx++; }
  const oppPicksAfterMe = (snake && oppColor) ? snake.slice(myNextIdx + 1).filter(c => c === oppColor).length : 0;
  const amFirst = order ? order[0] === state.myColor : null;

  // Enrich the top 3 with road direction + follow-up plan.
  const secondSeatPair = myPlaced === 0 && amFirst === false;
  let recs;
  // v1.50 scorer (flagged). Falls through to the v1.40 path if it has nothing for this situation,
  // so the old behaviour stays reachable and comparable.
  const v150recs = PLACEMENT_SCORER_VERSION === 'v1.50'
    ? v150BuildRecs(b, legal, ownedIds, ownedSet, owned, myPlaced, amFirst, oppPicksAfterMe) : null;
  if (v150recs && v150recs.length) {
    recs = v150recs;
  } else if (secondSeatPair) {
    // Second seat places #2 and #3 back-to-back → optimize the PAIR jointly, not the single spot.
    const scoreFn = (id, pr, pn) => scoreCorner(id, pr || null, pn || null);
    // Show 3 DISTINCT plans: the top pair for each different lead settlement. Otherwise the best spot
    // pairs well with several partners (A+B, A+C, A+D), so all 3 cards would lead with the same spot
    // and look identical — just keep the best pair per unique first-settlement.
    const ranked = rankOpeningPairs(b, legal, scoreFn);
    const seenFirst = new Set(); const topPairs = [];
    for (const pr of ranked) { if (seenFirst.has(pr.first.id)) continue; seenFirst.add(pr.first.id); topPairs.push(pr); if (topPairs.length === 3) break; }
    recs = topPairs.map(pr => {
      const rec = pr.first;
      // Don't aim this settlement's road at the pair's OTHER spot — you'll settle it directly, not
      // road to it. Treat the planned 2nd settlement as owned so it (and its neighbours) are excluded.
      const road = roadAdvice(rec.id, new Set([...ownedIds, rec.id, pr.second.id]), oppPicksAfterMe);
      return { ...rec, road, followup: { kind: 'pair', spot: pr.second, tags: pr.tags } };
    });
  } else {
    recs = scored.slice(0, 3).map(rec => {
      // First seat's opening pick → simulate the opponent's grabs and your likely #4 (+ fallbacks).
      const followup = (myPlaced === 0 && amFirst === true) ? { kind: 'fourth', ...fourthPickSim(rec.id, ownedSet) } : null;
      // The road must not aim at any corner you're planning to settle for FREE in setup — this pick,
      // your #4, or its fallbacks — else it's a wasted road. Exclude them all from the road targets.
      const roadExclude = new Set([...ownedIds, rec.id]);
      if (followup) {
        if (followup.my4) roadExclude.add(followup.my4.id);
        (followup.my4Fallbacks || []).forEach(s => roadExclude.add(s.id));
      }
      const road = roadAdvice(rec.id, roadExclude, oppPicksAfterMe);
      return { ...rec, road, followup };
    });
  }

  return { active: true, myPickNo: myPlaced + 1, myTurnNow: snake ? snake[nextIdx] === state.myColor : true, amFirst, oppPicksAfterMe, recs, leanTo: b.leanTo, secondSeatPair };
}

// ─── Game State ──────────────────────────────────────────────────────────────
function newPlayer() {
  return {
    hand: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }, // reconstructed (opp) / exact (me)
    total: 0,          // ground-truth card count (playerStates array length)
    known: false,      // true if this is us (breakdown revealed)
    dev: 0,            // development cards held
    settlements: 0, cities: 0, roads: 0,
    vp: 0,             // visible VP (settlements + 2*cities)
    sevens: 0,         // count of 7s this player has rolled
  };
}

const state = {
  connected: false,
  gameActive: false,

  // Identity (by playerColor). Auto-detected — no picker.
  myColor: null,
  oppColor: null,
  colors: [],

  // Turn tracking
  currentTurnColor: null,
  completedTurns: 0,
  robberPending: false,     // I rolled a 7 (or played a knight) and still owe a robber move

  // From the game-start snapshot
  gameId: null,             // gameSettings.id — changes → new game → reset (reliable, unlike turn regression)
  discardLimit: 7,          // cardDiscardLimit (hold this many safely; discard at +1)
  vpToWin: 10,
  saveEnabled: true,        // false ⇒ test mode: completed games are NOT persisted
  playOrder: null,          // e.g. ['2','1'] — who places first in setup
  board: null,              // decoded board geometry for the opening-pick engine
  cornerOwner: {},          // cornerId -> { owner, buildingType } (settlements/cities placed)
  edgeOwner: {},            // edgeId -> owner color (roads placed) — for Turn Coach reach
  setupMySettles: [],       // my setup settlement cornerIds, in placement order (each owes a road)

  // Development-card tracking
  dev: { bankRemaining: null, plays: [], played: { knight:0, vp:0, road_building:0, year_of_plenty:0, monopoly:0, unknown:0 } },

  // ── Win-Path live state (v1.61) ────────────────────────────────────────────
  // All five arrive in the normal gameState/diff stream and were previously parsed only by the
  // offline reviewer. EVERY ONE OF THEM ARRIVES AS A PARTIAL DIFF, so each must be MERGED into
  // what we already know, never replaced — a diff carrying one player wipes the other otherwise.
  vp: {},              // color -> {category: count}, merged. Mine is exact (incl. my hidden VP
                       // cards); the opponent's omits their hidden VP cards — by design, not a gap.
  awards: { la: {}, lr: {} },   // color -> merged mechanic state ({hasLargestArmy|hasLongestRoad})
  roadLen: {},         // color -> longest road chain length (server-computed; no graph search)
  knights: {},         // color -> knights PLAYED (counted per-colour from log type 20)
  robberTile: null,    // mechanicRobberState.locationTileIndex
  tradeRatios: {},     // color -> {resourceEnum: ratio}; changes live when a port is taken
  myDevCards: [],      // MY unplayed dev-card enums (revealed for my colour only; 11=knight 12=VP)

  // Did we observe the setup phase? (opponent reconstruction is only exact if so)
  sawSetup: false,

  // Players keyed by color
  players: {},

  // Dice
  rolls: [], rollCounts: {},
  totalRolls: 0,          // uncapped roll count (state.rolls is trimmed to 30 for the display)
  dice: newDiceModel(),   // balanced-dice predictor

  // Event dedup — each gameLogState entry applied exactly once
  processedLogIds: new Set(),
  devCount: {},        // color -> last seen dev-card count

  // Events / debug
  events: [],
  rawMessages: [],
  messageCount: 0,

  // Capture logger. The durable buffer now lives in the background service worker
  // (captures even when this panel is closed, so the board snapshot is never
  // missed). The panel only tracks counts and triggers the file save.
  captureCount: 0,            // messages seen live (status display)
  gameMsgCount: 0,            // messages carrying game state (drives auto-save)
  lastSavedGameMsgCount: -1,
  capturing: true,            // auto-save enabled
  lastSave: null,
  saveError: null,
};
for (let i = 2; i <= 12; i++) state.rollCounts[i] = 0;

function player(c) {
  c = String(c);
  if (!state.players[c]) state.players[c] = newPlayer();
  return state.players[c];
}
function noteColor(c) {
  c = String(c);
  if (!state.colors.includes(c)) state.colors.push(c);
  player(c);
}
function opp() { return state.oppColor ? player(state.oppColor) : null; }
function handSum(h) { return RESOURCES.reduce((s, r) => s + (h[r] || 0), 0); }

// ─── Port Connection to Background ──────────────────────────────────────────
let port = chrome.runtime.connect({ name: 'sidepanel' });

port.onMessage.addListener((msg) => {
  // All game state is derived from RAW_MESSAGE decoded trees (the validated model).
  // GAME_EVENT (interceptor's heuristic classification) is intentionally ignored here
  // to avoid double-counting.
  if (msg.type === 'RAW_MESSAGE') handleRawMessage(msg.payload);
});

port.onDisconnect.addListener(() => {
  setStatus('disconnected');
  setTimeout(() => { port = chrome.runtime.connect({ name: 'sidepanel' }); }, 2000);
});

setStatus('waiting');

// ─── Raw message intake ───────────────────────────────────────────────────────
function handleRawMessage(msg) {
  state.messageCount++;
  state.rawMessages.unshift(msg);
  if (state.rawMessages.length > 200) state.rawMessages.pop();

  if (!state.connected) { state.connected = true; setStatus('connected'); }

  captureMessage(msg);
  addDebugLine(msg);

  const dec = msg.decoded !== undefined ? msg.decoded : msg.data;
  try { ingestGameMessage(dec); } catch (e) { /* never let one bad frame break the panel */ }
}

// ─── Core: ingest one decoded message and update game state ────────────────────
// victoryPoints / victoryPointsState map VP CATEGORY → COUNT (not points). Points per category:
//   0 = settlement (1)   1 = city (2)   2 = VP dev card (1)   3 = LARGEST ARMY (2)   4 = LONGEST ROAD (2)
//
// CATEGORIES 3 AND 4 WERE DOCUMENTED BACKWARDS UNTIL v1.61. Both awards are worth 2 points, so the
// VP *total* was always right and the error was invisible in every arithmetic check. It was caught
// by cross-checking against the award mechanic states over the full corpus:
//   mechanicLargestArmyState.hasLargestArmy  === category 3   → 330/330 player-slots
//   mechanicLongestRoadState.hasLongestRoad  === category 4   → 330/330 player-slots
// Anything that reads a category INDIVIDUALLY (award analysis, the Win-Path engine) must use the
// corrected mapping; anything that only sums them is unaffected.
const VP_CATEGORY_POINTS = { 0: 1, 1: 2, 2: 1, 3: 2, 4: 2 };
const VP_CAT = { SETTLEMENT: '0', CITY: '1', VP_CARD: '2', LARGEST_ARMY: '3', LONGEST_ROAD: '4' };
const AWARD_VP = 2;              // each award is worth 2 VP — losing one is a 2-VP drop
const LA_MIN_KNIGHTS = 3;        // Largest Army needs 3+ knights AND strictly more than the holder
const LR_MIN_ROADS = 5;          // Longest Road needs a 5+ road chain, likewise strictly more
const LR_CHASE_MAX = 3;          // don't suggest chasing Longest Road from further than this

function payloadOf(d) {
  if (!d || typeof d !== 'object') return null;
  const o = d.data && d.data.payload ? d.data : d;
  return o.payload || d.payload || null;
}

// Development-card deck (standard 25 = 14 knight / 5 VP / 2 road / 2 YoP / 2 mono).
// A card's enum→type is revealed only when it's actually PLAYED (log type-20 cardEnum).
const DEV_DECK_TOTAL = 25;
// Confirmed via captured plays: 11=Knight (robber+steal), 13=Monopoly (log type-86),
// 15=Year of Plenty (log type-21, took 2 from bank), 14=Road Building, 12=VP (never played).
const DEV_TYPE = { 11: 'knight', 12: 'vp', 13: 'monopoly', 14: 'road_building', 15: 'year_of_plenty' };

function ingestGameMessage(dec) {
  const p = payloadOf(dec);
  if (!p) return;

  // ── Snapshot (game load / reconnect): identity, settings, board, full state ──
  if (p.gameState || p.playOrder !== undefined || p.gameSettings) {
    // Reliable new-game detection: a changed game id means a fresh game → full reset.
    // (The old turn-regression trigger misfired on quick rematches, leaking one game's
    //  opponent hand into the next.) Same id = reconnect → keep state, re-sync below.
    const gid = (p.gameSettings && p.gameSettings.id) || null;
    if (gid && gid !== state.gameId) { softReset(); state.gameId = gid; }
    if (p.playerColor !== undefined && p.playerColor !== null) { state.myColor = String(p.playerColor); noteColor(state.myColor); }
    if (Array.isArray(p.playOrder)) state.playOrder = p.playOrder.map(String);
    if (p.gameSettings) {
      if (typeof p.gameSettings.cardDiscardLimit === 'number') state.discardLimit = p.gameSettings.cardDiscardLimit;
      if (typeof p.gameSettings.victoryPointsToWin === 'number') state.vpToWin = p.gameSettings.victoryPointsToWin;
    }
    if (p.gameState && typeof p.gameState === 'object') {
      if (p.gameState.mapState) captureBoard(p.gameState.mapState);
      state.gameMsgCount++;
      processStateObject(p.gameState);
      resolveOpp();
      scheduleRender();
    }
    return;
  }

  const diff = p.diff;
  if (!diff || typeof diff !== 'object') return;
  state.gameMsgCount++;
  if (processStateObject(diff)) { resolveOpp(); scheduleRender(); }
}

function resolveOpp() {
  if (state.myColor && state.colors.length >= 2 && (!state.oppColor || state.oppColor === state.myColor)) {
    state.oppColor = state.colors.find(c => c !== state.myColor) || state.oppColor;
  }
}

// Build the board geometry (corners → hexes, adjacency, adaptive weights) for the ranker.
function captureBoard(mapState) {
  try {
    state.board = { geo: buildBoardGeo(mapState), ports: mapState.portEdgeStates ? Object.values(mapState.portEdgeStates) : [] };
    reportPortsOnce();
  }
  catch (e) { state.board = null; }
}

// One-time confirmation of decoded ports (geometry validated against captures).
function reportPortsOnce() {
  if (state._portDumped || !state.board || !state.board.geo) return;
  const cp = state.board.geo.cornerPort || {};
  const labels = [...new Set(Object.values(cp).map(p => p.label))];
  if (!labels.length) return;
  state._portDumped = true;
  addEvent('⚓ Ports decoded: ' + labels.join(' · '));
}

function recomputeDevPlayed() {
  const played = { knight: 0, vp: 0, road_building: 0, year_of_plenty: 0, monopoly: 0, unknown: 0 };
  for (const e of state.dev.plays) { const t = DEV_TYPE[e]; if (t && played[t] !== undefined) played[t]++; else played.unknown++; }
  state.dev.played = played;
}

// Process a `diff` or a full `gameState` snapshot. Returns true if anything changed.
function processStateObject(g) {
  let changed = false;
  if (!state.gameActive) { state.gameActive = true; setStatus('active'); }

  // Turn ownership
  if (g.currentState && typeof g.currentState === 'object') {
    const cs = g.currentState;
    if (cs.currentTurnPlayerColor !== undefined && cs.currentTurnPlayerColor !== null) {
      const nc = String(cs.currentTurnPlayerColor);
      if (nc !== state.myColor) state.robberPending = false;   // robber owed only on my own turn
      state.currentTurnColor = nc; changed = true;
    }
    if (typeof cs.completedTurns === 'number') { state.completedTurns = cs.completedTurns; changed = true; }
  }

  // Player states: identity, exact totals, our own breakdown
  const freshHidden = [];   // hidden (opponent) players whose exact count updated this message
  if (g.playerStates && typeof g.playerStates === 'object') {
    for (const [c, pd] of Object.entries(g.playerStates)) {
      if (!pd || typeof pd !== 'object') continue;
      noteColor(c);
      const cards = pd.resourceCards && pd.resourceCards.cards;
      if (Array.isArray(cards)) {
        const pl = player(c);
        pl.total = cards.length;
        const revealed = cards.some(e => e >= 1 && e <= 5);
        if (revealed) { if (!state.myColor) state.myColor = c; pl.known = true; pl.hand = tally(cards); }
        else freshHidden.push(c);
        changed = true;
      }

      // VP by category — MERGE, never replace. These arrive as partial diffs: tracking only the
      // last value seen reads a player who is truly on 15 as 3. Merged cumulatively it is exact
      // (validated against end-game truth on all 165 captures: 165/165 for my own score).
      if (pd.victoryPointsState && typeof pd.victoryPointsState === 'object') {
        state.vp[c] = Object.assign(state.vp[c] || {}, pd.victoryPointsState);
        changed = true;
      }
      // Bank/port trade ratios (4:1 by default, 3:1 / 2:1 with a port). Changes mid-game when a
      // settlement lands on a port, so it cannot be read once at setup.
      if (pd.bankTradeRatiosState && typeof pd.bankTradeRatiosState === 'object') {
        state.tradeRatios[c] = Object.assign(state.tradeRatios[c] || {}, pd.bankTradeRatiosState);
        changed = true;
      }
    }
  }

  // ── Awards, road length, robber ──────────────────────────────────────────
  // Also partial diffs, and the loser of an award is told via an explicit `null`, so a merge keeps
  // exactly one holder. Replacing instead of merging silently drops the flag when a later frame
  // carries `{}` for that player.
  if (g.mechanicLargestArmyState && typeof g.mechanicLargestArmyState === 'object') {
    for (const [c, v] of Object.entries(g.mechanicLargestArmyState)) {
      if (v && typeof v === 'object') { state.awards.la[String(c)] = Object.assign(state.awards.la[String(c)] || {}, v); changed = true; }
    }
  }
  if (g.mechanicLongestRoadState && typeof g.mechanicLongestRoadState === 'object') {
    for (const [c, v] of Object.entries(g.mechanicLongestRoadState)) {
      if (!v || typeof v !== 'object') continue;
      if ('hasLongestRoad' in v) state.awards.lr[String(c)] = Object.assign(state.awards.lr[String(c)] || {}, v);
      // The server reports each player's longest chain directly — no graph search needed.
      if (typeof v.longestRoad === 'number') state.roadLen[String(c)] = v.longestRoad;
      changed = true;
    }
  }
  if (g.mechanicRobberState && g.mechanicRobberState.locationTileIndex != null) {
    state.robberTile = g.mechanicRobberState.locationTileIndex; changed = true;
  }

  // Development cards: deck remaining, buys (spend), plays (revealed via developmentCardsUsed)
  const dcs = g.mechanicDevelopmentCardsState;
  if (dcs) {
    if (dcs.bankDevelopmentCards && Array.isArray(dcs.bankDevelopmentCards.cards)) state.dev.bankRemaining = dcs.bankDevelopmentCards.cards.length;
    if (dcs.players) {
      for (const [c, pd] of Object.entries(dcs.players)) {
        if (!pd) continue;
        const cards = pd.developmentCards && pd.developmentCards.cards;
        if (Array.isArray(cards)) {
          const prev = state.devCount[c] || 0;
          if (cards.length > prev) for (let k = 0; k < cards.length - prev; k++) spend(c, { sheep: 1, wheat: 1, ore: 1 });
          state.devCount[c] = cards.length;          // UNPLAYED cards in hand
          player(c).dev = cards.length;
          // My own cards arrive with their real enums; the opponent's are all 10 (face-down), so
          // this is exact for me and deliberately empty for them. Knowing I hold a knight is what
          // lets the advisor spot a free, immediate Largest Army win.
          if (String(c) === state.myColor && cards.some(e => e >= 11 && e <= 15)) state.myDevCards = cards.slice();
        }
      }
      changed = true;
    }
  }

  // Board pieces: settlement/city placements (for the setup advisor + piece tracking)
  //
  // THE CITY-UPGRADE DIFF TRAP. A settlement→city upgrade arrives carrying only
  // `buildingType: 2` with `owner` OMITTED — the owner did not change, so the diff doesn't
  // repeat it. Bailing on the missing owner (as this did until v1.62) silently dropped EVERY
  // city upgrade: live city count read 0 in 52/60 replayed games. That made the coach say
  // "toward your first city" all game and offer to build a city on a corner that already was
  // one. The same bug was fixed in reviewAnalyze long ago; the live path still had it.
  // Resolve each field from the previous known state when the diff omits it.
  if (g.mapState && g.mapState.tileCornerStates) {
    for (const [cid, cv] of Object.entries(g.mapState.tileCornerStates)) {
      if (!cv) continue;
      const prev = state.cornerOwner[cid];
      const owner = (cv.owner !== undefined && cv.owner !== null) ? cv.owner : (prev ? prev.owner : null);
      if (owner === null || owner === undefined) continue;        // genuinely empty corner
      const bt = (cv.buildingType !== undefined && cv.buildingType !== null)
        ? cv.buildingType : (prev ? prev.buildingType : undefined);
      const isNew = !prev;
      state.cornerOwner[cid] = { owner, buildingType: bt };
      // Record the order I place my setup settlements (each is followed by a road).
      if (isNew && state.rolls.length === 0 && String(owner) === state.myColor && !state.setupMySettles.includes(cid)) state.setupMySettles.push(cid);
      changed = true;
    }
  }

  // Road (edge) ownership — for the Turn Coach's road-network reach.
  if (g.mapState && g.mapState.tileEdgeStates) {
    for (const [eid, ev] of Object.entries(g.mapState.tileEdgeStates)) {
      if (ev && ev.owner !== undefined && ev.owner !== null) { state.edgeOwner[eid] = ev.owner; changed = true; }
    }
  }

  // Game log: authoritative event stream (dedup by log id)
  if (g.gameLogState && typeof g.gameLogState === 'object') {
    const ids = Object.keys(g.gameLogState).sort((a, b) => Number(a) - Number(b));
    for (const logId of ids) {
      if (state.processedLogIds.has(logId)) continue;
      const entry = g.gameLogState[logId];
      const x = entry && entry.text;
      if (!x) continue;
      state.processedLogIds.add(logId);
      if (applyLogEvent(x)) changed = true;
    }
  }

  // Reconcile any hidden hand whose exact count was refreshed this message
  for (const c of freshHidden) reconcileHand(c);

  return changed;
}

// Apply one game-log entry. Returns true if it changed anything worth rendering.
function applyLogEvent(x) {
  const c = x.playerColor;
  switch (x.type) {
    case 10: // dice roll
      if (typeof x.firstDice === 'number' && typeof x.secondDice === 'number') {
        const total = x.firstDice + x.secondDice;
        recordRoll(total);
        diceApplyRoll(state.dice, total, c);
        if (total === 7 && c !== undefined) player(c).sevens++;
        // A 7 by me → I owe a robber move; any other roll clears a stale flag.
        state.robberPending = (total === 7 && String(c) === state.myColor);
        addEvent(`🎲 ${who(c)} rolled ${x.firstDice}+${x.secondDice} = ${total}`);
      }
      return true;

    case 47: // resource distribution: setup (dist 0) or roll (dist 1)
      if (c !== undefined) {
        for (const e of x.cardsToBroadcast || []) gain(c, e);
        if (x.distributionType === 0) state.sawSetup = true;
        addEvent(`＋ ${who(c)} got [${enumNames(x.cardsToBroadcast)}]`);
      }
      return true;

    case 4: // setup build (free) — track pieces, no cost
      if (c !== undefined) { countPiece(c, x.pieceEnum); state.sawSetup = true; }
      return true;

    case 5: // main-game build — costs resources
      if (c !== undefined) {
        const cost = BUILD_COST[x.pieceEnum];
        if (cost) spend(c, cost);
        countPiece(c, x.pieceEnum);
        addEvent(`🏗 ${who(c)} built ${PIECE[x.pieceEnum] || 'piece'}`);
      }
      return true;

    case 116: // bank / port trade (executed)
      if (c !== undefined) {
        for (const e of x.givenCardEnums || []) lose(c, e);
        for (const e of x.receivedCardEnums || []) gain(c, e);
        addEvent(`🔁 ${who(c)} traded [${enumNames(x.givenCardEnums)}] → [${enumNames(x.receivedCardEnums)}]`);
      }
      return true;

    case 14: { // robber: WE stole — playerColor is the victim, card is revealed
      const card = (x.cardEnums || [])[0];
      if (card) { lose(x.playerColor, card); if (state.myColor) gain(state.myColor, card);
        addEvent(`🥷 you stole ${RES_ENUM[card] || '?'} from ${who(x.playerColor)}`); }
      state.robberPending = false;      // we moved the robber and stole → resolved
      return true;
    }
    case 15: { // robber: WE were robbed — playerColor is the thief, card is revealed
      const card = (x.cardEnums || [])[0];
      if (card) { gain(x.playerColor, card); if (state.myColor) lose(state.myColor, card);
        addEvent(`🥷 ${who(x.playerColor)} stole ${RES_ENUM[card] || '?'} from you`); }
      return true;
    }

    case 20: // played a development card — cardEnum is revealed
      if (typeof x.cardEnum === 'number') {
        state.dev.plays.push(x.cardEnum);
        recomputeDevPlayed();
        // state.dev.played is DECK-WIDE (what's been revealed of the 25). The Largest Army race
        // needs it PER PLAYER, so count knights by colour here.
        if (x.cardEnum === 11 && c !== undefined) {
          const k = String(c);
          state.knights[k] = (state.knights[k] || 0) + 1;
        }
        // A knight (11) I play also lets me move the robber (no 7 needed).
        if (x.cardEnum === 11 && String(c) === state.myColor) state.robberPending = true;
        addEvent(`🃏 ${who(c)} played ${DEV_TYPE[x.cardEnum] || 'a dev card'}`);
      }
      return true;

    case 21: // Year of Plenty — player took these cards from the bank
      if (c !== undefined) { for (const e of x.cardEnums || []) gain(c, e); addEvent(`🎁 ${who(c)} took [${enumNames(x.cardEnums)}] (YoP)`); }
      return true;

    case 86: { // Monopoly result — monopolist takes ALL of a resource from everyone else
      const res = RES_ENUM[x.cardEnum];
      if (res) {
        for (const col of Object.keys(state.players)) if (col !== String(x.playerColor)) player(col).hand[res] = 0;
        if (x.playerColor !== undefined) player(x.playerColor).hand[res] += (x.amountStolen || 0);
        addEvent(`💰 ${who(x.playerColor)} monopolised ${x.amountStolen} ${res}`);
      }
      return true;
    }

    case 45: addEvent(`🏁 ${who(c)} — game over`); try { runReview(); } catch (e) {}
      setTimeout(() => { try { archiveCompletedGames(); } catch (e) {} }, 1500);   // persist the finished game
      return true;
    default: return false;
  }
}

// ── Hand mutations (reconstruction) ──
function gain(c, e) { const r = RES_ENUM[e]; if (r) player(c).hand[r]++; }
function lose(c, e) { const r = RES_ENUM[e]; if (r) { const h = player(c).hand; h[r] = Math.max(0, h[r] - 1); } }
function spend(c, cost) { const h = player(c).hand; for (const [r, n] of Object.entries(cost)) h[r] = Math.max(0, h[r] - n); }
function countPiece(c, pieceEnum) {
  const pl = player(c);
  if (pieceEnum === 0) pl.roads++;
  else if (pieceEnum === 2) pl.settlements++;
  else if (pieceEnum === 3) { pl.cities++; pl.settlements = Math.max(0, pl.settlements - 1); }
  pl.vp = pl.settlements + pl.cities * 2;
}

function tally(cards) {
  const h = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  for (const e of cards || []) { const r = RES_ENUM[e]; if (r) h[r]++; }
  return h;
}

// Force an (opponent) inferred hand to sum to the EXACT known count. The count is
// ground truth; unattributable changes (7-discards, missed events) drift the
// breakdown, so we trim phantom cards from the largest piles (what players dump on
// a 7) or, on a deficit, spread the shortfall. Keeps the display honest.
function reconcileHand(color) {
  const pl = player(color);
  if (pl.known) return;                       // our own hand is exact — never touch
  const total = pl.total;
  let sum = handSum(pl.hand);
  if (sum === total) { pl.uncertain = false; return; }
  if (sum > total) {
    let excess = sum - total;
    while (excess > 0) {
      let r = null, mx = 0;
      for (const k of RESOURCES) if (pl.hand[k] > mx) { mx = pl.hand[k]; r = k; }
      if (!r || mx <= 0) break;
      pl.hand[r]--; excess--;
    }
  } else {
    let deficit = total - sum;
    const order = RESOURCES.slice().sort((a, b) => pl.hand[b] - pl.hand[a]);
    let i = 0; while (deficit > 0) { pl.hand[order[i % order.length]]++; deficit--; i++; }
  }
  pl.uncertain = true;                        // breakdown had to be guessed this game
}
function enumNames(arr) { return Array.isArray(arr) ? arr.map(e => RES_ENUM[e] || '?').join(', ') : ''; }
function who(c) {
  c = String(c);
  if (c === state.myColor) return 'You';
  if (c === state.oppColor) return 'Opp';
  return 'P' + c;
}

function recordRoll(total) {
  if (total < 2 || total > 12) return;
  state.rolls.unshift(total);
  if (state.rolls.length > 30) state.rolls.pop();   // trim only the recent-rolls display buffer
  state.rollCounts[total] = (state.rollCounts[total] || 0) + 1;
  state.totalRolls++;                                // true running total (uncapped)
}

// ─── Capture Logger ───────────────────────────────────────────────────────────
// The full-fidelity buffer lives in the background service worker (captures even
// when this panel is closed). Here we just count messages and trigger the file
// save, pulling the complete buffer from the background at save time.
function captureMessage(msg) {
  state.captureCount++;
  renderCaptureStatusThrottled();
}

let _capStatusAt = 0;
function renderCaptureStatusThrottled() {
  const now = Date.now();
  if (now - _capStatusAt < 500) return;
  _capStatusAt = now;
  renderCaptureStatus();
}

// Reliable JSON download: queue the target path with the background (which forces it via
// onDeterminingFilename — Chrome otherwise ignores `filename` for blob URLs), then download.
function downloadJSON(dataStr, filename, cb) {
  chrome.runtime.sendMessage({ type: 'QUEUE_DOWNLOAD_NAME', filename }, () => {
    let url;
    try { url = URL.createObjectURL(new Blob([dataStr], { type: 'application/json' })); }
    catch (e) { if (cb) cb(e); return; }
    chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false }, (id) => {
      const err = chrome.runtime.lastError || null;
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 15000);
      if (cb) cb(err, id);
    });
  });
}

// Manual raw-capture dump (Debug tab buttons only — no auto-save). Lands in catan-logs/.
function downloadCapture(archive) {
  chrome.runtime.sendMessage({ type: 'GET_CAPTURE' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      state.saveError = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no response from background';
      renderCaptureStatus(); return;
    }
    const messages = resp.capture || [];
    if (!messages.length) { addEvent('[CAPTURE] nothing to save yet'); return; }
    const payload = {
      meta: { schema: 'catan-capture/v1', savedAt: new Date().toISOString(), messageCount: messages.length,
              myColor: state.myColor, colors: state.colors, note: 'colonist.io WebSocket capture' },
      messages,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `catan-logs/catan-capture-${archive ? stamp : 'latest'}.json`;
    downloadJSON(JSON.stringify(payload), filename, (err) => {
      if (err) { state.saveError = err.message || String(err); addEvent('[CAPTURE] save failed: ' + state.saveError); }
      else { state.saveError = null; state.lastSave = Date.now(); state.lastSavedGameMsgCount = state.gameMsgCount; }
      renderCaptureStatus();
    });
  });
}

function renderCaptureStatus() {
  const countEl = document.getElementById('captureCount');
  if (countEl) countEl.textContent = `${state.captureCount} msgs`;
  const statusEl = document.getElementById('captureStatus');
  if (statusEl) {
    if (state.saveError) statusEl.innerHTML = `<span style="color:var(--red)">Save error: ${state.saveError}</span>`;
    else if (state.lastSave) statusEl.textContent = `Last saved ${new Date(state.lastSave).toLocaleTimeString()} · ${state.captureCount} messages seen`;
    else statusEl.textContent = state.captureCount ? `${state.captureCount} messages captured · use Save Now for a raw dump` : 'Waiting for messages…';
  }
  const toggleEl = document.getElementById('btnToggleCapture');
  if (toggleEl) toggleEl.textContent = state.capturing ? '⏸ Pause' : '▶ Resume';
}

// (Removed the 60s rolling auto-save + the hidden-panel save — they dumped a file to
//  Downloads every minute. Completed games now persist as records on game over instead.)

// ─── Render ────────────────────────────────────────────────────────────────────
let _renderScheduled = false;
function scheduleRender() {
  if (_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(() => { _renderScheduled = false; renderAll(); });
}

function renderAll() {
  renderSetupAdvisor();   // 1. placement advisor (setup)
  renderDiceChart();      // 2. dice distribution
  renderOdds();           // 3. next roll odds
  renderOpponent();       // 4. opponent hand
  renderTurnCoach();      // 5. turn coach
  renderDevCards();       // 6. dev cards
  renderLastRolls();      // 7. last rolls
  renderFooter();
}

// Turn Coach — visible on your turn during the main game (hidden in setup / opp's turn).
function renderTurnCoach() {
  const sec = document.getElementById('turnCoach');
  if (!sec) return;
  const a = computeTurnCoach();
  if (!a.active) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  const body = document.getElementById('turnCoachBody');
  if (!body) return;

  let html = '';

  // Robber move owed (I rolled a 7 or played a knight) — show placement advice first.
  if (a.robber) html += renderRobberBlock(a.robber);

  // ── Win-Path panel ───────────────────────────────────────────────────────
  // DELIBERATELY SHOWS NO SCORES. Both players' VP, the opponent's hidden-VP estimate and their
  // unplayed-card count all feed `winPathPlan` and none of them are printed: Colonist already
  // displays the score, so repeating it is noise. What it adds is what to DO about it.
  const p = a.plan;
  if (p) {
    html += `<div class="wp${p.tier === 'win' || p.tier === 'win-maybe' ? ' wp-win' : p.tier === 'defend' ? ' wp-defend' : ''}">`;
    html += wpRow('OBJECTIVE', p.objective);
    if (p.bottleneck) html += wpRow('BOTTLENECK', p.bottleneck);
    if (p.primary) html += wpRow('DO NEXT', `<b>${p.primary.do}</b>`, p.primary.why);
    if (p.alternative) html += wpRow('ALTERNATIVE', p.alternative.do, p.alternative.why);
    if (p.changesIf) html += wpRow('CHANGES IF', p.changesIf);
    html += `</div>`;
  }

  body.innerHTML = html;
}

function wpRow(label, text, sub) {
  return `<div class="wp-row"><span class="wp-label">${label}</span>`
       + `<span class="wp-text">${text}${sub ? `<span class="wp-sub">${sub}</span>` : ''}</span></div>`;
}

// Robber placement block (rendered inside the Turn Coach when a move is owed).
function renderRobberBlock(r) {
  const stealNote = r.stealCount > 0
    ? `then rob <b>Opp</b> — holds <b>${r.stealCount}</b> card${r.stealCount !== 1 ? 's' : ''}`
    : `<span class="adv-dim">Opp has no cards to steal — block only</span>`;

  if (r.fallback || !r.top || !r.top.length) {
    return `<div class="robber-box">
      <div class="robber-head">🥷 Move the Robber</div>
      <div class="adv-line">Put it on the opponent's strongest, most-likely number to choke their income, ${r.stealCount > 0 ? stealNote : 'and rob if you can'}.</div>
    </div>`;
  }

  const rows = r.top.map((c, i) => {
    const pct = Math.round(c.p * 100);
    const selfWarn = c.myW > 0 ? ` <span class="adv-warn">⚠ also blocks your own hex</span>` : '';
    return `<div class="robber-rec${i === 0 ? ' top' : ''}">
      <span class="robber-rank">${i + 1}</span>
      <span class="robber-spot"><b>${c.dice}-${c.res}</b> <span class="advisor-pips">${pct}% next roll</span>${selfWarn}</span>
    </div>`;
  }).join('');

  return `<div class="robber-box">
    <div class="robber-head">🥷 Move the Robber</div>
    ${rows}
    <div class="adv-line" style="margin-top:5px">Best block above, ${stealNote}.</div>
  </div>`;
}

// Board-read banner: what kind of board this is + the plan it calls for. Shown atop the advisor
// so you read the board BEFORE the picks (the classification also tilts the corner scores).
function setupBoardBanner() {
  const geo = state.board && state.board.geo;
  if (!geo) return '';
  const rp = geo.resPips || {};
  const pips = `🌲${rp.wood||0} 🧱${rp.brick||0} 🐑${rp.sheep||0} 🌾${rp.wheat||0} ⛰${rp.ore||0}`;
  // v1.50: the board read is a CONTINUOUS lean (−1 road … +1 OWS), not three hard buckets.
  if (PLACEMENT_SCORER_VERSION === 'v1.50' && typeof geo.lean150 === 'number') {
    const L = geo.lean150, mag = Math.abs(L);
    const cls  = L >= 0.25 ? 'ba-ows' : L <= -0.25 ? 'ba-road' : 'ba-bal';
    const name = L >= 0.25 ? 'OWS-favoring — city / dev engine'
               : L <= -0.25 ? 'Road-favoring — expansion & longest road'
               : 'Balanced — mixed engine, take the best pips';
    const strength = mag >= 0.70 ? 'strong' : mag >= 0.30 ? 'moderate' : 'slight';
    return `<div class="board-read ${cls}">📋 <b>${name}</b>`
         + `<div class="br-sub">lean ${L >= 0 ? '+' : ''}${L.toFixed(2)} (${strength}) · ${pips}</div></div>`;
  }
  if (!geo.archLabel) return '';
  const cls = geo.archetype === 'ows' ? 'ba-ows' : geo.archetype === 'road' ? 'ba-road' : 'ba-bal';
  const pct = Math.round((geo.owsShare || 0) * 100);
  return `<div class="board-read ${cls}">📋 <b>${geo.archLabel}</b>`
       + `<div class="br-sub">OWS ${pct}% of pips · ${pips}</div></div>`;
}

// Opening-pick advisor — visible only during the setup/picking phase, then hidden.
function renderSetupAdvisor() {
  const sec = document.getElementById('setupAdvisor');
  if (!sec) return;
  const a = computeSetupAdvice();
  if (!a.active) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  const body = document.getElementById('setupAdvisorBody');
  if (!body) return;
  const banner = setupBoardBanner();

  if (a.msg) { body.innerHTML = banner + `<div class="opp-note">${a.msg}</div>`; return; }

  // Both settlements down — just the setup road left to place.
  if (a.roadPhase) {
    let html = banner + `<div class="advisor-head">Place your setup road #${a.myRoadNo}</div>`;
    if (a.road && a.road.toward) {
      html += `<div class="adv-line">🛣 Aim at <b>${a.road.toward.label}</b> <span class="advisor-pips">${a.road.toward.pips}p</span>`;
      html += a.road.contest ? ` <span class="adv-warn">⚠ contestable</span>` : ` <span class="adv-dim">(opens your best expansion)</span>`;
      html += `</div>`;
    } else {
      html += `<div class="adv-line adv-dim">Point it toward your best open expansion corner.</div>`;
    }
    body.innerHTML = html;
    return;
  }

  const pos = a.amFirst === true ? 'You place 1st & last (#1 then #4)'
            : a.amFirst === false ? 'You place 2nd & 3rd (back-to-back)' : '';
  const header = a.myTurnNow ? `Your pick — settlement #${a.myPickNo}` : `Opponent picking — targets for your #${a.myPickNo}`;
  let html = banner + `<div class="advisor-head">${header}</div><div class="advisor-sub">${pos}${a.secondSeatPair ? (pos ? ' · ' : '') + 'plan the pair' : ''}</div>`;

  if (!a.recs.length) { body.innerHTML = html + '<div class="opp-note">No legal spots left.</div>'; return; }

  // Corner label without the trailing " ⚓<port>" tag, re-joined with the port as "& 2:1 X".
  const clean = s => s.label.split(' ⚓')[0] + (s.port ? ' & ' + s.port.label : '');

  a.recs.forEach((r, i) => {
    let inner = '';
    if (r.road) {
      const safe = !r.road.contest;
      inner += `<div class="adv-line">🛣 Road → to <b>${clean(r.road.toward)}</b> ` +
               (safe ? `<span class="adv-safe">(Safe)</span>` : `<span class="adv-warn">(Contestable)</span>`) + `</div>`;
      if (!safe && r.road.alt) inner += `<div class="adv-line adv-dim">↳ backup → ${clean(r.road.alt)}</div>`;
    }
    if (r.followup && r.followup.kind === 'fourth' && r.followup.my4) {
      const f = r.followup;
      inner += `<div class="adv-line">↪ Your <b>#4</b> → ${clean(f.my4)} <span class="advisor-pips">${f.my4.pips}p</span></div>`;
      if (f.my4Fallbacks && f.my4Fallbacks.length)
        inner += `<div class="adv-line adv-dim">↳ if taken → ${f.my4Fallbacks.map(o => clean(o) + ' (' + o.pips + 'p)').join(' · ')}</div>`;
      if (f.oppLikely && f.oppLikely.length)
        inner += `<div class="adv-div"></div><div class="adv-line adv-dim">Opp likely grabs: ${f.oppLikely.map(clean).join(' · ')}</div>`;
    } else if (r.followup && r.followup.kind === 'pair' && r.followup.spot) {
      inner += `<div class="adv-line">↔ Then take <b>${clean(r.followup.spot)}</b> <span class="advisor-pips">${r.followup.spot.pips}p</span></div>`;
    }
    // NOTE: the v1.50 engine/score/why diagnostic line used to render here. Removed — it read as
    // clutter under the picks (and landed after "Opp likely grabs"). The scoring still drives the
    // ranking; the numbers live in the validation report, not the in-game card.
    // All recommendations start EXPANDED so the alternatives are visible without a click.
    html += `<details class="adv-rec${i === 0 ? ' adv-top' : ''}" open><summary><span class="adv-rank">${i + 1}</span><span class="advisor-spot">${r.label}</span><span class="advisor-pips">${r.pips}p</span></summary><div class="adv-body">${inner}</div></details>`;
  });
  body.innerHTML = html;
}

// Predicted odds for the NEXT roll, from the balanced-dice model
function renderOdds() {
  const chart = document.getElementById('oddsChart');
  if (!chart) return;
  const m = state.dice;
  const riskEl = document.getElementById('sevenRisk');

  if (m.rollsSeen === 0) {
    chart.innerHTML = '<div style="width:100%;text-align:center;align-self:center;color:var(--text-muted);font-size:11px">Odds appear after the first roll</div>';
    if (riskEl) riskEl.innerHTML = '';
    return;
  }

  const roller = state.currentTurnColor || state.myColor || state.colors[0] || null;
  const p = dicePredict(m, roller);
  const maxP = Math.max(...Object.values(p), 0.0001);

  chart.innerHTML = [2,3,4,5,6,7,8,9,10,11,12].map(n => {
    const prob = p[n] || 0;
    const ratio = prob / (EXPECTED[n] / 36);      // vs fair odds
    const cls = ratio > 1.25 ? 'hot' : ratio < 0.6 ? 'cold' : 'normal';
    const h = (prob / maxP) * 100;
    return `<div class="dice-col">
      <div class="dice-count">${Math.round(prob * 100)}%</div>
      <div class="dice-bar-wrap"><div class="dice-bar ${cls}" style="height:${h}%"></div></div>
      <div class="dice-label">${n}</div>
    </div>`;
  }).join('');

  if (riskEl) {
    const pMe = state.myColor ? dicePredict(m, state.myColor)[7] : null;
    const pOpp = state.oppColor ? dicePredict(m, state.oppColor)[7] : null;
    const fmt = v => v == null ? '—' : Math.round(v * 100) + '%';
    riskEl.innerHTML =
      `<div class="sr you">7 on YOUR roll<b>${fmt(pMe)}</b></div>` +
      `<div class="sr opp">7 on OPP roll<b>${fmt(pOpp)}</b></div>`;
  }
}

// Which half of the dice section is showing: 'odds' | 'dist'. The roll count in the header belongs
// to the distribution only, so it is hidden while the odds pane is up.
let diceView = 'odds';
function setDiceView(v) {
  diceView = v;
  for (const b of document.querySelectorAll('#diceSwitch .sw-opt')) b.classList.toggle('active', b.dataset.dice === v);
  const odds = document.getElementById('dicePaneOdds'), dist = document.getElementById('dicePaneDist');
  if (odds) odds.style.display = v === 'odds' ? '' : 'none';
  if (dist) dist.style.display = v === 'dist' ? '' : 'none';
  const meta = document.getElementById('totalRolls');
  if (meta) meta.style.display = v === 'dist' ? '' : 'none';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#diceSwitch .sw-opt');
  if (b) setDiceView(b.dataset.dice);
});

function renderDiceChart() {
  const chart = document.getElementById('diceChart');
  const totalRolls = state.totalRolls;
  document.getElementById('totalRolls').textContent = `${totalRolls} roll${totalRolls !== 1 ? 's' : ''}`;
  if (totalRolls === 0) {
    chart.innerHTML = '<div style="width:100%;text-align:center;align-self:center;color:var(--text-muted);font-size:11px">No rolls yet</div>';
    return;
  }
  const maxCount = Math.max(...Object.values(state.rollCounts), 1);
  chart.innerHTML = [2,3,4,5,6,7,8,9,10,11,12].map(n => {
    const count = state.rollCounts[n] || 0;
    const heightPct = (count / maxCount) * 100;
    const ratio = totalRolls > 5 ? count / (totalRolls * EXPECTED[n] / 36) : 1;
    const cls = ratio > 1.4 ? 'hot' : ratio < 0.6 ? 'cold' : 'normal';
    return `<div class="dice-col">
      <div class="dice-count">${count}</div>
      <div class="dice-bar-wrap"><div class="dice-bar ${cls}" style="height:${heightPct}%"></div></div>
      <div class="dice-label">${n}</div>
    </div>`;
  }).join('');
}

function renderLastRolls() {
  const el = document.getElementById('lastRolls');
  if (state.rolls.length === 0) { el.innerHTML = '<span style="color:var(--text-muted);font-size:9px">No rolls yet</span>'; return; }
  el.innerHTML = state.rolls.slice(0, 20).map((r, i) => {
    const cls = r === 7 ? 'seven' : (r === 6 || r === 8) ? 'hot' : '';
    return `<div class="roll-chip ${cls} ${i === 0 ? 'new' : ''}">${r}</div>`;
  }).join('');
}

function renderOpponent() {
  const el = document.getElementById('opponentResources');
  const o = opp();
  const totalEl = document.getElementById('opponentTotal');
  const note = document.getElementById('opponentNote');

  if (!o) {
    if (totalEl) totalEl.textContent = '0';
    if (note) note.textContent = '';
    el.innerHTML = '<div style="color:var(--text-muted);font-size:9px;grid-column:1/-1">Detecting players…</div>';
    return;
  }

  const total = o.total;               // ground truth count (always exact) — shown in the header
  if (totalEl) totalEl.textContent = total;

  // Breakdown always sums to the exact count; the note flags when it had to be guessed.
  let reason = '';
  if (!state.sawSetup) reason = 'Joined mid-game — total is exact, breakdown approximate.';
  else if (o.uncertain) reason = 'Breakdown estimated after a discard/hidden loss — total is exact.';
  if (note) note.textContent = reason;

  el.innerHTML = RESOURCES.map(res => {
    const count = o.hand[res] || 0;
    return `<div class="resource-card ${RES_CLASS[res]}">
      <span class="res-icon">${RES_ICONS[res]}</span>
      <span class="res-name">${res}</span>
      <span class="res-count">${count}</span>
    </div>`;
  }).join('');
}

// Development-card tracker. Deck/bought summary sits in the header; the boxes show how
// many of each revealed dev card have been PLAYED (a card's type is known once it's played).
function renderDevCards() {
  const el = document.getElementById('devContent');
  if (!el) return;
  const d = state.dev;
  const inDeck = d.bankRemaining != null ? d.bankRemaining : DEV_DECK_TOTAL;
  const bought = DEV_DECK_TOTAL - inDeck;
  const pl = d.played;

  const deckEl = document.getElementById('devDeckState');
  if (deckEl) deckEl.innerHTML = `<b>${inDeck}</b> in deck · <b>${bought}</b> bought`;

  el.innerHTML = `
    <div class="dev-top">
      <div class="dev-stat"><span class="dev-big">${pl.knight}</span><span class="dev-lbl">KN</span></div>
      <div class="dev-stat"><span class="dev-big">${pl.road_building}</span><span class="dev-lbl">RB</span></div>
      <div class="dev-stat"><span class="dev-big">${pl.year_of_plenty}</span><span class="dev-lbl">YOP</span></div>
      <div class="dev-stat"><span class="dev-big">${pl.monopoly}</span><span class="dev-lbl">MONO</span></div>
    </div>`;
}

function renderFooter() {
  document.getElementById('footerRolls').textContent = state.totalRolls;
  const me = state.myColor ? player(state.myColor).sevens : 0;
  const oppS = state.oppColor ? player(state.oppColor).sevens : 0;
  const meEl = document.getElementById('footerSevensMe');
  const oppEl = document.getElementById('footerSevensOpp');
  if (meEl) meEl.textContent = me;
  if (oppEl) oppEl.textContent = oppS;
}

// ─── Post-game Review (middle tab) ─────────────────────────────────────────────
// Replays the durable capture (pulled from the background) and grades the last game:
// opening, dice luck, production, hand/7s, ports, dev/economy, plus takeaways.
// All metrics validated against real captures (see logs/README.md). The analyzer is
// self-contained and geometry-independent of the live game state.

function reviewGeo(mapState) {
  const hexByCoord = {}, hexByIndex = {};
  for (const [idx, h] of Object.entries(mapState.tileHexStates || {})) {
    const rec = { res: HEX_RES[h.type], dice: h.diceNumber || 0, coord: h.x + ',' + h.y };
    hexByCoord[rec.coord] = rec; hexByIndex[idx] = rec;
  }
  const corners = {};
  for (const [id, c] of Object.entries(mapState.tileCornerStates || {})) {
    const tri = (c.z === 0 ? [[c.x,c.y],[c.x+1,c.y-1],[c.x,c.y-1]] : [[c.x,c.y],[c.x-1,c.y+1],[c.x,c.y+1]]).map(([x,y]) => x + ',' + y);
    const res = tri.map(k => hexByCoord[k]).filter(h => h && h.res !== 'desert');
    corners[id] = { id, tri, res };
  }
  const cornerIds = Object.keys(corners);
  const adj = (a, b) => { let n = 0; for (const t of corners[a].tri) if (corners[b].tri.includes(t)) n++; return n === 2; };
  const cornerPort = {};
  for (const pt of Object.values(mapState.portEdgeStates || {})) {
    const off = EDGE_OFF[pt.z]; if (!off) continue;
    const h1 = pt.x + ',' + pt.y, h2 = (pt.x + off[0]) + ',' + (pt.y + off[1]);
    const ends = cornerIds.filter(id => corners[id].tri.includes(h1) && corners[id].tri.includes(h2));
    const res = PORT_RES[pt.type] || null;
    const info = res ? { ratio: 2, res, label: '2:1 ' + res } : { ratio: 3, res: null, label: '3:1' };
    for (const id of ends) cornerPort[id] = info;
  }
  // Same adaptive weights as the live buildBoardGeo, so the review's ranking MATCHES what
  // the Setup Advisor showed in-game.
  const resPips = { wood:0, brick:0, sheep:0, wheat:0, ore:0 };
  for (const h of Object.values(hexByCoord)) if (h.res !== 'desert') resPips[h.res] += SETUP_PIPS[h.dice] || 0;
  const base = { wood:1.0, brick:1.0, sheep:1.0, wheat:1.15, ore:1.1 };
  const arch = boardArchetype(resPips);                          // strategic lean, INTO the board's strong axis
  const lean = arch.lean;
  // weight = base × archetype lean. The old per-board SCARCITY multiplier was removed — it fought the
  // archetype (discounted sheep on an OWS board because sheep was abundant, so brick outranked it) and
  // broke wood≠brick. Coverage of scarce/lacking resources is already handled by the complement +
  // ore/wheat-security bonuses in scoreCorner. So weights depend only on the archetype now → wood
  // always equals brick, and OWS resources always outrank road resources on an OWS board.
  const weights = {};
  for (const r of RESOURCES) weights[r] = base[r] * (lean[r] || 1);

  // v1.50: continuous board lean + interpolated production weights (computed once per board).
  const geoLite = { hexByCoord, corners, cornerIds, adj, resPips };
  const lean150 = v150BoardLean(geoLite);
  const weights150 = v150Weights(lean150);
  const activeWeights = PLACEMENT_SCORER_VERSION === 'v1.50' ? weights150 : weights;
  return { hexByCoord, hexByIndex, corners, cornerIds, adj, cornerPort, weights: activeWeights, weights140: weights, weights150, lean150, resPips, archetype: arch.archetype, owsShare: arch.owsShare, archLabel: arch.label };
}

// Mirror of the live scoreCorner (uses geo.weights), so review ranks == in-game advice.
function reviewScoreCorner(geo, id, priorRes, priorNum) {
  const c = geo.corners[id], W = geo.weights || {};
  let pips = 0, wprod = 0; const kinds = new Set(), nums = [];
  for (const h of c.res) { const p = SETUP_PIPS[h.dice] || 0; pips += p; wprod += p * (W[h.res] || 1); kinds.add(h.res); nums.push(h.dice); }
  let bonus = (kinds.size - 1) * 0.6;
  const wheatPips = c.res.reduce((s, h) => s + (h.res === 'wheat' ? (SETUP_PIPS[h.dice] || 0) : 0), 0);
  const orePips   = c.res.reduce((s, h) => s + (h.res === 'ore'   ? (SETUP_PIPS[h.dice] || 0) : 0), 0);
  if (kinds.has('ore') && wheatPips >= 3) bonus += 0.5;
  if (priorRes) {
    for (const k of kinds) if (!priorRes.has(k)) bonus += 1.0;
    const has68 = nums.some(n => n === 6 || n === 8);
    const priorHas68 = priorNum && [...priorNum].some(n => n === 6 || n === 8);
    if (has68 && !priorHas68) bonus += 0.8;
    if (!priorRes.has('wheat')) { bonus += wheatPips * 0.2;  if (wheatPips < 3) bonus -= 2.0; }
    if (!priorRes.has('ore'))   { bonus += orePips   * 0.2;  if (orePips   < 3) bonus -= 1.5; }
  }
  const port = geo.cornerPort[id];
  if (port) {
    if (port.ratio === 3) bonus += 0.7;
    else { let syn = 0.6; if (kinds.has(port.res)) syn += 1.2; else if (priorRes && priorRes.has(port.res)) syn += 0.9; if (port.res === 'ore' || port.res === 'wheat') syn += 0.2; bonus += syn; }
  }
  const label = c.res.slice().sort((a, b) => (SETUP_PIPS[b.dice]||0) - (SETUP_PIPS[a.dice]||0)).map(h => `${h.dice}-${h.res}`).join('/') || 'coast';
  return { id, pips, score: wprod + bonus, kinds: [...kinds], nums, label, port };
}

// Split the capture into games by gameSettings.id (diffs inherit the current game).
function reviewSplitGames(messages) {
  const games = []; let cur = null, curId = null;
  for (const m of messages) {
    const dec = m.dec !== undefined ? m.dec : m.data;
    const p = payloadOf(dec);
    const gid = p && p.gameSettings && p.gameSettings.id;
    if (p && (p.gameState || p.gameSettings) && gid && gid !== curId) { cur = { id: gid, msgs: [] }; games.push(cur); curId = gid; }
    if (cur) cur.msgs.push(m);
  }
  return games;
}

function reviewPorts(ratios) {
  if (!ratios) return [];
  const out = [];
  for (const [k, v] of Object.entries(ratios)) if (v === 2) out.push('2:1 ' + RES_ENUM[k]);
  if (Object.values(ratios).some(v => v === 3)) out.push('3:1');
  return out;
}

function reviewAnalyze(game) {
  const msgs = game.msgs;
  const R = { myColor: null, oppColor: null, colors: [], playOrder: null, vpToWin: 10, discardLimit: 7, geo: null };
  const P = {};
  const player = c => { c = String(c); return (P[c] = P[c] || { setts:0, cities:0, realIncome:0, setupGain:0, discarded:0, overTimes:0, trades:0, devPlays:{}, myDevVP:0, ratios:null, lastTotal:0 }); };
  const note = c => { c = String(c); if (!R.colors.includes(c)) R.colors.push(c); player(c); };
  const rollCounts = {}; for (let i = 2; i <= 12; i++) rollCounts[i] = 0;
  // Ordered roll sequence (not just the histogram) — lets timing questions (first-city turn,
  // early droughts, robber timing) be answered without re-replaying raw. ~70 ints, negligible.
  const rollSeq = [];
  let tFirst = null, tLast = null;      // wall-clock bounds of the capture
  let totalRolls = 0; const sevensBy = {};
  const cornerOwner = {}; const footprint = {}; const allSetupOrder = [];
  let robberTile = null, completedTurns = 0, winner = null, stoleFrom = 0, robbedBy = 0;
  const seen = new Set();
  const applyFP = (c, id, dw) => { c = String(c); const co = R.geo && R.geo.corners[id]; if (!co) return; footprint[c] = footprint[c] || {}; for (const h of co.res) footprint[c][h.dice] = (footprint[c][h.dice] || 0) + dw; };

  for (const m of msgs) {
    if (typeof m.t === 'number') { if (tFirst == null) tFirst = m.t; tLast = m.t; }
    const dec = m.dec !== undefined ? m.dec : m.data; const p = payloadOf(dec); if (!p) continue;

    // ── END-GAME PAYLOAD (message data.type === 45) ────────────────────────────
    // This arrives ONCE per game as its own message and has no gameState/diff, so the loop below
    // used to `continue` straight past it and throw it away. It is the only source of GROUND TRUTH
    // for how the game actually ended. Purely recorded — nothing here feeds the placement scorer.
    if (p.endGameState || p.rankedUserStates) {
      const eg = p.endGameState || {};
      R.endGame = {
        totalTurnCount: eg.totalTurnCount != null ? eg.totalTurnCount : null,
        gameDurationInMS: eg.gameDurationInMS != null ? eg.gameDurationInMS : null,
        diceStats: Array.isArray(eg.diceStats) ? eg.diceStats : null,   // index 0 = roll 2 … 10 = roll 12
        players: {}, resourceStats: eg.resourceStats || null, activityStats: eg.activityStats || null,
      };
      // victoryPoints maps VP CATEGORY → COUNT (not points). Weight each category by what it is
      // actually worth to get true final VP including hidden dev-card VP. Verified on 54 real
      // games: no winner exceeds 15, 33 land exactly on 15, and each category's max matches the
      // real limits (5 settlements, 4 cities, 5 VP cards, longest road / largest army = 1).
      for (const [col, pd] of Object.entries(eg.players || {})) {
        const vp = pd && pd.victoryPoints
          ? Object.entries(pd.victoryPoints).reduce((a, [cat, n]) => a + (VP_CATEGORY_POINTS[cat] || 0) * (n || 0), 0)
          : null;
        R.endGame.players[String(col)] = { rank: pd ? pd.rank : null, vp, vpByCategory: (pd && pd.victoryPoints) || null, winner: !!(pd && pd.winningPlayer) };
        if (pd && pd.winningPlayer) R.endGameWinner = String(col);
      }
      // MMR before/after for BOTH players → lets us control for opponent strength later.
      if (Array.isArray(p.rankedUserStates)) {
        R.mmr = {};
        for (const u of p.rankedUserStates) {
          const rs = u && u.rankedState;
          if (u && u.color != null && rs) R.mmr[String(u.color)] = { before: rs.previousMMR != null ? rs.previousMMR : null, after: rs.currentMMR != null ? rs.currentMMR : null, delta: rs.mostRecentChangeInValue != null ? rs.mostRecentChangeInValue : null };
        }
      }
      continue;
    }

    if (p.gameState || p.gameSettings || p.playOrder !== undefined) {
      if (p.playerColor != null) { R.myColor = String(p.playerColor); note(R.myColor); }
      if (Array.isArray(p.playOrder)) R.playOrder = p.playOrder.map(String);
      if (p.gameSettings && typeof p.gameSettings.victoryPointsToWin === 'number') R.vpToWin = p.gameSettings.victoryPointsToWin;
      if (p.gameState && p.gameState.mapState && !R.geo) { R.geo = reviewGeo(p.gameState.mapState); R.boardRaw = reviewBoardRaw(p.gameState.mapState); }
    }
    const g = p.gameState || p.diff; if (!g || typeof g !== 'object') continue;
    if (!R.geo && g.mapState) { R.geo = reviewGeo(g.mapState); R.boardRaw = reviewBoardRaw(g.mapState); }
    if (g.currentState && typeof g.currentState.completedTurns === 'number') completedTurns = g.currentState.completedTurns;

    if (g.playerStates) for (const [c, pd] of Object.entries(g.playerStates)) {
      if (!pd) continue; note(c); const pl = player(c);
      if (pd.bankTradeRatiosState) pl.ratios = pd.bankTradeRatiosState;
      if (typeof pd.cardDiscardLimit === 'number') R.discardLimit = pd.cardDiscardLimit;
      if (pd.resourceCards && Array.isArray(pd.resourceCards.cards)) pl.lastTotal = pd.resourceCards.cards.length;
    }
    if (g.mechanicRobberState && g.mechanicRobberState.locationTileIndex != null) robberTile = g.mechanicRobberState.locationTileIndex;
    // BUG FIX (v1.61): these were REPLACED per message, not merged. They arrive as partial diffs,
    // and `hasLongestRoad` is carried by only ~7% of longest-road frames (the rest carry just the
    // chain length), so the last frame almost always lacked the flag — `awards.lrMe` was wrong in
    // 46/165 saved records. Merging per colour fixes it; verified 330/330 against end-game truth.
    if (g.mechanicLongestRoadState && typeof g.mechanicLongestRoadState === 'object') {
      R.lr = R.lr || {};
      for (const [c, v] of Object.entries(g.mechanicLongestRoadState)) {
        if (v && typeof v === 'object') R.lr[String(c)] = Object.assign(R.lr[String(c)] || {}, v);
      }
    }
    if (g.mechanicLargestArmyState && typeof g.mechanicLargestArmyState === 'object') {
      R.la = R.la || {};
      for (const [c, v] of Object.entries(g.mechanicLargestArmyState)) {
        if (v && typeof v === 'object') R.la[String(c)] = Object.assign(R.la[String(c)] || {}, v);
      }
    }
    if (g.mechanicDevelopmentCardsState) {
      const dcs = g.mechanicDevelopmentCardsState;
      if (dcs.bankDevelopmentCards && Array.isArray(dcs.bankDevelopmentCards.cards)) R.devBank = dcs.bankDevelopmentCards.cards.length;
      if (dcs.players && R.myColor && dcs.players[R.myColor]) { const cards = dcs.players[R.myColor].developmentCards && dcs.players[R.myColor].developmentCards.cards; if (Array.isArray(cards)) player(R.myColor).myDevVP = cards.filter(e => e === 12).length; }
    }
    if (g.mapState && g.mapState.tileCornerStates) {
      for (const [id, cv] of Object.entries(g.mapState.tileCornerStates)) {
        if (!cv) continue;
        const prev = cornerOwner[id]; const bt = cv.buildingType;
        // A settlement is placed with `owner` set (new corner). A city UPGRADE arrives as a diff
        // that carries only buildingType:2 — owner is omitted because it's already known. The old
        // code bailed on `owner == null` and dropped every diff-based upgrade (cities always 0).
        // Resolve the owner from the prior settlement record so upgrades are counted.
        const co = cv.owner != null ? String(cv.owner) : (prev ? prev.owner : null);
        if (co == null) continue; note(co);
        if (!prev) { cornerOwner[id] = { owner: co, bt }; applyFP(co, id, bt === 2 ? 2 : 1); const pl = player(co); if (bt === 2) pl.cities++; else pl.setts++; if (totalRolls === 0) allSetupOrder.push({ id, owner: co }); }
        else if (bt === 2 && prev.bt !== 2) { cornerOwner[id] = { owner: co, bt: 2 }; applyFP(co, id, 1); const pl = player(co); pl.cities++; pl.setts = Math.max(0, pl.setts - 1); }
      }
    }
    if (g.gameLogState) {
      const ids = Object.keys(g.gameLogState).sort((a, b) => +a - +b);
      for (const id of ids) {
        if (seen.has(id)) continue; seen.add(id); const x = g.gameLogState[id] && g.gameLogState[id].text; if (!x) continue;
        const c = x.playerColor != null ? String(x.playerColor) : null;
        switch (x.type) {
          case 10: if (typeof x.firstDice === 'number') { const n = x.firstDice + x.secondDice; rollCounts[n] = (rollCounts[n] || 0) + 1; totalRolls++; rollSeq.push(n);
            if (n === 7) { if (c != null) sevensBy[c] = (sevensBy[c] || 0) + 1; for (const col of R.colors) { const pl = player(col); if (pl.lastTotal > R.discardLimit) { pl.discarded += Math.floor(pl.lastTotal / 2); pl.overTimes++; } } }
          } break;
          case 47: if (c != null) { const pl = player(c); const arr = x.cardsToBroadcast || []; if (x.distributionType === 0) pl.setupGain += arr.length; else pl.realIncome += arr.length; } break;
          case 116: if (c != null) player(c).trades++; break;
          case 14: stoleFrom++; break;
          case 15: robbedBy++; break;
          case 20: if (typeof x.cardEnum === 'number' && c != null) { const t = DEV_TYPE[x.cardEnum] || '?'; const pl = player(c); pl.devPlays[t] = (pl.devPlays[t] || 0) + 1; } break;
          case 45: winner = c; break;
        }
      }
    }
  }

  R.oppColor = R.colors.find(c => c !== R.myColor) || null;

  // CONCESSION DETECTION (recording only). A game that ended with NOBODY at the victory target was
  // conceded/abandoned, not won on the board. ~39% of the legacy corpus was like this, which
  // silently poisoned every outcome-based claim. Flagging it lets analysis exclude them.
  //
  // TWO DIFFERENT "WINNERS" — do not conflate them:
  //   winner / winnerVP  = whom the SERVER designated. On a concession the server still names a
  //                        winner, and it is NOT always the player ahead on VP (the conceder's
  //                        opponent wins even if trailing). Observed in 3 of 66 fresh games.
  //   leader / leaderVP  = who actually held the most VP at termination (max of finalVP).
  // `decided` is derived from leaderVP, not winnerVP: "did ANYONE reach the target" is the robust
  // question. Both rules agree on the current corpus; the leader rule cannot be fooled by a
  // server-designated winner who is behind.
  if (R.endGame && R.endGame.players) {
    const w = R.endGameWinner || (R.winner != null ? String(R.winner) : null);
    R.finalVP = {}; for (const [c, pd] of Object.entries(R.endGame.players)) R.finalVP[c] = pd.vp;
    R.winnerVP = w && R.endGame.players[w] ? R.endGame.players[w].vp : null;
    const vps = Object.entries(R.finalVP).filter(([, v]) => typeof v === 'number');
    if (vps.length) {
      const top = vps.reduce((a, b) => (b[1] > a[1] ? b : a));
      R.leader = top[0]; R.leaderVP = top[1];
    } else { R.leader = null; R.leaderVP = null; }
    R.decided = (R.leaderVP != null && R.vpToWin != null) ? R.leaderVP >= R.vpToWin : null;
    R.conceded = R.decided === null ? null : !R.decided;
  }
  // MMR is absent for one player in a small number of games (guest / unranked / server omission).
  // Kept as null rather than imputed; this flag lets opponent-strength-controlled analysis
  // exclude them without having to re-derive the condition.
  R.mmrComplete = R.mmr && R.colors.length
    ? R.colors.every(c => R.mmr[c] && R.mmr[c].before != null && R.mmr[c].after != null)
    : false;
  const luck = col => { const fp = footprint[col] || {}; let num = 0, den = 0; for (let n = 2; n <= 12; n++) { if (n === 7) continue; const w = fp[n] || 0; num += (rollCounts[n] || 0) * w; den += (EXPECTED[n] / 36) * w; } den *= totalRolls; return { pct: den > 0 ? Math.round(100 * num / den) : null }; };
  R.rollCounts = rollCounts; R.totalRolls = totalRolls; R.sevensBy = sevensBy; R.winner = winner; R.completedTurns = completedTurns;
  R.rollSequence = rollSeq;
  R.startedAt = tFirst != null ? new Date(tFirst).toISOString() : null;
  R.endedAt = tLast != null ? new Date(tLast).toISOString() : null;
  R.messageCount = msgs.length;
  R.setupPlacements = allSetupOrder.length;
  R.stoleFrom = stoleFrom; R.robbedBy = robbedBy; R.footprint = footprint; R.P = P;
  R.luckMe = luck(R.myColor); R.luckOpp = luck(R.oppColor);

  // Opening: rank each of MY setup settlements among the legal spots at that pick.
  // pickNo = its position (1..4) in the overall setup-placement order (so "1st pick" / "4th pick").
  R.opening = [];
  // All of MY setup settlement corner ids — so if the advisor's #1 for one pick is a spot I took
  // on a DIFFERENT pick (same two spots, different order — common as 2nd player placing back-to-
  // back), we don't flag it as a miss.
  const myPickIds = new Set(allSetupOrder.filter(s => s.owner === R.myColor).map(s => s.id));
  const placedBefore = new Set(); const priorRes = new Set(), priorNum = new Set();
  // The historical v1.40 grade must be computed on v1.40 WEIGHTS. Leaving geo.weights pointed at the
  // active (v1.50) vector produced the hybrid "v1.40 bonuses + v1.50 weights" the review rejected.
  const _activeW = R.geo ? R.geo.weights : null;
  if (R.geo && R.geo.weights140) R.geo.weights = R.geo.weights140;
  let overall = 0;
  for (const step of allSetupOrder) {
    overall++;
    if (step.owner === R.myColor && R.geo) {
      const pr = priorRes.size ? priorRes : null, pn = priorNum.size ? priorNum : null;
      const legal = R.geo.cornerIds.filter(id => !placedBefore.has(id) && ![...placedBefore].some(o => R.geo.adj(id, o)));
      const scored = legal.map(id => reviewScoreCorner(R.geo, id, pr, pn)).sort((a, b) => b.score - a.score);
      const mine = reviewScoreCorner(R.geo, step.id, pr, pn);
      const rank = scored.findIndex(s => s.id === step.id) + 1;
      const best = scored[0];
      const matched = best && best.id === step.id;               // did I pick the advisor's #1?
      const bestTakenByMe = best && !matched && myPickIds.has(best.id);  // I took it, just on my other pick
      // DUAL-VERSION GRADING — never overwrite history. `mine/rank/best` above are the HISTORICAL
      // v1.40 grade (pure: v1.40 bonuses on v1.40 weights, set below). We additionally grade the
      // same pick under the CURRENT v1.50 model and keep both, version-pinned.
      const g150 = v150ReviewGrade(R.geo, step.id, legal, myPickIds, priorRes);
      R.opening.push({ pickNo: overall, mine, rank, total: scored.length, best, matched, bestTakenByMe, regret: best ? Math.max(0, best.score - mine.score) : 0, candidates: scored.slice(0, 8),
        grades: { v140: { rank, total: scored.length, bestLabel: best ? best.label : null, regret: best ? +Math.max(0, best.score - mine.score).toFixed(2) : 0 }, v150: g150 } });
      mine.kinds.forEach(k => priorRes.add(k));
      for (const h of R.geo.corners[step.id].res) priorNum.add(h.dice);
    }
    placedBefore.add(step.id);
  }
  if (R.geo && _activeW) R.geo.weights = _activeW;               // restore the active scorer

  // Second-seat pair check (mirror of the live joint-pair advisor). As 2nd player your two setup
  // spots are a back-to-back PAIR; if together they're within tolerance of the best available pair
  // at your first pick, both count as "good" even if neither was the single #1.
  const amSecond = R.playOrder && R.playOrder.length === 2 && R.playOrder[0] !== R.myColor;
  if (amSecond && R.geo && myPickIds.size === 2) {
    const firstMyIdx = allSetupOrder.findIndex(s => s.owner === R.myColor);
    if (firstMyIdx >= 0) {
      const before = new Set(allSetupOrder.slice(0, firstMyIdx).map(s => s.id));
      const legalThen = R.geo.cornerIds.filter(id => !before.has(id) && ![...before].some(o => R.geo.adj(id, o)));
      const W = R.geo.weights150 || R.geo.weights, lean = R.geo.lean150 || 0;
      const ranked = v150RankPairs(R.geo, legalThen);
      const bestPair = ranked[0];
      const my = [...myPickIds];
      const myPair = v150ScorePair(R.geo, my[0], my[1], { W, lean, startingId: my[1], expansionValue: 0 });
      R.bestPair = bestPair;
      R.pairOptimal = bestPair ? (myPair.score >= bestPair.score - 1.0) : false;
      if (R.pairOptimal) for (const o of R.opening) o.pairGood = true;
    }
  }
  return R;
}

function ordinal(n) { return n + (['th','st','nd','rd'][(n % 100 - n % 10 === 10) ? 0 : (n % 10 < 4 ? n % 10 : 0)]); }

// Derive prioritised, specific coaching takeaways from the analysis.
function reviewTakeaways(R) {
  const me = R.P[R.myColor] || {}, opp = R.P[R.oppColor] || {};
  const t = [];
  // Opening (short summary — the Opening section shows the per-pick detail).
  // A pick I took on my OTHER turn (same spots, different order) is NOT a miss.
  const offs = R.opening.filter(o => !o.matched && !o.bestTakenByMe && !o.pairGood);
  if (R.opening.length && !offs.length) t.push({ tone: 'good', text: 'Textbook opening — you took the advisor\'s top spots.' });
  else if (offs.length) { const w = offs.reduce((a, b) => b.regret > a.regret ? b : a); t.push({ tone: 'bad', text: `Opening: ${offs.length} pick${offs.length > 1 ? 's' : ''} differed from the advisor — biggest gap on your ${ordinal(w.pickNo)} pick (${w.mine.label} vs ${w.best.label}). See the Opening breakdown.` }); }
  // Luck
  if (R.luckMe.pct != null) {
    if (R.luckMe.pct < 92) t.push({ tone: 'info', text: `Dice ran cold for your board (${R.luckMe.pct}% of fair) — production wasn't the main issue.` });
    else if (R.luckMe.pct > 110) t.push({ tone: 'info', text: `Dice favoured your board (${R.luckMe.pct}% of fair) — lean on decisions, not luck.` });
  }
  // Production
  if (me.realIncome && opp.realIncome) {
    if (me.realIncome < opp.realIncome * 0.85) t.push({ tone: 'bad', text: `Out-produced ${me.realIncome} vs ${opp.realIncome} cards from rolls — upgrade to cities / expand sooner.` });
    else if (me.realIncome > opp.realIncome * 1.15) t.push({ tone: 'good', text: `You out-produced the opponent ${me.realIncome} vs ${opp.realIncome} cards from rolls.` });
  }
  // Ports
  const my21 = reviewPorts(me.ratios).filter(p => p.startsWith('2:1'));
  if (my21.length && me.trades < 3) t.push({ tone: 'bad', text: `You held a ${my21[0]} port but only made ${me.trades} trades — use it to convert surplus.` });
  if (opp.trades >= 8 && me.trades < opp.trades * 0.5) t.push({ tone: 'info', text: `Opponent leaned on ports (${opp.trades} trades vs your ${me.trades}) — a port opening can swing the game.` });
  // Hoarding
  if (me.overTimes > 0) t.push({ tone: 'bad', text: `You sat over the ${R.discardLimit}-card limit ${me.overTimes}× (~${me.discarded} cards lost to 7s) — spend before your hand hits ${R.discardLimit}.` });
  // Awards
  const has = (mech, col) => mech && mech[col] && (mech[col].hasLongestRoad || mech[col].hasLargestArmy);
  if (has(R.lr, R.oppColor) && !has(R.lr, R.myColor)) t.push({ tone: 'info', text: 'Opponent took Longest Road (+2 VP) — contest it earlier or deny with the robber.' });
  if (has(R.la, R.oppColor) && !has(R.la, R.myColor)) t.push({ tone: 'info', text: 'Opponent took Largest Army (+2 VP) — buy/play knights to fight for it.' });
  // Steals
  if (R.robbedBy > R.stoleFrom + 2) t.push({ tone: 'info', text: `You were robbed more than you robbed (${R.robbedBy} vs ${R.stoleFrom}) — keep your hand lean and move the robber back.` });
  const bad = t.filter(x => x.tone === 'bad'), rest = t.filter(x => x.tone !== 'bad');
  return bad.concat(rest).slice(0, 5);
}

// Pull the durable capture from the background, analyse the last game, render it.
function runReview() {
  const body = document.getElementById('reviewContent');
  if (body) body.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Analysing the last game…</p></div>';
  chrome.runtime.sendMessage({ type: 'GET_CAPTURE' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) { if (body) body.innerHTML = reviewEmpty('Could not read the capture buffer.'); return; }
    const msgs = resp.capture || [];
    const games = reviewSplitGames(msgs);
    if (!games.length) { if (body) body.innerHTML = reviewEmpty('No game found in the capture yet. Play (or finish) a game with the panel open, then analyse.'); return; }
    try { renderReview(reviewAnalyze(games[games.length - 1])); }
    catch (e) { if (body) body.innerHTML = reviewEmpty('Analysis failed: ' + (e && e.message)); }
  });
}
function reviewEmpty(msg) { return `<div class="empty-state"><div class="empty-icon">📊</div><p>${msg}</p></div>`; }

function renderReview(R) {
  const body = document.getElementById('reviewContent'); if (!body) return;
  const me = R.P[R.myColor] || {}, opp = R.P[R.oppColor] || {};
  const award = (mech, col, key) => mech && mech[col] && mech[col][key] ? 2 : 0;
  const myLR = award(R.lr, R.myColor, 'hasLongestRoad'), myLA = award(R.la, R.myColor, 'hasLargestArmy');
  const opLR = award(R.lr, R.oppColor, 'hasLongestRoad'), opLA = award(R.la, R.oppColor, 'hasLargestArmy');
  const myVP = me.setts + me.cities * 2 + myLR + myLA + (me.myDevVP || 0);
  const opVPvis = opp.setts + opp.cities * 2 + opLR + opLA;
  const won = R.winner === R.myColor, result = R.winner == null ? 'In progress' : won ? 'You won 🏆' : 'You lost';

  const sec = (title, inner) => `<div class="section"><div class="section-header">${title}</div><div class="section-body">${inner}</div></div>`;
  const row = (a, b) => `<div class="rv-row"><span>${a}</span><span>${b}</span></div>`;

  // Result
  let html = sec('Result', row(`<b style="color:${won ? 'var(--green)' : 'var(--red)'}">${result}</b>`, `${R.completedTurns} turns · ${R.totalRolls} rolls`)
    + row('Your VP', `<b>${myVP}</b> <span class="rv-dim">(${me.setts + me.cities * 2} build${myLR ? ' +2 road' : ''}${myLA ? ' +2 army' : ''}${me.myDevVP ? ' +' + me.myDevVP + ' cards' : ''})</span>`)
    + row('Opponent VP', `<b>${opVPvis}</b> <span class="rv-dim">visible${R.winner === R.oppColor ? ' +hidden dev VP' : ''}</span>`));

  // Takeaways (top of report)
  const takes = reviewTakeaways(R);
  if (takes.length) {
    const items = takes.map(t => `<div class="rv-take ${t.tone}">${t.tone === 'good' ? '✓' : t.tone === 'bad' ? '▲' : 'ℹ'} ${t.text}</div>`).join('');
    html = sec('🎯 Takeaways', items) + html;
  }

  // Opening — one box per MY pick: what I took vs what the advisor ranked #1.
  const op = R.opening.map(o => {
    const port = o.mine.port ? ` <span class="rv-port">⚓${o.mine.port.label}</span>` : '';
    let line = `<b>${ordinal(o.pickNo)} pick:</b> your <b>${o.mine.label}</b>${port} (${o.mine.pips}p) ranked <b>#${o.rank}/${o.total}</b>`;
    // DUAL-VERSION: the current model's verdict leads; the historical grade is preserved beneath it
    // and never overwritten. Aggregates must always be read version-pinned.
    const g = o.grades && o.grades.v150;
    const cur = g || o;                        // fall back for records graded before dual-version
    const ok = cur.matched || cur.bestTakenByMe || o.pairGood;
    if (cur.matched) line += ` — <span style="color:var(--green)">you took the best spot ✓</span>`;
    else if (cur.bestTakenByMe) line += ` — <span style="color:var(--green)">you took both best spots, just in a different order ✓</span>`;
    else if (o.pairGood) line += ` — <span style="color:var(--green)">part of your optimal back-to-back pair ✓</span>`;
    else if (o.best) line += ` — better pick was <b>${o.best.label}</b> (${o.best.pips}p${o.best.port ? ', ' + o.best.port.label : ''})`;
    let sub = '';
    if (o.grades) {
      sub = `<div class="rv-dim" style="font-size:9px;margin-top:2px">`
          + `current v1.50: #${o.grades.v150.rank}/${o.grades.v150.total} · regret ${o.grades.v150.regret}`
          + ` &nbsp;|&nbsp; model at the time v1.40: #${o.grades.v140.rank}/${o.grades.v140.total} · regret ${o.grades.v140.regret}</div>`;
    }
    return `<div class="rv-take ${ok ? 'good' : 'bad'}">${line}${sub}</div>`;
  }).join('');
  html += sec('Opening — your picks vs the advisor', op || '<div class="rv-dim">No setup settlements recorded.</div>');

  // Dice & luck
  const lk = p => p == null ? '—' : p + '%';
  html += sec('Dice &amp; Luck',
    row('Board luck (dice vs fair)', `you <b>${lk(R.luckMe.pct)}</b> · opp <b>${lk(R.luckOpp.pct)}</b>`)
    + row('Resources from rolls', `you <b>${me.realIncome || 0}</b> · opp <b>${opp.realIncome || 0}</b>`)
    + row('6 / 8 rolled', `${R.rollCounts[6] || 0} / ${R.rollCounts[8] || 0} <span class="rv-dim">(exp ~${Math.round(R.totalRolls * 5 / 36)} each)</span>`)
    + row('7s rolled', `you ${R.sevensBy[R.myColor] || 0} · opp ${R.sevensBy[R.oppColor] || 0}`));

  // Hand & robber
  html += sec('Hand &amp; Robber',
    row(`Cards lost to 7s (limit ${R.discardLimit})`, `you ≈<b>${me.discarded || 0}</b> · opp ≈<b>${opp.discarded || 0}</b>`)
    + row('Over the limit on a 7', `you ${me.overTimes || 0}× · opp ${opp.overTimes || 0}×`)
    + row('Steals', `you stole ${R.stoleFrom} · robbed ${R.robbedBy}×`));

  // Ports & trades
  const pstr = pl => { const ps = reviewPorts(pl.ratios); return ps.length ? ps.join(', ') : 'none'; };
  html += sec('Ports &amp; Trades',
    row('Your ports', `${pstr(me)} <span class="rv-dim">· ${me.trades || 0} trades</span>`)
    + row('Opp ports', `${pstr(opp)} <span class="rv-dim">· ${opp.trades || 0} trades</span>`));

  // Economy & dev
  const devStr = pl => { const d = pl.devPlays || {}; const parts = []; for (const [k, v] of Object.entries(d)) if (v) parts.push(v + ' ' + k); return parts.join(', ') || 'none'; };
  html += sec('Economy &amp; Dev',
    row('Buildings', `you ${me.setts}s ${me.cities}c · opp ${opp.setts}s ${opp.cities}c`)
    + row('Dev cards played', `you: ${devStr(me)}`)
    + row('', `opp: ${devStr(opp)}`)
    + row('Awards', `${myLR ? 'You: Longest Road. ' : ''}${myLA ? 'You: Largest Army. ' : ''}${opLR ? 'Opp: Longest Road. ' : ''}${opLA ? 'Opp: Largest Army.' : ''}` || '—'));

  body.innerHTML = html;
}

// ─── Game Archive (durable dataset for the learning advisor) ───────────────────
// Every COMPLETED game is stored in chrome.storage.local (unlimitedStorage → survives the
// 40k rolling-capture rollover) AND written as a compact record to
// Downloads/Catan saved games/game-<id>.json. That single folder IS the corpus the offline
// (Python) learner reads directly. Dedup by gameSettings.id.

function reviewBoardRaw(ms) {
  if (!ms) return null;
  return { tileHexStates: ms.tileHexStates || null, tileCornerStates: ms.tileCornerStates || null, portEdgeStates: ms.portEdgeStates || null };
}

// Serializable per-game record (no functions / no geo closures).
// ─── Recording integrity audit ────────────────────────────────────────────────
// A raw file EXISTING does not mean it contains the whole game. A browser crash, extension
// restart, socket drop or buffer flush can leave a perfectly valid-looking PARTIAL capture. So
// every game gets an explicit integrity verdict, and anything suspect is flagged OUT of the
// research set at write time rather than being rediscovered by every future analysis script.
//
//   GAME START → SETUP (4 placements) → FIRST ROLL → … → TYPE-45 END GAME
//
// Missing any of those landmarks ⇒ the capture is incomplete, not merely unusual.
function buildCaptureIntegrity(game, R) {
  const msgs = (game && game.msgs) || [];
  const hexes = R.geo ? Object.values(R.geo.hexByCoord || {}) : [];
  const numbered = hexes.filter(h => h && h.res !== 'desert' && h.dice);
  const deserts = hexes.filter(h => h && h.res === 'desert');

  // Board sanity: structural only. We deliberately do NOT assert an exact resource distribution —
  // that would false-flag any variant board — but the shape of a standard board must hold.
  const boardValid = !!R.geo && hexes.length === 19 && deserts.length === 1 && numbered.length === 18;
  // Setup sanity: 4 placements in a 1v1 snake, and a legal play order.
  const snakeValid = !!(R.playOrder && R.playOrder.length === 2 && R.playOrder[0] !== R.playOrder[1]);
  const setupValid = R.setupPlacements === 4 && snakeValid;

  const rawWritten = msgs.length > 0;
  const firstRollSeen = (R.totalRolls || 0) > 0;
  const endGameMessageSeen = !!R.endGame;
  const replayCompleted = !!R.geo && R.myColor != null;
  const captureComplete = rawWritten && replayCompleted && setupValid && boardValid
                       && firstRollSeen && endGameMessageSeen;

  // First failing check decides the exclusion reason — ordered most-fundamental first.
  let reason = null;
  if (!rawWritten) reason = 'missing_raw';
  else if (!replayCompleted) reason = 'replay_error';
  else if (!boardValid) reason = 'invalid_board';
  else if (!setupValid) reason = 'invalid_setup';
  else if (!firstRollSeen) reason = 'missing_first_roll';
  else if (!endGameMessageSeen) reason = 'missing_end_game';

  return {
    rawWritten, rawMessageCount: msgs.length, replayCompleted,
    setupPlacements: R.setupPlacements || 0, setupValid,
    boardValid, hexCount: hexes.length, numberedHexes: numbered.length,
    firstRollSeen, rollCount: R.totalRolls || 0, endGameMessageSeen,
    captureComplete,
    researchEligible: captureComplete,
    researchExclusionReason: reason,
  };
}

// Content hash of the raw capture. Identifies the exact source a record came from and catches the
// same game being stored twice under different filenames. FNV-1a (not SHA-256): this must run
// synchronously in the panel, and it only needs to detect difference, not resist attack.
function rawSourceHash(game) {
  const msgs = (game && game.msgs) || [];
  if (!msgs.length) return null;
  let h = 0x811c9dc5;
  for (const m of msgs) {
    const s = (m.i != null ? m.i : '') + '|' + (m.t != null ? m.t : '') + '|' + (m.len != null ? m.len : '') + '|' + (m.fb || '');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return msgs.length + '-' + (h >>> 0).toString(16).padStart(8, '0');
}

// One first-class block describing the opening, so analysis never has to re-derive it from
// scattered fields. Crucially it makes SETUP ORDER unambiguous: only the SECOND settlement grants
// starting cards (P1 → pick #4, P2 → pick #3), so the two placements are not analytically
// interchangeable and must be labelled, not inferred.
function buildOpeningState(R) {
  const geo = R.geo;
  if (!geo || !Array.isArray(R.opening) || !R.opening.length) return null;
  const picks = R.opening.slice().sort((a, b) => a.pickNo - b.pickNo);   // ascending = placement order
  const first = picks[0], second = picks[picks.length - 1];
  const ids = picks.map(p => p.mine && p.mine.id).filter(Boolean);
  if (!ids.length) return null;

  const W = geo.weights150 || geo.weights;
  const detail = (p, grants) => {
    const id = p.mine && p.mine.id;
    return {
      pickNo: p.pickNo, cornerId: id, grantsStartingCards: grants,
      label: p.mine && p.mine.label,
      hexes: id ? v150CornerHexes(geo, id).map(h => ({ res: h.res, dice: h.dice })) : null,
      port: (geo.cornerPort && geo.cornerPort[id]) || null,
      // advisor output AT PLACEMENT TIME
      rank: p.rank, outOf: p.total, regret: p.regret != null ? +Number(p.regret).toFixed(3) : null,
      matchedAdvisorTop: !!p.matched,
    };
  };
  const pips = ids.reduce((acc, id) => v150Add(acc, v150CornerPips(geo, id)), v150Zero());
  const numbers = [];
  for (const id of ids) for (const h of v150CornerHexes(geo, id)) if (!numbers.includes(h.dice)) numbers.push(h.dice);
  const ports = ids.map(id => geo.cornerPort && geo.cornerPort[id]).filter(Boolean)
                   .map(p => ({ ratio: p.ratio, res: p.res || null, label: p.label }));
  const rawProduction = ids.reduce((s, id) => s + v150RawCorner(geo, id, W), 0);
  const portInfo = ids.length === 2 ? v150PortValue(geo, ids[0], ids[1], pips, geo.lean150 || 0) : { best: 0 };
  const bridge = ids.length === 2 ? v150ValidPortBridge(geo, ids[0], ids[1], pips) : false;

  return {
    seat: R.playOrder && R.playOrder.length === 2 ? (R.playOrder[0] === R.myColor ? 'P1' : 'P2') : null,
    // Explicit, not inferred: which physical placement came first, and which one paid starting cards.
    // Each placement carries what the advisor KNEW AT THAT MOMENT (rank/regret are computed against
    // the spots legal at that pick, never against the final board) so future research can ask
    // "was this good given the information available then?" rather than judging in hindsight.
    setupOrder: {
      firstSettlement:  detail(first,  false),
      secondSettlement: detail(second, true),
    },
    corners: ids,
    labels: picks.map(p => p.mine && p.mine.label),
    resourcePips: pips,
    numbers: numbers.sort((a, b) => a - b),
    ports,
    rawProduction: +rawProduction.toFixed(3),
    weights: W,
    boardLean: geo.lean150 != null ? +geo.lean150.toFixed(3) : null,
    engineClass: ids.length === 2 ? v150Viability(pips, portInfo.best, bridge) : null,
    // Starting cards come from the SECOND settlement only — 1 per adjacent producing hex.
    startingCards: second.mine && second.mine.id ? v150StartingCards(geo, second.mine.id) : null,
  };
}

function buildGameRecord(game, R) {
  const me = R.P[R.myColor] || {}, opp = R.P[R.oppColor] || {};
  const slim = pl => ({ setts: pl.setts||0, cities: pl.cities||0, realIncome: pl.realIncome||0, setupGain: pl.setupGain||0, trades: pl.trades||0, devPlays: pl.devPlays||{}, myDevVP: pl.myDevVP||0, ratios: pl.ratios||null });
  const aw = (mech, col, key) => !!(mech && mech[col] && mech[col][key]);
  return {
    gameId: game.id, savedAt: new Date().toISOString(),
    // Wall-clock bounds from the capture itself (not derived from a single timestamp), so
    // time-of-day / session / ordering effects are answerable later without inference.
    startedAt: R.startedAt || null, endedAt: R.endedAt || null,
    sourceHash: rawSourceHash(game),        // identifies the exact raw capture + catches duplicates
    // Explicit data-quality verdict. researchEligible === false means DO NOT use this game for
    // outcome analysis — the reason says why. Computed once, at write time.
    captureIntegrity: buildCaptureIntegrity(game, R),
    // Full reproducibility block. Each layer can change independently of the others, so a result is
    // only reproducible if you know all of them. scorerConfigHash catches silent constant edits.
    version: {
      capture: CAPTURE_VERSION, protocolParser: PROTOCOL_PARSER_VERSION,
      replay: REPLAY_VERSION, recordSchema: RECORD_SCHEMA_VERSION,
      scorer: PLACEMENT_SCORER_VERSION, scorerConfigHash: configHash(V150),
    },
    // SEMANTICS: this is the scorer that produced the advice the player actually saw during setup.
    // If a record is ever regenerated from raw under a newer scorer, this field must be CARRIED
    // FORWARD from the original record, never overwritten with the then-installed version.
    capturedScorer: { version: PLACEMENT_SCORER_VERSION, weights: (R.geo && R.geo.weights150) || null, lean: (R.geo && R.geo.lean150) != null ? +R.geo.lean150.toFixed(3) : null },
    myColor: R.myColor, oppColor: R.oppColor, playOrder: R.playOrder,
    amFirst: R.playOrder ? R.playOrder[0] === R.myColor : null,
    winner: R.winner, iWon: R.winner === R.myColor,
    vpToWin: R.vpToWin, discardLimit: R.discardLimit,
    // TURN COUNTING — two values that legitimately differ by one. `completedTurns` is the server's
    // count of turns FINISHED; `terminalTurnNumber` (endGame.totalTurnCount) includes the turn the
    // game ended on, which was never "completed". Both are recorded under explicit names so a later
    // "average game length" never silently mixes them. `turns` is kept as an alias of
    // completedTurns for the existing analysis scripts.
    turns: R.completedTurns, completedTurns: R.completedTurns,
    terminalTurnNumber: (R.endGame && R.endGame.totalTurnCount != null) ? R.endGame.totalTurnCount : null,
    rolls: R.totalRolls, rollCounts: R.rollCounts, rollSequence: R.rollSequence || null, sevensBy: R.sevensBy,
    luckMe: R.luckMe.pct, luckOpp: R.luckOpp.pct,
    stoleFrom: R.stoleFrom, robbedBy: R.robbedBy,
    awards: { lrMe: aw(R.lr, R.myColor, 'hasLongestRoad'), laMe: aw(R.la, R.myColor, 'hasLargestArmy'), lrOpp: aw(R.lr, R.oppColor, 'hasLongestRoad'), laOpp: aw(R.la, R.oppColor, 'hasLargestArmy') },
    me: slim(me), opp: slim(opp),
    // Ground truth from colonist's end-game payload. Recorded verbatim — no scoring depends on it.
    // `decided:false` means NOBODY reached vpToWin, i.e. the game was conceded/abandoned and must
    // be excluded from any outcome analysis.
    endGame: R.endGame || null,
    finalVP: R.finalVP || null,
    // SERVER-designated winner (authoritative for who "won" the match, incl. concessions)…
    winnerVP: R.winnerVP != null ? R.winnerVP : null,
    // …vs who actually led on VP at termination. These differ when a player ahead on points
    // concedes. Use leaderVP for anything about board position; winner for match outcome.
    leader: R.leader != null ? R.leader : null, leaderVP: R.leaderVP != null ? R.leaderVP : null,
    // NOTE: a decided winner finishes at >= vpToWin, NOT exactly at it. Hidden VP cards are all
    // revealed on the winning turn, so a player can jump from 13 visible straight to 16.
    decided: R.decided != null ? R.decided : null, conceded: R.conceded != null ? R.conceded : null,
    mmr: R.mmr || null, mmrComplete: !!R.mmrComplete,
    openingState: buildOpeningState(R),   // first-class: seat, setup order, pips, ports, engine class
    opening: R.opening,        // per my setup pick: {mine, rank, total, regret, best, candidates}
    board: R.boardRaw,         // raw hexes/corners/ports → offline can recompute any feature
  };
}

// Scan the durable capture, archive every completed game not already stored.
function archiveCompletedGames(cb) {
  if (state.saveEnabled === false) { addEvent('💾 Saving OFF — game not saved (test mode)'); if (cb) cb(0); return; }
  chrome.runtime.sendMessage({ type: 'GET_CAPTURE' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) { if (cb) cb(0); return; }
    const games = reviewSplitGames(resp.capture || []);
    chrome.storage.local.get(['catanGames'], (store) => {
      const idx = store.catanGames || {};
      let added = 0;
      for (const g of games) {
        if (idx[g.id]) continue;                    // already archived
        let R; try { R = reviewAnalyze(g); } catch (e) { continue; }
        if (!R || R.winner == null) continue;       // only completed games
        const rec = buildGameRecord(g, R);
        idx[g.id] = rec;
        saveGameFile(rec);
        setTimeout(() => saveGameRaw(g), 300);       // raw (for the future Turn Coach corpus), staggered
        added++;
      }
      chrome.storage.local.set({ catanGames: idx }, () => {
        if (added) addEvent(`📦 Archived ${added} game(s) — ${Object.keys(idx).length} stored total`);
        renderArchive(); if (cb) cb(added);
      });
    });
  });
}

// CORPUS SEPARATION: games played under the v1.50 scorer live in their own subfolder so they never
// mix with the 111-game v1.40-era corpus. Openings were graded by a different model, so pooling them
// would silently blend two scorer versions into one time series (records also carry `capturedScorer`
// for belt-and-braces version pinning). Bump this when a future scorer changes grading again.
const CORPUS_DIR = 'Catan saved games/Games after v.156';

// Write one game's record to Downloads/<CORPUS_DIR>/ (stable name → overwrite, no dupes).
// That folder IS the current corpus: the offline pipeline reads game-*.json straight from it, and
// you can drop another machine's game-*.json into the same folder to pool them.
function saveGameFile(rec) {
  const safe = String(rec.gameId).replace(/[^a-z0-9_-]/gi, '') || 'unknown';
  downloadJSON(JSON.stringify(rec), `${CORPUS_DIR}/game-${safe}.json`);
}

// Preserve the FULL raw game (all messages) in a subfolder. From this we can later replay
// the game and reconstruct, per turn, what the Turn Coach would suggest AND what I actually
// did — the corpus for the future Turn Coach learner. (The small records in the main folder
// stay lean for the placement pipeline.)
function saveGameRaw(game) {
  const safe = String(game.id).replace(/[^a-z0-9_-]/gi, '') || 'unknown';
  const payload = { meta: { schema: 'catan-game-raw/v1', gameId: game.id, savedAt: new Date().toISOString(), messageCount: game.msgs.length }, messages: game.msgs };
  downloadJSON(JSON.stringify(payload), `${CORPUS_DIR}/raw/game-${safe}.json`);
}

function renderArchive() {
  chrome.storage.local.get(['catanGames'], (store) => {
    const games = Object.values(store.catanGames || {});
    const wins = games.filter(g => g.iWon).length;
    const firsts = games.filter(g => g.amFirst === true).length;
    // Corpora are kept separate: games recorded under the current scorer vs the older v1.40-era set.
    // Never quote a combined stat — the two were graded by different models.
    const cur = games.filter(g => g.capturedScorer && g.capturedScorer.version === PLACEMENT_SCORER_VERSION);
    const curW = cur.filter(g => g.iWon).length;
    const savedEl = document.getElementById('savedCount');
    if (savedEl) savedEl.innerHTML = cur.length
      ? `<b>${cur.length}</b> on ${PLACEMENT_SCORER_VERSION} <span class="rv-dim">· ${games.length - cur.length} legacy</span>`
      : `<b>${games.length}</b> games saved <span class="rv-dim">(all legacy)</span>`;
    const statsEl = document.getElementById('archiveStats');
    if (statsEl) statsEl.innerHTML = cur.length
      ? `${PLACEMENT_SCORER_VERSION}: <b>${curW}</b>W · <b>${cur.length - curW}</b>L`
      : (games.length ? `<b>${wins}</b>W · <b>${games.length - wins}</b>L` : '');
    const list = document.getElementById('archiveList');
    if (list) {
      if (!games.length) { list.innerHTML = '<div class="rv-dim" style="font-size:11px">No games saved yet on this machine. Finish a game (auto-saves), or click below to save games already in memory.</div>'; return; }
      const summary = `<div class="rv-row"><span>Record</span><span><b>${wins}</b>W · <b>${games.length - wins}</b>L · ${firsts} as 1st</span></div>`;
      const rows = games.slice(-10).reverse().map(g =>
        `<div class="rv-row"><span>${String(g.gameId || '').slice(0, 8)} ${g.iWon ? '<span style="color:var(--green)">W</span>' : '<span style="color:var(--red)">L</span>'}</span><span class="rv-dim">${g.amFirst ? '1st' : '2nd'} pick · ${g.turns}t · luck ${g.luckMe}%</span></div>`).join('');
      list.innerHTML = summary + rows;
    }
  });
}

// ─── Status ──────────────────────────────────────────────────────────────────
function setStatus(s) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  dot.className = 'status-dot';
  if (s === 'waiting') label.textContent = 'Waiting for game...';
  else if (s === 'connected') { dot.classList.add('connected'); label.textContent = 'Connected'; }
  else if (s === 'active') { dot.classList.add('active'); label.textContent = 'Game active'; }
  else if (s === 'disconnected') label.textContent = 'Reconnecting...';
}

// ─── Event / Debug logs (Debug tab only; rebuilt on tab open) ──────────────────
function debugVisible() {
  const p = document.getElementById('panel-debug');
  return p && p.classList.contains('active');
}
function addEvent(text) {
  state.events.unshift(text);
  if (state.events.length > 60) state.events.pop();
  if (debugVisible()) renderEventLog();
}
function renderEventLog() {
  const el = document.getElementById('eventLog');
  if (!el) return;
  el.innerHTML = state.events.slice(0, 25).map(e =>
    `<div style="padding:2px 0;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:9px">${e}</div>`
  ).join('') || '<span style="color:var(--text-muted);font-size:9px">No events yet</span>';
}
function debugLineText(msg) {
  if (msg.type === 'binary') return `[${msg.byteLength}B] ${msg.firstByte} | ${msg.ascii ? msg.ascii.slice(0, 60) : ''}`;
  return typeof msg.raw === 'string' ? msg.raw.slice(0, 150) : JSON.stringify(msg.data || msg).slice(0, 150);
}
function addDebugLine(msg) {
  if (!debugVisible()) return;
  const log = document.getElementById('debugLog');
  if (!log) return;
  const dir = msg.direction || 'RECV';
  const line = document.createElement('div');
  line.className = `log-line ${dir === 'SEND' ? 'send' : 'recv'}`;
  line.textContent = `[${dir}] ${debugLineText(msg)}`;
  log.insertBefore(line, log.firstChild);
  while (log.children.length > 150) log.removeChild(log.lastChild);
}
function rebuildDebugLog() {
  const log = document.getElementById('debugLog');
  if (!log) return;
  log.innerHTML = state.rawMessages.slice(0, 150).map(msg => {
    const dir = msg.direction || 'RECV';
    const el = document.createElement('div');
    el.className = `log-line ${dir === 'SEND' ? 'send' : 'recv'}`;
    el.textContent = `[${dir}] ${debugLineText(msg)}`;
    return el.outerHTML;
  }).join('') || '<div class="log-line" style="color:var(--text-muted)">Waiting for colonist.io messages...</div>';
}

// ─── Tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'debug') { rebuildDebugLog(); renderEventLog(); }
    if (tab.dataset.tab === 'review') renderArchive();
  });
});

// ─── Reset ───────────────────────────────────────────────────────────────────
// softReset: new game detected mid-session. Keeps capture logger untouched.
function softReset() {
  state.myColor = null; state.oppColor = null; state.colors = [];
  state.currentTurnColor = null; state.completedTurns = 0;
  state.robberPending = false;
  state.sawSetup = false;
  state._portDumped = false;
  state.players = {};
  state.rolls = []; state.rollCounts = {}; state.totalRolls = 0;
  for (let i = 2; i <= 12; i++) state.rollCounts[i] = 0;
  state.dice = newDiceModel();
  state.processedLogIds = new Set();
  state.devCount = {};
  state.dev = { bankRemaining: null, plays: [], played: { knight:0, vp:0, road_building:0, year_of_plenty:0, monopoly:0, unknown:0 } };
  // Win-Path live state — all of it is per-game and MUST be cleared, or a merged VP/award from the
  // previous game carries into the next one and the advisor opens with a wrong score.
  state.vp = {}; state.awards = { la: {}, lr: {} }; state.roadLen = {};
  state.knights = {}; state.robberTile = null; state.tradeRatios = {}; state.myDevCards = [];
  state.board = null;
  state.cornerOwner = {};
  state.edgeOwner = {};
  state.setupMySettles = [];
  state.playOrder = null;
  addEvent('— new game detected, tracking reset —');
}
document.getElementById('btnClearLog').addEventListener('click', () => {
  const log = document.getElementById('debugLog'); if (log) log.innerHTML = '';
});
document.getElementById('btnReview').addEventListener('click', runReview);
document.getElementById('btnRescan').addEventListener('click', () => archiveCompletedGames());

// ─── Clear saved games (clean slate) ──────────────────────────────────────────
// Games live in TWO places: the Downloads folder (what the Python pipeline reads) and this
// chrome.storage index (what the Review tab shows AND what `archiveCompletedGames` dedups against).
// Deleting only the files leaves the index thinking those games are saved, so they would never be
// re-written. This clears the index; the note tells you which folder to delete alongside it.
const btnClearArchive = document.getElementById('btnClearArchive');
if (btnClearArchive) {
  let armed = false, armTimer = null;
  btnClearArchive.addEventListener('click', () => {
    const note = document.getElementById('clearArchiveNote');
    if (!armed) {                                  // two-step confirm — this is not undoable
      armed = true;
      btnClearArchive.textContent = '⚠ Click again to confirm';
      if (note) note.innerHTML = 'This wipes the extension\'s saved-game index (not the files). Click again within 5s.';
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = false; btnClearArchive.textContent = '🗑 Clear saved games'; if (note) note.textContent = ''; }, 5000);
      return;
    }
    clearTimeout(armTimer); armed = false;
    btnClearArchive.textContent = '🗑 Clear saved games';
    chrome.storage.local.remove(['catanGames'], () => {
      chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURE' }, () => {});   // drop the in-memory buffer too
      addEvent('🗑 Saved-game index cleared — delete the game-*.json records, but KEEP raw/');
      if (note) note.innerHTML = 'Index cleared. Delete only <b>v150/game-*.json</b>. '
        + '<b style="color:var(--red)">Do NOT delete v150/raw/</b> — records can be regenerated from raw, '
        + 'raw can never be regenerated from anything.';
      renderArchive();
    });
  });
}

// ─── Save toggle ── OFF ⇒ play test games without persisting them to the corpus ──
const saveToggleBtn = document.getElementById('saveToggle');
function renderSaveToggle() {
  if (!saveToggleBtn) return;
  saveToggleBtn.textContent = state.saveEnabled ? 'ON' : 'OFF';
  saveToggleBtn.classList.toggle('on', state.saveEnabled);
  saveToggleBtn.classList.toggle('off', !state.saveEnabled);
}
chrome.storage.local.get(['saveEnabled'], (s) => {
  state.saveEnabled = s.saveEnabled !== false;            // default ON
  renderSaveToggle();
});
if (saveToggleBtn) saveToggleBtn.addEventListener('click', () => {
  state.saveEnabled = !state.saveEnabled;
  chrome.storage.local.set({ saveEnabled: state.saveEnabled });
  addEvent(state.saveEnabled ? '💾 Saving ON — completed games will be saved'
                             : '💾 Saving OFF — test games will NOT be saved');
  renderSaveToggle();
});

// ─── Capture logger controls ──────────────────────────────────────────────────
document.getElementById('btnSaveNow').addEventListener('click', () => downloadCapture(false));
document.getElementById('btnSaveArchive').addEventListener('click', () => downloadCapture(true));
document.getElementById('btnToggleCapture').addEventListener('click', () => {
  state.capturing = !state.capturing;
  addEvent(`[CAPTURE] ${state.capturing ? 'resumed' : 'paused'}`);
  renderCaptureStatus();
});
document.getElementById('btnClearCapture').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURE' }, () => {});
  state.captureCount = 0; state.gameMsgCount = 0; state.lastSavedGameMsgCount = -1;
  state.lastSave = null; state.saveError = null;
  addEvent('[CAPTURE] cleared'); renderCaptureStatus();
});

// ─── Initial render ──────────────────────────────────────────────────────────
renderAll();
renderCaptureStatus();
renderArchive();
console.log('[Sidepanel] Ready — validated protocol model v2.');
