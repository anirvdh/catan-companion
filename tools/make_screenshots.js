// Build a self-contained demo page that renders the REAL side panel with a realistic game state,
// so documentation screenshots show actual component output rather than a mockup.
//
// It takes sidepanel/index.html verbatim (same markup, same CSS), stubs the chrome.* APIs that only
// exist inside an extension, loads the real sidepanel.js, injects a mid-game state, and calls the
// real render functions. Anything that looks wrong in the output is wrong in the extension.
//
//   node tools/make_screenshots.js          -> writes docs/demo.html
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'sidepanel', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'sidepanel', 'sidepanel.js'), 'utf8');
const fontDir = path.join(ROOT, 'sidepanel', 'fonts');

// Inline the fonts so the page renders identically from any directory.
let css = html;
for (const f of fs.readdirSync(fontDir)) {
  const b64 = fs.readFileSync(path.join(fontDir, f)).toString('base64');
  css = css.split(`fonts/${f}`).join(`data:font/woff2;base64,${b64}`);
}

const STUB = `<script>
// ── Minimal chrome.* stub: the panel only needs these to not throw at load. ──
window.chrome = {
  runtime: { sendMessage: function(){}, lastError: null,
    onMessage: { addListener: function(){} },
    connect: function(){ return { postMessage: function(){}, disconnect: function(){},
      onMessage: { addListener: function(){} }, onDisconnect: { addListener: function(){} } }; } },
  storage: { local: { get: function(k, cb){ cb && cb({}); }, set: function(o, cb){ cb && cb(); } },
             onChanged: { addListener: function(){} } },
  tabs: { query: function(q, cb){ cb && cb([]); }, sendMessage: function(){} },
  downloads: { download: function(){} },
};
<\/script>`;

