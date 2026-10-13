#!/usr/bin/env python3
"""Part 4 — signals beyond win rate, on the fresh 165-game corpus.

EXPLORATORY. Many hypotheses are tested on n<=86 decided games with no multiple-comparison
correction, so individual p-values are not evidence of anything on their own. Read the effect
directions and the paired/within-game comparisons; ignore the decimals.

    python3 tools/research.py
"""
import json, os, glob, math, statistics as st
from collections import Counter, defaultdict

ROOT = os.path.expanduser('~/Downloads/Catan saved games/Games after v.156')
REC = {os.path.basename(p)[5:-5]: json.load(open(p)) for p in sorted(glob.glob(ROOT + '/game-*.json'))}
TL = {t['gameId']: t for t in json.load(open(os.path.join(os.path.dirname(__file__), 'timeline_cache.json')))}
RES = ['wood', 'brick', 'sheep', 'wheat', 'ore']

def H(s): print('\n' + '=' * 78 + '\n' + s + '\n' + '=' * 78)

def sign_test(a_wins, b_wins):
    n = a_wins + b_wins
    if n == 0: return 1.0
    k = min(a_wins, b_wins)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n * 2
    return min(p, 1.0)

def pearson(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pairs) < 3: return None, 0
    xs, ys = zip(*pairs)
    mx, my = st.mean(xs), st.mean(ys)
    num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    dx = math.sqrt(sum((a - mx) ** 2 for a in xs)); dy = math.sqrt(sum((b - my) ** 2 for b in ys))
    return (num / (dx * dy) if dx and dy else None), len(pairs)

def fmt_r(r, n):
    return f'r={r:+.2f} (n={n})' if r is not None else f'n/a (n={n})'

def stats_line(label, v):
    if not v: return f'  {label:<34} (no data)'
    return (f'  {label:<34} n={len(v):<4} mean={st.mean(v):7.2f}  median={st.median(v):7.2f}'
            f'  IQR=[{st.quantiles(v, n=4)[0]:.1f},{st.quantiles(v, n=4)[2]:.1f}]' if len(v) >= 4
            else f'  {label:<34} n={len(v):<4} mean={st.mean(v):7.2f}  median={st.median(v):7.2f}')

DEC = {g: r for g, r in REC.items() if r.get('decided')}
CON = {g: r for g, r in REC.items() if not r.get('decided')}

def mine(g, path, who='me'):
    col = g.get('myColor') if who == 'me' else g.get('oppColor')
    eg = g.get('endGame') or {}
    return ((eg.get(path) or {}).get(col) or {})

# ─────────────────────────────────────────────────────────────────────────────
H('R1. SELECTED-PICK RANK / REGRET, stratified by seat and pick number')
print('  "regret" = score gap between the advisor\'s best candidate and the corner actually taken,')
print('  measured under the scorer the player was SHOWN (v1.50 / ee784b36 for all 165).\n')
cells = defaultdict(list)
for gid, g in REC.items():
    seat = 'P1' if g.get('amFirst') else 'P2'
    for i, o in enumerate(g.get('opening') or []):
        r = o.get('regret'); rk = o.get('rank')
        if isinstance(r, (int, float)):
            cells[(seat, i + 1)].append((r, rk, bool(g.get('decided')), bool(g.get('iWon'))))
print(f"  {'seat/pick':<12}{'n':>5}{'mean regret':>13}{'median':>9}{'rank=1 share':>14}")
for k in sorted(cells):
    v = cells[k]; rs = [x[0] for x in v]; r1 = sum(1 for x in v if x[1] == 1)
    print(f'  {k[0]+" pick "+str(k[1]):<12}{len(v):>5}{st.mean(rs):>13.2f}{st.median(rs):>9.2f}{100*r1/len(v):>13.0f}%')

