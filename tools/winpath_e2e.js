// End-to-end integration test: drive REAL captures through the REAL live processor, and call the
// Win-Path advisor at many points during each game with the REAL board geometry.
//
// The synthetic logic tests use a fake board; this one exercises scoreCorner / bestCityTarget /
// reachableSettleNow / bestExpansion / payFor against genuine game state. It asserts the advisor
// never throws, always produces an objective and an action, and never prints a score.
//
//   node tools/winpath_e2e.js [n_games]
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');

const CORPUS = path.join(os.homedir(), 'Downloads', 'Catan saved games', 'Games after v.156');
const RAW = path.join(CORPUS, 'raw');
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : 40;
const SRC = path.join(__dirname, '..', 'sidepanel', 'sidepanel.js');

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
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'sidepanel.js' });

const files = fs.readdirSync(RAW).filter(f => f.startsWith('game-')).sort().slice(0, LIMIT);
let games = 0, calls = 0, errors = 0, noObjective = 0, noAction = 0, leaks = 0, staleCity = 0;
const staleSamples = [];
const tiers = {};
const samples = [];
const leakSamples = [];
const errSamples = [];

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
  sandbox.__msgs = raw.messages || [];
  sandbox.__gid = f.replace(/^game-|\.json$/g, '');
  const out = vm.runInContext(`(function(){
    softReset();
    var results = [], errs = [], n = 0;
    state.gameActive = false;
    for (var i = 0; i < __msgs.length; i++) {
      var m = __msgs[i];
      var dec = m.dec !== undefined ? m.dec : m.data;
      var p = payloadOf(dec);
      if (!p) continue;
      if (p.endGameState || p.rankedUserStates) break;
      if (p.playerColor != null) { state.myColor = String(p.playerColor); noteColor(state.myColor); }
      if (p.gameSettings && typeof p.gameSettings.victoryPointsToWin === 'number') state.vpToWin = p.gameSettings.victoryPointsToWin;
      var g = p.gameState || p.diff;
      if (!g || typeof g !== 'object') continue;
      // Use the LIVE board builder (buildBoardGeo), not the offline reviewer's reviewGeo — only
      // the former produces the adjacency/neighbour maps the advisor's reach logic needs.
      if (g.mapState && !state.board) {
        try {
          state.board = { geo: buildBoardGeo(g.mapState),
                          ports: g.mapState.portEdgeStates ? Object.values(g.mapState.portEdgeStates) : [] };
        } catch (e) { errs.push('buildBoardGeo: ' + e.message); }
      }
      try { processStateObject(g); } catch (e) { errs.push('processStateObject: ' + e.message); continue; }
      state.oppColor = state.colors.filter(function(c){ return c !== state.myColor; })[0] || null;
      // Ask the advisor roughly every 25 messages, pretending it is my turn.
      if (i % 25 !== 0) continue;
      var savedTurn = state.currentTurnColor;
      state.currentTurnColor = state.myColor;
      try {
        var a = computeTurnCoach();
        if (a.active && a.plan) {
          n++;
          var myCities = 0;
          for (var cid in state.cornerOwner) {
            var cv2 = state.cornerOwner[cid];
            if (String(cv2.owner) === state.myColor && cv2.buildingType === 2) myCities++;
          }
          results.push({ myCities: myCities, tier: a.plan.tier, objective: a.plan.objective,
                         bottleneck: a.plan.bottleneck,
                         doNext: a.plan.primary && a.plan.primary.do,
                         why: a.plan.primary && a.plan.primary.why,
                         alt: a.plan.alternative && a.plan.alternative.do,
                         changesIf: a.plan.changesIf,
                         myVP: a.facts.myVP, oppVis: a.facts.oppVisible });
        }
      } catch (e) { errs.push('computeTurnCoach: ' + e.message); }
      state.currentTurnColor = savedTurn;
    }
    return { results: results, errs: errs };
  })()`, sandbox);

  games++;
  errors += out.errs.length;
  for (const e of out.errs) if (errSamples.length < 10) errSamples.push([sandbox.__gid, e]);
  for (const r of out.results) {
    calls++;
    tiers[r.tier] = (tiers[r.tier] || 0) + 1;
    if (!r.objective) noObjective++;
    if (!r.doNext) noAction++;
    // Regression guard for the city-upgrade diff trap: once a city is on the board, the advisor
    // must never still be coaching "toward your first city".
    if (r.myCities > 0 && /first city/i.test(r.objective)) {
      staleCity++;
      if (staleSamples.length < 5) staleSamples.push([sandbox.__gid, `${r.myCities} cities but: "${r.objective}"`]);
    }
    // Nothing DISPLAYED may restate the scoreboard. Banned: either player's VP total, the
    // opponent's hidden-VP estimate, their unplayed dev-card count.
    // Allowed: VP DELTAS ("+2 VP"), the goal distance ("2 VP to go" — an objective, not a score),
    // the win target itself, hand size vs the discard limit, and MY OWN knight/road counts.
    const shown = [r.objective, r.bottleneck, r.doNext, r.why, r.alt, r.changesIf].filter(Boolean).join(' | ');
    // Remove the legitimate numeric forms first, so the ban list can be simple and strict:
    //   "+2 VP"      a gain from an action        "3 VP to go"  distance to the objective
    //   "reaches 15" the win target itself
    const probe = shown
      .replace(/[+-]\s*\d+\s*VP/gi, ' <delta> ')
      .replace(/\b\d+\s*VP\s*(?:to go|to win)\b/gi, ' <goal> ')
      .replace(/\breaches\s+\d+\b/gi, ' <target> ');
    const banned = [
      /\bopponent\b[^.|]*\b(?:is|at|on|has)\s+\d+\b/i,          // "opponent is at 12"
      /\b\d+\s+unplayed\b/i,                                     // their unplayed dev-card count
      /\bhidden\b[^.|]*\b\d+\b/i,                                // any numeric hidden-VP estimate
      new RegExp(`\\byou(?:'re| are)\\s+(?:on|at)\\s+${r.myVP}\\b`, 'i'),   // my VP total
      new RegExp(`\\b${r.myVP}\\s*VP\\b`, 'i'),                             // "13 VP" as a standing
    ];
    if (r.oppVis > 0) banned.push(new RegExp(`\\bopponent\\b[^.|]*\\b${r.oppVis}\\s*VP\\b`, 'i'));
    const hit = banned.find(re => re.test(probe));
    if (hit) {
      leaks++;
      if (leakSamples.length < 8) leakSamples.push([sandbox.__gid, String(hit), shown]);
    }
    if (samples.length < 6 && (r.tier === 'win' || r.tier === 'defend')) samples.push([r.tier, sandbox.__gid, shown]);
  }
}

