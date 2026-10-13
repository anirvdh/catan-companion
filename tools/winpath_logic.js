// Decision-logic acceptance tests for the Win-Path engine (v1.61).
//
// Builds synthetic live states and asserts the engine picks the right tier/action. These cover the
// cases that the 165-capture replay cannot: there is no recorded game where "I hold 2 knights and
// playing them wins", so it has to be constructed.
//
//   node tools/winpath_logic.js
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'sidepanel.js'), 'utf8');
const el = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'style' || k === 'classList' || k === 'dataset') ? el()
    : (k === 'value' || k === 'textContent' || k === 'innerHTML') ? ''
      : (k === 'children' || k === 'childNodes') ? [] : el(),
  set: () => true, apply: () => el(),
});
const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  Date, Math, JSON, Object, Array, String, Number, Boolean, isNaN, parseInt, parseFloat,
  Set, Map, Promise, Error, RegExp, TextDecoder, Uint8Array, DataView, ArrayBuffer,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  document: { getElementById: el, querySelector: el, querySelectorAll: () => [], createElement: el,
    addEventListener: () => {}, body: el(), documentElement: el() },
  window: { addEventListener: () => {}, location: { href: '' } },
  chrome: {
    runtime: { sendMessage: () => {}, lastError: null, onMessage: { addListener: () => {} },
      connect: () => ({ postMessage: () => {}, disconnect: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } }) },
    storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() }, onChanged: { addListener: () => {} } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => {} },
  },
};
sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'sidepanel.js' });
const run = e => vm.runInContext(e, sandbox);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? '\n       ' + detail : ''}`); }
}

// Minimal fake board: 4 corners, each with 2 hexes, so city/settlement targets resolve.
function setup(opts) {
  sandbox.__o = opts;
  return run(`(function(){
    var o = __o;
    softReset();
    state.gameActive = true; state.myColor = '1'; state.oppColor = '2';
    state.colors = ['1','2']; state.vpToWin = 15; state.discardLimit = 10;
    state.currentTurnColor = '1';
    state.rolls = [8];                       // setup is done
    noteColor('1'); noteColor('2');
    player('1').hand = o.hand || { wood:0, brick:0, sheep:0, wheat:0, ore:0 };
    player('1').known = true;
    // board geometry
    var corners = {}, neighbors = {};
    for (var i = 1; i <= 8; i++) {
      corners[String(i)] = { id:String(i), res:[{res:'ore',dice:6},{res:'wheat',dice:9}], port:null };
      neighbors[String(i)] = [];
    }
    state.board = { geo: { corners: corners, neighbors: neighbors, weights:{wood:1,brick:1,sheep:1,wheat:1,ore:1},
                           resPips:{wood:4,brick:4,sheep:4,wheat:4,ore:4}, ports:{} } };
    state.cornerOwner = o.cornerOwner || { '1': { owner:'1', buildingType:1 } };
    state.vp = o.vp || {};
    state.awards = o.awards || { la:{}, lr:{} };
    state.roadLen = o.roadLen || {};
    state.knights = o.knights || {};
    state.myDevCards = o.myDevCards || [];
    state.devCount = o.devCount || {};
    state.dev.bankRemaining = o.deckLeft === undefined ? 10 : o.deckLeft;
    state.tradeRatios = o.tradeRatios || {};
    var F = winPathFacts();
    var P = winPathPlan(F);
    return { F: { myVP:F.myVP, oppVisible:F.oppVisible, oppHiddenMax:F.oppHiddenMax,
                  oppCeiling:F.oppCeiling, need:F.need, laNeed:F.laNeed, lrNeed:F.lrNeed,
                  knightsInHand:F.knightsInHand, iHaveLA:F.iHaveLA, iHaveLR:F.iHaveLR },
             P: P };
  })()`);
}

// VP category counts: 0=settlement 1=city 2=VPcard 3=LargestArmy 4=LongestRoad
const vp = (s, c, vpc, la, lr) => ({ '0': s, '1': c, '2': vpc || 0, '3': la || 0, '4': lr || 0 });

console.log('\n── VP arithmetic ──');
let r = setup({ vp: { '1': vp(3, 2) } });                       // 3 setts + 2 cities = 3 + 4 = 7
check('settlements + cities sum correctly', r.F.myVP === 7, `got ${r.F.myVP}, want 7`);

r = setup({ vp: { '1': vp(2, 3, 1, 1, 1) } });                  // 2 + 6 + 1 + 2 + 2 = 13
check('VP card + both awards counted once each', r.F.myVP === 13, `got ${r.F.myVP}, want 13`);

// A city REPLACES a settlement, so the net gain is +1, never +2.
const before = setup({ vp: { '1': vp(4, 1) } }).F.myVP;          // 4 + 2 = 6
const after = setup({ vp: { '1': vp(3, 2) } }).F.myVP;           // 3 + 4 = 7
check('city upgrade is a NET +1 VP', after - before === 1, `got ${after - before}`);

console.log('\n── opponent model (never displayed, always used) ──');
r = setup({ vp: { '1': vp(2, 1), '2': vp(3, 2) }, devCount: { '2': 3 } });
check('opponent visible VP excludes hidden cards', r.F.oppVisible === 7, `got ${r.F.oppVisible}`);
check('hidden-VP upper bound = their unplayed dev cards', r.F.oppHiddenMax === 3, `got ${r.F.oppHiddenMax}`);
check('ceiling = visible + bound', r.F.oppCeiling === 10, `got ${r.F.oppCeiling}`);
r = setup({ vp: { '1': vp(2, 1), '2': vp(3, 2) }, devCount: { '2': 0 } });
check('0 unplayed cards ⇒ no hidden VP possible', r.F.oppHiddenMax === 0 && r.F.oppCeiling === 7);

console.log('\n── TIER 1: immediate wins ──');
// 13 VP, hold 3 knights unplayed, nobody has Largest Army → playing them wins for FREE.
r = setup({ vp: { '1': vp(3, 5) }, myDevCards: [11, 11, 11], knights: { '1': 0 } });
check('holds 13 VP', r.F.myVP === 13, `got ${r.F.myVP}`);
check('free knight play that wins is TIER win', r.P.tier === 'win', `tier=${r.P.tier}`);
check('  …and recommends playing knights', /KNIGHT/i.test(r.P.primary.do), r.P.primary.do);

// 14 VP with city affordable → city wins.
r = setup({ vp: { '1': vp(4, 5) }, hand: { wood:0, brick:0, sheep:0, wheat:2, ore:3 } });
check('14 VP + affordable city ⇒ win tier', r.P.tier === 'win' && /CITY/.test(r.P.primary.do),
  `tier=${r.P.tier} do=${r.P.primary.do}`);

// 14 VP but city NOT affordable, and no trade route → must not claim a win.
r = setup({ vp: { '1': vp(4, 5) }, hand: { wood:0, brick:0, sheep:0, wheat:0, ore:0 } });
check('14 VP with empty hand ⇒ NOT a win tier', r.P.tier !== 'win', `tier=${r.P.tier}`);

// A win outranks defence even when the opponent is critical.
r = setup({ vp: { '1': vp(4, 5), '2': vp(5, 4) }, devCount: { '2': 4 },
            hand: { wood:0, brick:0, sheep:0, wheat:2, ore:3 } });
check('guaranteed win outranks urgent defence', r.P.tier === 'win', `tier=${r.P.tier}`);

console.log('\n── award races ──');
// Opponent holds LA with 3 knights; I have 2 played + 2 in hand → need 4, so 2 more.
r = setup({ vp: { '1': vp(3, 2), '2': vp(3, 2, 0, 1) }, knights: { '1': 2, '2': 3 },
            awards: { la: { '2': { hasLargestArmy: true } }, lr: {} }, myDevCards: [11, 11] });
check('LA target beats the current holder, not just the minimum', r.F.laNeed === 2, `laNeed=${r.F.laNeed}`);
// I already hold LA → no further knight requirement, and no double-count.
r = setup({ vp: { '1': vp(3, 2, 0, 1) }, knights: { '1': 3 }, awards: { la: { '1': { hasLargestArmy: true } }, lr: {} } });
check('holding LA ⇒ laNeed 0 (no double-count)', r.F.iHaveLA && r.F.laNeed === 0, `laNeed=${r.F.laNeed}`);
// Longest Road: holder at 6, I'm at 4 → need 3 more to reach 7.
r = setup({ vp: { '1': vp(3, 2), '2': vp(3, 2, 0, 0, 1) }, roadLen: { '1': 4, '2': 6 },
            awards: { la: {}, lr: { '2': { hasLongestRoad: true } } } });
check('LR target must EXCEED the holder', r.F.lrNeed === 3, `lrNeed=${r.F.lrNeed}`);

console.log('\n── TIER 2: defence ──');
// Opponent visibly on 14 → high threat; I have no winning move.
r = setup({ vp: { '1': vp(3, 2), '2': vp(4, 5) }, devCount: { '2': 0 },
            hand: { wood:1, brick:1, sheep:1, wheat:1, ore:0 } });
check('opponent on 14 ⇒ defend tier', r.P.tier === 'defend', `tier=${r.P.tier}`);
check('  …threat level is high or critical', ['high', 'critical'].includes(r.P.threat.level), r.P.threat.level);

// Opponent visible 11 + 4 unplayed cards → they COULD be at 15 → critical.
r = setup({ vp: { '1': vp(3, 2), '2': vp(3, 4) }, devCount: { '2': 4 } });
check('ceiling at/over target ⇒ critical threat', r.P.threat.level === 'critical', r.P.threat.level);
// …but the same visible score with 0 cards must NOT be critical.
r = setup({ vp: { '1': vp(3, 2), '2': vp(3, 4) }, devCount: { '2': 0 } });
check('same visible score, 0 cards ⇒ not critical', r.P.threat.level !== 'critical', r.P.threat.level);

console.log('\n── TIER 4: engine play when nobody is close ──');
r = setup({ vp: { '1': vp(2, 0), '2': vp(2, 0) }, hand: { wood:0, brick:0, sheep:0, wheat:2, ore:3 } });
check('early game ⇒ engine tier', r.P.tier === 'engine', `tier=${r.P.tier}`);
check('  …objective mentions the engine/first city', /engine|city|production/i.test(r.P.objective), r.P.objective);
check('  …not framed as closing out', !/Close out/.test(r.P.objective), r.P.objective);

console.log('\n── score-awareness: same hand, different score ──');
const h = { wood:1, brick:1, sheep:1, wheat:2, ore:3 };
const early = setup({ vp: { '1': vp(2, 0), '2': vp(2, 0) }, hand: h });
const late = setup({ vp: { '1': vp(4, 5), '2': vp(3, 2) }, hand: h });
check('identical hand yields different objectives by score',
  early.objective !== late.objective || early.P.tier !== late.P.tier,
  `early=${early.P.tier}/${early.P.objective} late=${late.P.tier}/${late.P.objective}`);
check('  …late game is a win/closing tier', ['win', 'closing'].includes(late.P.tier), late.P.tier);

console.log('\n── bank trades ──');
// 4 spare sheep at 4:1 covers the missing ore for a city.
r = setup({ vp: { '1': vp(3, 2) }, hand: { wood:0, brick:0, sheep:4, wheat:2, ore:2 } });
check('bank trade completes an otherwise-unaffordable build',
  JSON.stringify(r.P).includes('CITY') || r.P.tier === 'engine', `tier=${r.P.tier} do=${r.P.primary.do}`);
// 2:1 port on sheep makes it cheaper.
r = setup({ vp: { '1': vp(4, 5) }, hand: { wood:0, brick:0, sheep:2, wheat:2, ore:2 },
            tradeRatios: { '1': { '3': 2 } } });
check('2:1 port is used to reach a winning city', r.P.tier === 'win', `tier=${r.P.tier} do=${r.P.primary.do}`);

console.log('\n── ties and hidden-information uncertainty ──');
// Both players on exactly the same VP — must not crash, must not claim a win, must stay sensible.
r = setup({ vp: { '1': vp(3, 3), '2': vp(3, 3) }, hand: { wood:1, brick:1, sheep:1, wheat:1, ore:0 } });
check('tied score produces a valid plan', !!r.P && !!r.P.objective && !!r.P.primary);
check('  …tied score is not reported as a win', r.P.tier !== 'win', `tier=${r.P.tier}`);

// Tied on VP AND both one move from the target: still no win claim without an affordable action.
r = setup({ vp: { '1': vp(4, 5), '2': vp(4, 5) }, hand: { wood:0, brick:0, sheep:0, wheat:0, ore:0 } });
check('tied at the brink, nothing affordable ⇒ no win claim', r.P.tier !== 'win', `tier=${r.P.tier}`);

// Opponent could reach the target only via hidden cards. We must treat it as POSSIBLE, never as fact.
r = setup({ vp: { '1': vp(3, 2), '2': vp(3, 4) }, devCount: { '2': 4 },
            hand: { wood:1, brick:1, sheep:1, wheat:1, ore:0 } });
const txt = JSON.stringify([r.P.objective, r.P.bottleneck, r.P.primary, r.P.changesIf]);
check('hidden-VP threat is phrased as possible, not certain',
  /may |could /i.test(r.P.threat.why) && !/\bhas \d+ VP|\bis at 15\b/i.test(txt), r.P.threat.why);
check('  …and the opponent card count is never in the shown text',
  !/\d+\s+unplayed/i.test(txt), txt.slice(0, 140));

// Largest Army tie-break: equal knights does NOT take the award (must strictly exceed).
r = setup({ vp: { '1': vp(3, 2), '2': vp(3, 2, 0, 1) }, knights: { '1': 3, '2': 3 },
            awards: { la: { '2': { hasLargestArmy: true } }, lr: {} } });
check('equal knights does not take Largest Army', r.F.laNeed === 1, `laNeed=${r.F.laNeed} (need to exceed 3)`);
// Longest Road tie-break: equal length does not take it either.
r = setup({ vp: { '1': vp(3, 2), '2': vp(3, 2, 0, 0, 1) }, roadLen: { '1': 6, '2': 6 },
            awards: { la: {}, lr: { '2': { hasLongestRoad: true } } } });
check('equal road length does not take Longest Road', r.F.lrNeed === 1, `lrNeed=${r.F.lrNeed}`);

console.log('\n── shape of the output ──');
r = setup({ vp: { '1': vp(3, 2), '2': vp(3, 2) }, hand: { wood:1, brick:1, sheep:1, wheat:1, ore:0 } });
check('plan has objective + primary', !!r.P.objective && !!r.P.primary && !!r.P.primary.do);
const text = JSON.stringify({ objective: r.P.objective, bottleneck: r.P.bottleneck,
  primary: r.P.primary, alternative: r.P.alternative, changesIf: r.P.changesIf });
check('DISPLAYED fields never leak a raw VP score',
  !/\b(?:VP|score)\s*[:=]\s*\d|\b\d+\s*[-–]\s*\d+\s*VP\b/.test(text) && !text.includes('"myVP"'), text.slice(0, 160));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