print('\n  Within DECIDED games only — mean regret by outcome, per seat/pick cell:')
print(f"  {'seat/pick':<12}{'win n':>7}{'win mean':>10}{'loss n':>8}{'loss mean':>11}{'direction':>12}")
for k in sorted(cells):
    v = [x for x in cells[k] if x[2]]
    w = [x[0] for x in v if x[3]]; l = [x[0] for x in v if not x[3]]
    if not w or not l: continue
    d = 'winners worse' if st.mean(w) > st.mean(l) else 'winners better'
    print(f'  {k[0]+" pick "+str(k[1]):<12}{len(w):>7}{st.mean(w):>10.2f}{len(l):>8}{st.mean(l):>11.2f}{d:>12}')

# ─────────────────────────────────────────────────────────────────────────────
H('R2. OPENING RESOURCE ACCESS → ACTUAL RESOURCE REALIZATION')
print('  Does the opening the advisor scored actually deliver the income it implies?\n')
pips_tot, realized, lucks = [], [], []
for gid, g in REC.items():
    os_ = g.get('openingState') or {}
    rp = os_.get('resourcePips') or {}
    tot = sum(v for v in rp.values() if isinstance(v, (int, float)))
    rs = mine(g, 'resourceStats')
    roll_inc = rs.get('rollingIncome')
    if tot and roll_inc is not None:
        pips_tot.append(tot); realized.append(roll_inc); lucks.append(g.get('luckMe'))
r, n = pearson(pips_tot, realized)
print(f'  total opening pips  vs  rolling income        {fmt_r(r, n)}')
# normalise by game length
lens = []
for gid, g in REC.items():
    os_ = g.get('openingState') or {}
    rp = os_.get('resourcePips') or {}
    tot = sum(v for v in rp.values() if isinstance(v, (int, float)))
    rs = mine(g, 'resourceStats'); ri = rs.get('rollingIncome'); rolls = g.get('rolls')
    if tot and ri is not None and rolls:
        lens.append((tot, ri / rolls))
r2, n2 = pearson([x[0] for x in lens], [x[1] for x in lens])
print(f'  total opening pips  vs  income PER ROLL       {fmt_r(r2, n2)}   <- length-controlled')
r3, n3 = pearson(pips_tot, lucks)
print(f'  total opening pips  vs  dice luck %%            {fmt_r(r3, n3)}   <- should be ~0')

print('\n  Per-resource: opening pips in resource X vs rolling income (length-controlled proxy)')
for res in RES:
    xs, ys = [], []
    for gid, g in REC.items():
        rp = (g.get('openingState') or {}).get('resourcePips') or {}
        rs = mine(g, 'resourceStats'); ri = rs.get('rollingIncome'); rolls = g.get('rolls')
        if res in rp and ri is not None and rolls:
            xs.append(rp[res]); ys.append(ri / rolls)
    r, n = pearson(xs, ys)
    print(f'     {res:<7} {fmt_r(r, n)}')

# ─────────────────────────────────────────────────────────────────────────────
H('R3. ENGINE CLASS → INTERMEDIATE PROGRESSION (not win/loss)')
print('  The gate claims wheat+ore access drives the engine. Test it on CITY TIMING, which has')
print('  far more signal per game than a binary outcome.\n')
byc = defaultdict(list)
for gid, g in REC.items():
    ec = (g.get('openingState') or {}).get('engineClass')
    t = TL.get(gid)
    if not ec or not t: continue
    fc = t['firstCity'].get(t['myColor'])
    byc[ec].append((fc, g))
print(f"  {'class':<10}{'games':>7}{'built a city':>14}{'median 1st-city roll':>22}{'median total cities':>21}")
for ec in ('STRONG', 'WEAK', 'FRAGILE', 'MISSING'):
    v = byc.get(ec) or []
    if not v: continue
    got = [x for x in v if x[0] is not None]
    rolls_ = []
    cities = []
    for fc, g in v:
        t = TL[g['gameId']]
        if t['firstCityRoll'].get(t['myColor']) is not None: rolls_.append(t['firstCityRoll'][t['myColor']])
        cities.append((t['buildCounts'].get(t['myColor']) or {}).get('city', 0))
    print(f'  {ec:<10}{len(v):>7}{f"{len(got)}/{len(v)}":>14}'
          f'{(st.median(rolls_) if rolls_ else float("nan")):>22.1f}{st.median(cities):>21.1f}')