console.log(`\nDrove ${games} real captures; called the advisor ${calls} times with real board geometry\n`);
console.log(`  exceptions thrown                     : ${errors}`);
console.log(`  advice with no OBJECTIVE              : ${noObjective}`);
console.log(`  advice with no DO NEXT                : ${noAction}`);
console.log(`  advice leaking a raw score to the UI  : ${leaks}`);
console.log(`  "first city" shown when a city exists : ${staleCity}`);
console.log(`\n  tier distribution: ${JSON.stringify(tiers)}`);
if (errSamples.length) { console.log('\n  errors:'); for (const e of errSamples) console.log('   ', e[0], e[1]); }
if (staleSamples.length) {
  console.log('\n  STALE OBJECTIVE:');
  for (const s2 of staleSamples) console.log('   ', s2[0], s2[1]);
}
if (leakSamples.length) {
  console.log('\n  LEAKS:');
  for (const l of leakSamples) console.log(`    ${l[0]}  matched ${l[1]}\n      ${l[2].slice(0, 200)}`);
}
if (samples.length) {
  console.log('\n  sample advice:');
  for (const s of samples) console.log(`    [${s[0]}] ${s[2].slice(0, 180)}`);
}
const bad = errors + noObjective + noAction + leaks + staleCity;
console.log(bad ? `\nFAILED (${bad} problems)\n` : '\nall checks passed\n');
process.exit(bad ? 1 : 0);
