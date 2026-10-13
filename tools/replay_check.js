// Offline harness: replay every preserved raw capture through the CURRENT sidepanel.js and
// compare the freshly-derived record against the record that was saved at the time.
//
// This is the regression test for any change to reviewAnalyze / buildGameRecord: raw is immutable,
// so a replay must reproduce every field whose meaning did not intentionally change.
//
//   node tools/replay_check.js [corpusDir]
const fs = require('fs'), path = require('path'), vm = require('vm');
const os = require('os');

const CORPUS = process.argv[2] || path.join(os.homedir(), 'Downloads', 'Catan saved games', 'Games after v.156');
const RAW = path.join(CORPUS, 'raw');

const src = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'sidepanel.js'), 'utf8');

// sidepanel.js is a browser script: stub the DOM/chrome surface it touches at load time.
const el = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'style' || k === 'classList' || k === 'dataset') ? el()
    : k === 'value' || k === 'textContent' || k === 'innerHTML' ? ''
      : k === 'children' || k === 'childNodes' ? [] : el(),
  set: () => true, apply: () => el(),
});
const sandbox = {
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, isNaN, parseInt, parseFloat,
  Set, Map, Promise, Error, RegExp, TextDecoder, Uint8Array, DataView, ArrayBuffer,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  document: { getElementById: el, querySelector: el, querySelectorAll: () => [], createElement: el,
    addEventListener: () => {}, body: el(), documentElement: el() },
  window: { addEventListener: () => {}, location: { href: '' } },
  chrome: {
    runtime: {
      sendMessage: () => {}, lastError: null,
      onMessage: { addListener: () => {} },
      connect: () => ({ postMessage: () => {}, disconnect: () => {},
        onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } }),
    },
    storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
      onChanged: { addListener: () => {} } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => {} },
  },
};
sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox, { filename: 'sidepanel.js' }); }
catch (e) { console.error('load failed:', e.message); process.exit(1); }

const run = (expr) => vm.runInContext(expr, sandbox);
sandbox.__raw = null;

const files = fs.readdirSync(RAW).filter(f => f.startsWith('game-') && f.endsWith('.json')).sort();
let ok = 0; const diffs = [];

for (const f of files) {
  const id = f.replace(/^game-|\.json$/g, '');
  const raw = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
  const oldRec = JSON.parse(fs.readFileSync(path.join(CORPUS, f), 'utf8'));
  const msgs = Array.isArray(raw) ? raw : (raw.messages || raw.capture || []);
  sandbox.__raw = { id, msgs };
  let rec;
  try { rec = run('(function(){ var g = { id: __raw.id, msgs: __raw.msgs }; var R = reviewAnalyze(g); return R && R.winner != null ? buildGameRecord(g, R) : null; })()'); }
  catch (e) { diffs.push([id, 'replay threw: ' + e.message]); continue; }
  if (!rec) { diffs.push([id, 'no record produced']); continue; }

  // Fields whose meaning did NOT change: must match the stored record exactly.
  const stable = ['gameId', 'winner', 'iWon', 'amFirst', 'myColor', 'oppColor', 'vpToWin',
    'turns', 'rolls', 'winnerVP', 'decided', 'conceded', 'sourceHash', 'startedAt', 'endedAt'];
  for (const k of stable) {
    const a = JSON.stringify(oldRec[k]), b = JSON.stringify(rec[k]);
    if (a !== b) diffs.push([id, `${k}: stored=${a} replay=${b}`]);
  }
  if (JSON.stringify(oldRec.finalVP) !== JSON.stringify(rec.finalVP)) diffs.push([id, 'finalVP differs']);
  // New fields: must be present and internally consistent.
  if (rec.completedTurns !== rec.turns) diffs.push([id, 'completedTurns != turns']);
  if (rec.terminalTurnNumber == null) diffs.push([id, 'terminalTurnNumber missing']);
  const mx = Math.max(...Object.values(rec.finalVP || { a: -1 }));
  if (rec.leaderVP !== mx) diffs.push([id, `leaderVP ${rec.leaderVP} != max(finalVP) ${mx}`]);
  if (rec.decided !== (mx >= rec.vpToWin)) diffs.push([id, 'decided not consistent with leaderVP rule']);
  ok++;
}

console.log(`replayed ${ok}/${files.length} captures`);
console.log(diffs.length ? `MISMATCHES (${diffs.length}):` : 'no mismatches — all stable fields reproduced');
for (const d of diffs.slice(0, 40)) console.log('  ', d[0], d[1]);
process.exit(diffs.length ? 1 : 0);