# ─────────────────────────────────────────────────────────────────────────────
H('R4. FIRST-CITY TIMING → DOWNSTREAM ENGINE (within decided games)')
rows = []
for gid, g in DEC.items():
    t = TL.get(gid)
    if not t: continue
    fc = t['firstCityRoll'].get(t['myColor'])
    if fc is None: continue
    bc = t['buildCounts'].get(t['myColor']) or {}
    ac = mine(g, 'activityStats')
    rows.append((fc, bc.get('city', 0), ac.get('devCardsBought'), ac.get('devCardsUsed'),
                 mine(g, 'resourceStats').get('totalResourceIncome'), bool(g.get('iWon')), g.get('rolls')))
for lab, idx in (('total cities', 1), ('dev cards bought', 2), ('dev cards used', 3), ('total income', 4)):
    r, n = pearson([x[0] for x in rows], [x[idx] for x in rows])
    print(f'  first-city roll  vs  {lab:<20} {fmt_r(r, n)}')
r, n = pearson([x[0] for x in rows], [x[6] for x in rows])
print(f'  first-city roll  vs  {"game length (rolls)":<20} {fmt_r(r, n)}   <- confounder: longer games allow later cities')
print('\n  Split at the median first-city roll:')
med = st.median([x[0] for x in rows])
early = [x for x in rows if x[0] <= med]; late = [x for x in rows if x[0] > med]
for lab, v in (('early city', early), ('late city', late)):
    print(f'     {lab:<12} n={len(v):<4} win rate={100*sum(1 for x in v if x[5])/len(v):5.1f}%'
          f'  median cities={st.median([x[1] for x in v]):.1f}'
          f'  median length={st.median([x[6] for x in v]):.0f} rolls')

# ─────────────────────────────────────────────────────────────────────────────
H('R5. ROBBER PRESSURE — blocked income (PAIRED, within-game)')
print('  Paired within-game comparison removes game-length and board confounding.\n')
me_b, op_b, meh = [], [], 0
for gid, g in DEC.items():
    a = mine(g, 'activityStats').get('resourceIncomeBlocked')
    b = mine(g, 'activityStats', 'opp').get('resourceIncomeBlocked')
    if a is None or b is None: continue
    me_b.append(a); op_b.append(b)
    if a > b: meh += 1
print(f'  my blocked income     mean={st.mean(me_b):.2f}  median={st.median(me_b):.1f}')
print(f'  opp blocked income    mean={st.mean(op_b):.2f}  median={st.median(op_b):.1f}')
print(f'  I was blocked MORE than opponent in {meh}/{len(me_b)} decided games')
wins = [(a, b) for (a, b), g in zip(zip(me_b, op_b), DEC.values()) if g.get('iWon')]
loss = [(a, b) for (a, b), g in zip(zip(me_b, op_b), DEC.values()) if not g.get('iWon')]
print(f'  in WINS   my blocked={st.mean([x[0] for x in wins]):.2f} vs opp={st.mean([x[1] for x in wins]):.2f}')
print(f'  in LOSSES my blocked={st.mean([x[0] for x in loss]):.2f} vs opp={st.mean([x[1] for x in loss]):.2f}')

# ─────────────────────────────────────────────────────────────────────────────
H('R6. DEV CARDS AND AWARDS')
rows = []
for gid, g in DEC.items():
    ac = mine(g, 'activityStats'); ao = mine(g, 'activityStats', 'opp')
    aw = g.get('awards') or {}
    rows.append((ac.get('devCardsBought'), ac.get('devCardsUsed'), ao.get('devCardsBought'),
                 bool(aw.get('laMe')), bool(aw.get('lrMe')), bool(g.get('iWon'))))