const SCENE = `<script>
// ── A realistic mid-game position, built through the REAL state helpers. ──
// Board: a plausible 19-hex layout. Position: 4 settlements + 2 cities, 10 VP, opponent on 9
// visible with 2 unplayed dev cards, I hold 2 knights and Largest Army is one knight away.
(function(){
  // A legal standard board: 4 wood, 3 brick, 4 sheep, 4 wheat, 3 ore, 1 desert = 19 hexes,
  // carrying the standard 18 number tokens (2,12 once; 3-6 and 8-11 twice each; no 7).
  var HEXES = [
    ['ore',10],['sheep',2],['wood',9],['wheat',12],['brick',6],['sheep',4],['wood',10],
    ['desert',0],['wood',11],['wheat',3],['brick',8],['sheep',8],['wheat',3],['ore',4],
    ['sheep',5],['brick',5],['wheat',6],['wood',11],['ore',9]
  ];
  var TYPE = { desert:0, wood:1, brick:2, sheep:3, wheat:4, ore:5 };   // matches HEX_RES exactly
  // Axial coordinates for a standard 19-hex Catan board.
  var COORDS = [[0,-2],[1,-2],[2,-2],[-1,-1],[0,-1],[1,-1],[2,-1],[-2,0],[-1,0],[0,0],
                [1,0],[2,0],[-2,1],[-1,1],[0,1],[1,1],[-2,2],[-1,2],[0,2]];
  var tileHexStates = {};
  HEXES.forEach(function(h, i){
    tileHexStates[String(i)] = { x: COORDS[i][0], y: COORDS[i][1],
                                 type: TYPE[h[0]], diceNumber: h[1] };
  });
  // Corners: every (hex, z) slot the geometry builder expects.
  var tileCornerStates = {};
  var cid = 0;
  COORDS.forEach(function(c){
    [0,1].forEach(function(z){
      tileCornerStates[String(cid++)] = { x: c[0], y: c[1], z: z, owner: null, buildingType: null };
    });
  });
  var mapState = { tileHexStates: tileHexStates, tileCornerStates: tileCornerStates,
                   tileEdgeStates: {}, portEdgeStates: {} };

  state.gameActive = true; state.connected = true;
  state.myColor = '1'; state.oppColor = '2'; state.colors = ['1','2'];
  state.vpToWin = 15; state.discardLimit = 10; state.currentTurnColor = '1';
  state.playOrder = ['1','2'];
  noteColor('1'); noteColor('2');
  try { state.board = { geo: buildBoardGeo(mapState), ports: [] }; } catch(e) { console.warn(e); }

  // Put my pieces on real corners that actually touch good numbers.
  var ids = Object.keys(state.board.geo.corners);
  function pick(n){ return ids[n % ids.length]; }
  state.cornerOwner = {};
  state.cornerOwner[pick(3)]  = { owner:'1', buildingType:2 };   // city
  state.cornerOwner[pick(9)]  = { owner:'1', buildingType:2 };   // city
  state.cornerOwner[pick(14)] = { owner:'1', buildingType:1 };
  state.cornerOwner[pick(21)] = { owner:'1', buildingType:1 };
  state.cornerOwner[pick(27)] = { owner:'2', buildingType:2 };
  state.cornerOwner[pick(33)] = { owner:'2', buildingType:1 };

  // Score: me 10 VP (2 setts + 2 cities + 2 VP cards), opponent 9 visible.
  state.vp = { '1': { '0':2, '1':2, '2':2 }, '2': { '0':3, '1':3 } };
  state.awards = { la: {}, lr: {} };
  state.roadLen = { '1': 4, '2': 3 };
  state.knights = { '1': 2, '2': 1 };
  state.myDevCards = [11, 11, 12, 12];      // 2 knights + 2 VP cards, all unplayed
  state.devCount = { '1': 4, '2': 2 };
  state.dev.bankRemaining = 11;
  state.dev.plays = [11,11,11,13];
  if (typeof recomputeDevPlayed === 'function') recomputeDevPlayed();
  state.tradeRatios = { '1': { '3': 2, '1': 4, '2': 4, '4': 4, '5': 4 } };  // 2:1 sheep port

  // My hand: one ore short of a city.
  player('1').hand = { wood:1, brick:1, sheep:3, wheat:2, ore:2 };
  player('1').known = true; player('1').total = 9;
  player('2').total = 7; player('2').known = false;
  player('2').hand = { wood:2, brick:1, sheep:1, wheat:2, ore:1 };
  player('2').uncertain = true;

  // Roll history, so the dice panels have something real to show.
  // Kept to 22 rolls (deck stays above the 13-card reshuffle threshold) with the two 7s landing on
  // DIFFERENT players. A sequence where one player rolls every 7 drives the per-player 7-balancer
  // to an extreme (0% vs 44%) — correct behaviour, but an unrepresentative screenshot.
  var ROLLS = [8,6,5,9,10,6,4,7,11,9,6,3,8,5,7,10,9,6,8,4,5,6];
  ROLLS.forEach(function(r, i){
    recordRoll(r);
    diceApplyRoll(state.dice, r, i % 2 === 0 ? '1' : '2');
  });
  state.totalRolls = ROLLS.length;
  state.sevensBy = { '1': 1, '2': 1 };
  state.robberTile = 7;

  if (typeof renderAll === 'function') renderAll();

  // ── Scene routing: ?scene=<name> isolates one section for a focused screenshot. ──
  var scene = (location.search.match(/scene=([a-z-]+)/) || [])[1] || 'full';
  function only(keep) {
    document.querySelectorAll('#panel-game > .section').forEach(function(s){
      s.style.display = keep.indexOf(s) >= 0 ? '' : 'none';
    });
    document.querySelector('header').style.display = 'none';
    document.querySelector('.tabs').style.display = 'none';
    document.querySelector('footer').style.display = 'none';
    // Pin to the real side-panel width so sections wrap exactly as they do in Chrome.
    var panel = document.getElementById('panel-game');
    panel.style.width = '400px'; panel.style.boxSizing = 'border-box';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
  }
  var byId = function(id){ var e = document.getElementById(id); return e && e.closest('.section'); };
  var diceSec = document.querySelector('#diceSwitch').closest('.section');

  if (scene === 'full') {
    // Hero shot: keep the header/tabs/footer, but still pin to the real side-panel width so
    // nothing overflows the capture.
    document.getElementById('panel-game').style.width = '400px';
    document.getElementById('panel-game').style.boxSizing = 'border-box';
    document.body.style.margin = '0';
    document.body.style.width = '400px';
    document.body.style.overflow = 'hidden';
    document.getElementById('setupAdvisor').style.display = 'none';
  }

  if (scene === 'coach')    only([byId('turnCoach') || document.getElementById('turnCoach')]);
  if (scene === 'opponent') only([byId('opponentResources')]);
  if (scene === 'odds')   { only([diceSec]); setDiceView('odds'); }
  if (scene === 'dist')   { only([diceSec]); setDiceView('dist'); }

  if (scene === 'setup') {
    // The opening advisor only runs before the first roll, so rewind to an empty board.
    state.rolls = []; state.totalRolls = 0;
    state.cornerOwner = {}; state.setupMySettles = [];
    state.currentTurnColor = '1';
    if (typeof renderSetupAdvisor === 'function') renderSetupAdvisor();
    if (typeof renderTurnCoach === 'function') renderTurnCoach();
    only([document.getElementById('setupAdvisor')]);
    document.getElementById('setupAdvisor').style.display = '';
  }
})();
<\/script>`;

let out = css.replace('<script src="sidepanel.js"></script>', STUB + '\n<script>\n' + js + '\n<\/script>\n' + SCENE);
const docs = path.join(ROOT, 'docs');
if (!fs.existsSync(docs)) fs.mkdirSync(docs);
fs.writeFileSync(path.join(docs, 'demo.html'), out);
console.log('wrote docs/demo.html (' + Math.round(out.length / 1024) + ' KB)');
