// Acceptance harness for the Win-Path live state (v1.61).
//
// Feeds every preserved raw capture through the REAL live processor (`processStateObject`, the same
// code path a live game uses) one message at a time, then checks the live-tracked state against the
// type-45 end-game ground truth.
//
// This is the test that matters: it exercises the incremental path, not the offline reviewer.
//
//   node tools/winpath_check.js [n]
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');

const CORPUS = path.join(os.homedir(), 'Downloads', 'Catan saved games', 'Games after v.156');
const RAW = path.join(CORPUS, 'raw');
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;

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

const files = fs.readdirSync(RAW).filter(f => f.startsWith('game-')).sort().slice(0, LIMIT);
let myVPok = 0, oppOk = 0, n = 0;
let laOk = 0, lrOk = 0, awardSlots = 0, doubleLA = 0, doubleLR = 0, cityNet = 0, cityTot = 0;
const fails = [];

for (const f of files) {
  const gid = f.replace(/^game-|\.json$/g, '');
  const raw = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
  const msgs = raw.messages || [];
  sandbox.__msgs = msgs;
  // Drive the REAL live path: softReset, then ingest each message in order exactly as the panel does.
  const out = run(`(function(){
    softReset();
    state.gameActive = false; state.gameId = null;
    var endGame = null, maxLA = 0, maxLR = 0;
    for (var i = 0; i < __msgs.length; i++) {
      var m = __msgs[i];
      var dec = m.dec !== undefined ? m.dec : m.data;
      var p = payloadOf(dec);
      if (!p) continue;
      if (p.endGameState || p.rankedUserStates) { endGame = p.endGameState || {}; break; }
      if (p.playerColor != null) { state.myColor = String(p.playerColor); noteColor(state.myColor); }
      if (p.gameState && p.gameState.mapState && !state.board) { /* board not needed here */ }
      var g = p.gameState || p.diff;
      if (!g || typeof g !== 'object') continue;
      try { processStateObject(g); } catch (e) { return { error: String(e) }; }
      var la = 0, lr = 0;
      for (var c in state.awards.la) if (state.awards.la[c] && state.awards.la[c].hasLargestArmy) la++;
      for (var c2 in state.awards.lr) if (state.awards.lr[c2] && state.awards.lr[c2].hasLongestRoad) lr++;
      if (la > maxLA) maxLA = la;
      if (lr > maxLR) maxLR = lr;
    }
    state.oppColor = state.colors.filter(function(c){ return c !== state.myColor; })[0] || null;
    // Pieces on the board, per colour, as the LIVE state believes them to be.
    var pieces = {};
    for (var cid in state.cornerOwner) {
      var cv = state.cornerOwner[cid], col = String(cv.owner);
      pieces[col] = pieces[col] || { setts: 0, cities: 0 };
      if (cv.buildingType === 2) pieces[col].cities++; else pieces[col].setts++;
    }
    return { endGame: endGame, vp: state.vp, awards: state.awards, myColor: state.myColor,
             oppColor: state.oppColor, devCount: state.devCount, knights: state.knights,
             roadLen: state.roadLen, maxLA: maxLA, maxLR: maxLR, pieces: pieces };
  })()`);

  if (!out || out.error) { fails.push([gid, 'threw: ' + (out && out.error)]); continue; }
  const eg = out.endGame;
  if (!eg || !eg.players) { fails.push([gid, 'no end-game frame']); continue; }
  n++;
  if (out.maxLA > 1) doubleLA++;
  if (out.maxLR > 1) doubleLR++;

  const PTS = { 0: 1, 1: 2, 2: 1, 3: 2, 4: 2 };
  const sum = o => Object.entries(o || {}).reduce((a, [k, v]) => a + (PTS[k] || 0) * (v || 0), 0);

  for (const [col, pd] of Object.entries(eg.players)) {
    const truthCats = pd.victoryPoints || {};
    const truth = sum(truthCats);
    const live = sum(out.vp[String(col)] || {});
    const isMine = String(col) === String(out.myColor);
    if (isMine) {
      if (live === truth) myVPok++;
      else fails.push([gid, `MY VP live=${live} truth=${truth}`]);
    } else {
      // Opponent: live must equal truth MINUS their hidden VP cards (category 2) — exactly.
      const hidden = truthCats['2'] || 0;
      if (live === truth - hidden) oppOk++;
      else fails.push([gid, `OPP VP live=${live} truth=${truth} hidden=${hidden}`]);
    }
    // Awards, with the CORRECTED mapping: cat 3 = Largest Army, cat 4 = Longest Road.
    awardSlots++;
    const truthLA = !!(truthCats['3'] || 0), truthLR = !!(truthCats['4'] || 0);
    const liveLA = !!((out.awards.la[String(col)] || {}).hasLargestArmy);
    const liveLR = !!((out.awards.lr[String(col)] || {}).hasLongestRoad);
    if (liveLA === truthLA) laOk++; else fails.push([gid, `LA live=${liveLA} truth=${truthLA} col=${col}`]);
    if (liveLR === truthLR) lrOk++; else fails.push([gid, `LR live=${liveLR} truth=${truthLR} col=${col}`]);
    // PIECE TRACKING. The settlement→city upgrade diff omits `owner` (it didn't change), so a
    // handler that requires an owner drops every upgrade — live cities read 0 in 52/60 games
    // before v1.62. Assert the live board matches the end-game piece counts exactly.
    cityTot++;
    const truthSetts = truthCats['0'] || 0, truthCities = truthCats['1'] || 0;
    const p = out.pieces[String(col)] || { setts: 0, cities: 0 };
    if (p.cities === truthCities && p.setts === truthSetts) cityNet++;
    else fails.push([gid, `pieces col=${col} live ${p.setts}s/${p.cities}c vs truth ${truthSetts}s/${truthCities}c`]);
  }
}

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';
console.log(`\nDrove ${n} captures through the LIVE processor (processStateObject)\n`);
console.log(`  MY VP          == end-game truth                : ${myVPok}/${n}  (${pct(myVPok, n)})`);
console.log(`  OPPONENT VP    == truth − their hidden VP cards : ${oppOk}/${n}  (${pct(oppOk, n)})`);
console.log(`  Largest Army   == truth (cat 3)                 : ${laOk}/${awardSlots}`);
console.log(`  Longest Road   == truth (cat 4)                 : ${lrOk}/${awardSlots}`);
console.log(`  games ever showing 2 simultaneous LA holders    : ${doubleLA}`);
console.log(`  games ever showing 2 simultaneous LR holders    : ${doubleLR}`);
console.log(`  settlements+cities on board == truth           : ${cityNet}/${cityTot}  (city-upgrade diff)`);
if (fails.length) {
  console.log(`\n  ${fails.length} FAILURES (first 25):`);
  for (const f of fails.slice(0, 25)) console.log('   ', f[0], f[1]);
} else {
  console.log('\n  no failures');
}
process.exit(fails.length ? 1 : 0);