for lab, i in (('dev bought (me)', 0), ('dev used (me)', 1)):
    w = [r[i] for r in rows if r[5] and r[i] is not None]; l = [r[i] for r in rows if not r[5] and r[i] is not None]
    print(f'  {lab:<20} wins mean={st.mean(w):5.2f} (n={len(w)})   losses mean={st.mean(l):5.2f} (n={len(l)})')
print()
for lab, i in (('largest army', 3), ('longest road', 4)):
    held = [r for r in rows if r[i]]
    wr = 100 * sum(1 for r in held if r[5]) / len(held) if held else 0
    nh = [r for r in rows if not r[i]]
    wrn = 100 * sum(1 for r in nh if r[5]) / len(nh) if nh else 0
    print(f'  held {lab:<16} n={len(held):<4} win rate={wr:5.1f}%   |  not held n={len(nh):<4} win rate={wrn:5.1f}%')
pdiff = sum(1 for r in rows if r[0] is not None and r[2] is not None and r[0] > r[2])
tot = sum(1 for r in rows if r[0] is not None and r[2] is not None)
print(f'\n  I bought MORE dev cards than opponent in {pdiff}/{tot} decided games')

# ─────────────────────────────────────────────────────────────────────────────
H('R7. CONCESSIONS AS A BEHAVIOUR (79 games)')
print('  Final VP position does NOT identify who quit. Reported descriptively only.\n')
pos = Counter(); lens = defaultdict(list)
for gid, g in CON.items():
    fv = g.get('finalVP') or {}
    me, op = fv.get(g.get('myColor')), fv.get(g.get('oppColor'))
    if me is None or op is None: continue
    k = 'ahead' if me > op else 'behind' if me < op else 'tied'
    pos[k] += 1; lens[k].append(g.get('rolls') or 0)
for k in ('ahead', 'behind', 'tied'):
    print(f'  {k:<8} n={pos[k]:<4} ({100*pos[k]/sum(pos.values()):4.1f}%)  median length={st.median(lens[k]):.0f} rolls')
print(f'\n  median concession length : {st.median([g.get("rolls") or 0 for g in CON.values()]):.0f} rolls')
print(f'  median decided  length   : {st.median([g.get("rolls") or 0 for g in DEC.values()]):.0f} rolls')
gap = []
for gid, g in CON.items():
    fv = g.get('finalVP') or {}
    me, op = fv.get(g.get('myColor')), fv.get(g.get('oppColor'))
    if me is not None and op is not None: gap.append(me - op)
print(f'  median VP margin at concession (me - opp): {st.median(gap):+.0f}')

# ─────────────────────────────────────────────────────────────────────────────
H('R8. WHAT THE OPENING DID *NOT* COVER — missing-resource bottleneck')
print('  Opening pips == 0 in a resource means every unit must come from trade/robber/dev.\n')
for res in RES:
    miss = [g for g in REC.values() if ((g.get('openingState') or {}).get('resourcePips') or {}).get(res, 0) == 0]
    md = [g for g in miss if g.get('decided')]
    w = sum(1 for g in md if g.get('iWon'))
    tr = [mine(g, 'resourceStats').get('tradeIncome') for g in miss]
    tr = [x for x in tr if x is not None]
    print(f'  no {res:<6} in opening: {len(miss):>3} games | decided {len(md):>3} | wins {w:>2}'
          f' | median trade income {st.median(tr) if tr else float("nan"):5.1f}')
allg = [mine(g, 'resourceStats').get('tradeIncome') for g in REC.values()]
allg = [x for x in allg if x is not None]
print(f'  {"overall":<24} {len(allg):>3} games | {"":>14} | median trade income {st.median(allg):5.1f}')

print('\n' + '=' * 78)
print('EXPLORATORY — small n, many comparisons, no correction. Directions only.')
print('=' * 78)
