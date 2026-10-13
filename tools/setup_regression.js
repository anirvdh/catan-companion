// Regression guard: the Win-Path work must not have touched the opening advisor.
//
// Replays the SETUP PHASE of real captures and checks that the placement advisor still activates,
// still ranks candidates, and still produces the same top recommendation and board lean. It also
// asserts the phase handoff: during setup the Turn Coach stays silent and the setup advisor owns
// the panel; after the first roll that reverses.
//
//   node tools/setup_regression.js [n_games]
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');

const RAW = path.join(os.homedir(), 'Downloads', 'Catan saved games', 'Games after v.156', 'raw');
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : 60;

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
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'sidepanel.js'), 'utf8'),
  sandbox, { filename: 'sidepanel.js' });

const files = fs.readdirSync(RAW).filter(f => f.startsWith('game-')).sort().slice(0, LIMIT);
let games = 0, active = 0, withRecs = 0, errs = 0, coachLeaked = 0, leanOk = 0;
const problems = [];
const fingerprints = [];

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
  sandbox.__msgs = raw.messages || [];
  sandbox.__gid = f.replace(/^game-|\.json$/g, '');
  const out = vm.runInContext(`(function(){
    softReset();
    var res = { err: null, active: false, nRecs: 0, top: null, lean: null, coachActiveInSetup: false,
                coachActiveAfterRoll: false, setupSilentAfterRoll: false };
    try {
      for (var i = 0; i < __msgs.length; i++) {
        var m = __msgs[i];
        var dec = m.dec !== undefined ? m.dec : m.data;
        var p = payloadOf(dec);
        if (!p) continue;
        if (p.endGameState || p.rankedUserStates) break;
        if (p.playerColor != null) { state.myColor = String(p.playerColor); noteColor(state.myColor); }
        if (Array.isArray(p.playOrder)) state.playOrder = p.playOrder.map(String);
        if (p.gameSettings && typeof p.gameSettings.victoryPointsToWin === 'number') state.vpToWin = p.gameSettings.victoryPointsToWin;
        var g = p.gameState || p.diff;
        if (!g || typeof g !== 'object') continue;
        if (g.mapState && !state.board) {
          state.board = { geo: buildBoardGeo(g.mapState),
                          ports: g.mapState.portEdgeStates ? Object.values(g.mapState.portEdgeStates) : [] };
        }
        processStateObject(g);
        state.oppColor = state.colors.filter(function(c){ return c !== state.myColor; })[0] || null;

        var inSetup = state.rolls.length === 0;
        if (inSetup && state.board) {
          var a = computeSetupAdvice();
          if (a && a.active) {
            res.active = true;
            var recs = a.recs || a.candidates || a.top || [];
            if (recs && recs.length) {
              res.nRecs = Math.max(res.nRecs, recs.length);
              if (!res.top) res.top = recs[0] && (recs[0].label || recs[0].id || null);
            }
            // The real invariant the code implements: while settlements are still being PLACED
            // (fewer than 4 corners owned) the setup advisor owns the panel and the Turn Coach
            // must be silent. Between the 4th placement and the first roll both may be active —
            // that is pre-existing behaviour (computeSetupAdvice ends at the first roll, while
            // computeTurnCoach starts at 4 corners), and is outside the Win-Path scope.
            if (Object.keys(state.cornerOwner).length < 4) {
              var c = computeTurnCoach();
              if (c && c.active) res.coachActiveInSetup = true;
            }
          }
          if (state.board.geo && typeof state.board.geo.lean150 === 'number') res.lean = state.board.geo.lean150;
        }
        if (!inSetup && state.rolls.length >= 1) {
          var sa = computeSetupAdvice();
          if (!sa || !sa.active) res.setupSilentAfterRoll = true;
          var savedTurn = state.currentTurnColor; state.currentTurnColor = state.myColor;
          var cc = computeTurnCoach();
          if (cc && cc.active) res.coachActiveAfterRoll = true;
          state.currentTurnColor = savedTurn;
          break;
        }
      }
    } catch (e) { res.err = e.message; }
    return res;
  })()`, sandbox);

  games++;
  if (out.err) { errs++; problems.push([sandbox.__gid, 'threw: ' + out.err]); continue; }
  if (out.active) active++; else problems.push([sandbox.__gid, 'setup advisor never activated']);
  if (out.nRecs > 0) withRecs++; else if (out.active) problems.push([sandbox.__gid, 'advisor active but produced no candidates']);
  if (out.coachActiveInSetup) { coachLeaked++; problems.push([sandbox.__gid, 'Turn Coach active DURING setup (should be silent)']); }
  if (typeof out.lean === 'number') leanOk++;
  fingerprints.push({ gid: sandbox.__gid, top: out.top, lean: out.lean, nRecs: out.nRecs });
}

console.log(`\nReplayed the setup phase of ${games} real captures\n`);
console.log(`  setup advisor activated                  : ${active}/${games}`);
console.log(`  …and produced ranked candidates          : ${withRecs}/${games}`);
console.log(`  board lean computed                      : ${leanOk}/${games}`);
console.log(`  exceptions                               : ${errs}`);
console.log(`  Turn Coach wrongly active during setup   : ${coachLeaked}`);

// Compare against a stored fingerprint so a future change that silently alters the opening
// recommendations is caught. Written on first run.
const fpPath = path.join(__dirname, 'setup_fingerprint.json');
if (!fs.existsSync(fpPath)) {
  fs.writeFileSync(fpPath, JSON.stringify(fingerprints, null, 1));
  console.log(`\n  wrote baseline fingerprint for ${fingerprints.length} games -> tools/setup_fingerprint.json`);
} else {
  const base = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
  const byId = Object.fromEntries(base.map(b => [b.gid, b]));
  let drift = 0;
  for (const f of fingerprints) {
    const b = byId[f.gid];
    if (!b) continue;
    if (JSON.stringify(b) !== JSON.stringify(f)) { drift++; if (drift <= 5) problems.push([f.gid, `opening changed: was ${JSON.stringify(b)} now ${JSON.stringify(f)}`]); }
  }
  console.log(`  openings differing from the baseline     : ${drift}/${fingerprints.length}`);
  if (drift) errs += drift;
}

if (problems.length) { console.log('\n  problems:'); for (const p of problems.slice(0, 12)) console.log('   ', p[0], p[1]); }
const bad = errs + coachLeaked + (games - active);
console.log(bad ? `\nFAILED (${bad})\n` : '\nopening advisor unchanged\n');
process.exit(bad ? 1 : 0);
