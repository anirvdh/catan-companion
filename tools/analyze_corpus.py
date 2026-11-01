#!/usr/bin/env python3
"""Full analysis of the fresh corpus — corpus-size agnostic, run it whenever the dataset grows.

    python3 tools/analyze_corpus.py            # human-readable report
    python3 tools/analyze_corpus.py --json     # machine-readable, for handoff

Design rules this file follows (they exist because each was violated once):
  · Only `researchEligible` games enter any analysis.
  · Award categories: 3 = LARGEST ARMY, 4 = LONGEST ROAD (verified 330/330 vs the mechanic states).
    Do NOT read `awards.lrMe` from records written before v1.61 — it was wrong in 28% of them.
  · Schema-2 records lack leaderVP/terminalTurnNumber/mmrComplete; they are derived on read.
  · Decided = max(finalVP) >= vpToWin, i.e. "did ANYONE reach the target" — tie-invariant, and
    robust to the server naming a winner who is behind.
  · Concessions are a separate population, never folded into win/loss.
"""
import json, os, glob, math, sys, statistics as st
from collections import Counter, defaultdict

ROOT = os.path.expanduser('~/Downloads/Catan saved games/Games after v.156')
TLP = os.path.join(os.path.dirname(__file__), 'timeline_cache.json')
RES = ['wood', 'brick', 'sheep', 'wheat', 'ore']
VP_PTS = {'0': 1, '1': 2, '2': 1, '3': 2, '4': 2}
CAT_LA, CAT_LR, CAT_VPCARD, CAT_SETT, CAT_CITY = '3', '4', '2', '0', '1'
JSON_OUT = '--json' in sys.argv

OUT = {}          # machine-readable mirror of everything printed


def H(title):
    if not JSON_OUT:
        print('\n' + '=' * 78 + '\n' + title + '\n' + '=' * 78)


def P(*a):
    if not JSON_OUT:
        print(*a)


def load():
    games = []
    for p in sorted(glob.glob(os.path.join(ROOT, 'game-*.json'))):
        try:
            g = json.load(open(p))
        except ValueError:
            continue
        games.append(g)
    return games


def upgrade(g):
    """Derive schema-3 fields for older records, in memory only."""
    eg = g.get('endGame') or {}
    if g.get('terminalTurnNumber') is None and eg.get('totalTurnCount') is not None:
        g['terminalTurnNumber'] = eg['totalTurnCount']
    if g.get('completedTurns') is None:
        g['completedTurns'] = g.get('turns')
    fv = {k: v for k, v in (g.get('finalVP') or {}).items() if isinstance(v, int)}
    if fv:
        lead = max(fv.items(), key=lambda kv: kv[1])
        g['leader'], g['leaderVP'] = lead[0], lead[1]
        if g.get('vpToWin') is not None:
            g['decided'] = lead[1] >= g['vpToWin']
            g['conceded'] = not g['decided']
    if g.get('mmrComplete') is None:
        m = g.get('mmr') or {}
        g['mmrComplete'] = bool(m) and all(
            v and v.get('before') is not None and v.get('after') is not None for v in m.values())
    return g


def cats(g, col):
    pd = ((g.get('endGame') or {}).get('players') or {}).get(str(col)) or {}
    return {str(k): v for k, v in (pd.get('vpByCategory') or {}).items()}


def act(g, who='me'):
    col = g.get('myColor') if who == 'me' else g.get('oppColor')
    return ((g.get('endGame') or {}).get('activityStats') or {}).get(str(col)) or {}


def rst(g, who='me'):
    col = g.get('myColor') if who == 'me' else g.get('oppColor')
    return ((g.get('endGame') or {}).get('resourceStats') or {}).get(str(col)) or {}


def mmr_adv(g):
    m = g.get('mmr') or {}
    me, op = str(g.get('myColor')), str(g.get('oppColor'))
    if me in m and op in m and m[me].get('before') is not None and m[op].get('before') is not None:
        return m[me]['before'] - m[op]['before']
    return None


def sign_test(a, b):
    n = a + b
    if n == 0:
        return 1.0
    k = min(a, b)
    return min(1.0, sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n * 2)


def wilson(k, n, z=1.96):
    """95% CI for a proportion — small samples need the interval, not the point estimate."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0, c - h), min(1, c + h))


def pct(k, n):
    lo, hi = wilson(k, n)
    return f'{100*k/n:5.1f}%  [{100*lo:.0f}–{100*hi:.0f}]' if n else '   n/a'


# ─────────────────────────────────────────────────────────────────────────────
ALL = [upgrade(g) for g in load()]
ELIG = [g for g in ALL if (g.get('captureIntegrity') or {}).get('researchEligible')]
DEC = [g for g in ELIG if g.get('decided')]
CON = [g for g in ELIG if not g.get('decided')]
TL = {}
if os.path.exists(TLP):
    TL = {t['gameId']: t for t in json.load(open(TLP))}

H('0. CORPUS AND INTEGRITY')
ineligible = [g for g in ALL if g not in ELIG]
P(f'  records                 {len(ALL)}')
P(f'  research-eligible       {len(ELIG)}')
for g in ineligible:
    P(f'    EXCLUDED {g["gameId"]}: {(g.get("captureIntegrity") or {}).get("researchExclusionReason")}')
P(f'  decided                 {len(DEC)}  ({100*len(DEC)/len(ELIG):.1f}%)')
P(f'  conceded                {len(CON)}  ({100*len(CON)/len(ELIG):.1f}%)')
ver = Counter((g['version']['scorer'], g['version']['scorerConfigHash']) for g in ELIG)
P(f'  scorer / config         {dict(ver)}')
P(f'  replay / schema         {dict(Counter((g["version"]["replay"], g["version"]["recordSchema"]) for g in ELIG))}')
P(f'  timeline reconstructed  {len(TL)}')
OUT['corpus'] = {'records': len(ALL), 'eligible': len(ELIG), 'decided': len(DEC), 'conceded': len(CON),
                 'excluded': [{'gameId': g['gameId'],
                               'reason': (g.get('captureIntegrity') or {}).get('researchExclusionReason')}
                              for g in ineligible],
                 'scorer': list(ver.keys())[0] if ver else None}

H('1. OUTCOMES, SEAT AND OPPONENT STRENGTH')
w = sum(1 for g in DEC if g.get('iWon'))
P(f'  win rate (decided only)   {w}/{len(DEC)} = {pct(w, len(DEC))}')
advs = [mmr_adv(g) for g in DEC]
advs = [a for a in advs if a is not None]
P(f'  mean pre-game MMR edge    {st.mean(advs):+.1f}   median {st.median(advs):+.0f}   (n={len(advs)})')
P(f'  MMR-complete              {sum(1 for g in ELIG if g.get("mmrComplete"))}/{len(ELIG)}')
P('\n  By seat:')
seat_rows = {}
for seat, lab in ((True, 'P1'), (False, 'P2')):
    allg = [g for g in ELIG if bool(g.get('amFirst')) == seat]
    d = [g for g in allg if g.get('decided')]
    ww = sum(1 for g in d if g.get('iWon'))
    P(f'    {lab}  games {len(allg):>4}   decided {len(d):>4}   wins {ww:>4}   win rate {pct(ww, len(d))}')
    seat_rows[lab] = {'games': len(allg), 'decided': len(d), 'wins': ww}
P('\n  Win rate within MMR strata (controls opponent strength):')
strata = [('underdog (<0)', lambda a: a < 0), ('even (0..+40)', lambda a: 0 <= a < 40),
          ('favoured (>=+40)', lambda a: a >= 40)]
mmr_rows = {}
for lab, f in strata:
    v = [g for g in DEC if mmr_adv(g) is not None and f(mmr_adv(g))]
    ww = sum(1 for g in v if g.get('iWon'))
    P(f'    {lab:<18} n={len(v):>4}   win rate {pct(ww, len(v))}')
    mmr_rows[lab] = {'n': len(v), 'wins': ww}
OUT['outcomes'] = {'decided_win_rate': [w, len(DEC)], 'mmr_edge_mean': round(st.mean(advs), 1),
                   'seat': seat_rows, 'mmr_strata': mmr_rows}

H('2. WHAT A WON GAME LOOKS LIKE  (board leader among decided games)')
n = 0
c = Counter()
splits = []
for g in DEC:
    fv = {k: v for k, v in (g.get('finalVP') or {}).items() if isinstance(v, int)}
    if not fv:
        continue
    lead = max(fv.items(), key=lambda kv: kv[1])[0]
    ct = cats(g, lead)
    if not ct:
        continue
    n += 1
    if ct.get(CAT_VPCARD, 0): c['vp_card'] += 1
    if ct.get(CAT_LA, 0): c['la'] += 1
    if ct.get(CAT_LR, 0): c['lr'] += 1
    if ct.get(CAT_LA, 0) or ct.get(CAT_LR, 0): c['any_award'] += 1
    if ct.get(CAT_LA, 0) and ct.get(CAT_LR, 0): c['both_awards'] += 1
    cities = ct.get(CAT_CITY, 0)
    if cities >= 2: c['cities_ge2'] += 1
    if 3 <= cities <= 4: c['cities_3_4'] += 1
    splits.append((ct.get(CAT_SETT, 0) + cities * 2,
                   ct.get(CAT_VPCARD, 0) + (ct.get(CAT_LA, 0) + ct.get(CAT_LR, 0)) * 2))
rows = [('>=1 VP dev card', 'vp_card'), ('Largest Army', 'la'), ('Longest Road', 'lr'),
        ('>=1 award', 'any_award'), ('BOTH awards', 'both_awards'),
        ('>=2 cities', 'cities_ge2'), ('3-4 cities', 'cities_3_4')]
for lab, k in rows:
    P(f'  {lab:<18} {c[k]:>4}/{n}  {pct(c[k], n)}')
P(f'\n  avg VP split   buildings {st.mean([s[0] for s in splits]):.1f}  |  cards+awards {st.mean([s[1] for s in splits]):.1f}')
P(f'  winner VP distribution  {dict(sorted(Counter(max(g["finalVP"].values()) for g in DEC if g.get("finalVP")).items()))}')
OUT['winner_profile'] = {k: [c[k], n] for _, k in rows}

H('3. ENGINE GATE  →  CITY DEVELOPMENT   (the gate\'s strongest evidence)')
P('  The gate classifies the opening by wheat/ore access. Tested against CITY TIMING rather than')
P('  win/loss, because it has far more signal per game.\n')
P(f"  {'class':<9}{'games':>7}{'built a city':>20}{'med 1st-city roll':>19}{'med cities':>12}{'P1 share':>10}")
eng = {}
for ec in ('STRONG', 'WEAK', 'FRAGILE', 'MISSING'):
    v = [g for g in ELIG if ((g.get('openingState') or {}).get('engineClass')) == ec]
    if not v:
        continue
    got, rolls_, cities_ = 0, [], []
    for g in v:
        t = TL.get(g['gameId'])
        if not t:
            continue
        r = t['firstCityRoll'].get(t['myColor'])
        if r is not None:
            got += 1
            rolls_.append(r)
        cities_.append((t['buildCounts'].get(t['myColor']) or {}).get('city', 0))
    p1 = sum(1 for g in v if g.get('amFirst'))
    nt = sum(1 for g in v if TL.get(g['gameId']))
    P(f'  {ec:<9}{len(v):>7}{pct(got, nt):>20}'
      f"{(st.median(rolls_) if rolls_ else float('nan')):>19.1f}"
      f"{(st.median(cities_) if cities_ else float('nan')):>12.1f}{100*p1/len(v):>9.0f}%")
    eng[ec] = {'games': len(v), 'built_city': [got, nt],
               'median_first_city_roll': st.median(rolls_) if rolls_ else None,
               'median_cities': st.median(cities_) if cities_ else None,
               'p1_share': round(100 * p1 / len(v))}
OUT['engine_gate'] = eng

H('4. FIRST-CITY TIMING  →  OUTCOME')
pairs = []
for g in DEC:
    t = TL.get(g['gameId'])
    if not t:
        continue
    a, b = t['firstCityRoll'].get(t['myColor']), t['firstCityRoll'].get(t['oppColor'])
    if a is None or b is None:
        continue
    pairs.append((a, b, bool(g.get('iWon')), mmr_adv(g), g.get('rolls')))
ew = sum(1 for a, b, won, _, _ in pairs if a < b and won)
el = sum(1 for a, b, won, _, _ in pairs if a < b and not won)
lw = sum(1 for a, b, won, _, _ in pairs if a > b and won)
ll = sum(1 for a, b, won, _, _ in pairs if a > b and not won)
P(f'  decided games where BOTH built a city: {len(pairs)}')
P(f'    I built first   {ew+el:>4} games -> I won {pct(ew, ew+el)}')
P(f'    OPP built first {lw+ll:>4} games -> I won {pct(lw, lw+ll)}')
P(f'    exact sign test p = {sign_test(ew+ll, el+lw):.4f}   (paired, fully length-controlled)')
wt = [a if won else b for a, b, won, _, _ in pairs]
lt = [b if won else a for a, b, won, _, _ in pairs]
P(f'    median first-city roll   winner {st.median(wt):.0f}   loser {st.median(lt):.0f}')
med = st.median([p[0] for p in pairs])
P(f'\n  Absolute timing, split at my median first-city roll ({med:.0f}):')
for lab, sel in (('early', lambda p: p[0] <= med), ('late ', lambda p: p[0] > med)):
    v = [p for p in pairs if sel(p)]
    ww = sum(1 for p in v if p[2])
    mm = [p[3] for p in v if p[3] is not None]
    P(f'    {lab}  n={len(v):>4}  win rate {pct(ww, len(v))}   meanMMR {st.mean(mm):+6.1f}   medLen {st.median([p[4] for p in v]):.0f}')
P('\n  Within MMR strata (does the effect survive controlling for opponent strength?):')
fc = {}
for lab, f in strata:
    v = [p for p in pairs if p[3] is not None and f(p[3])]
    e = [p for p in v if p[0] <= med]
    l = [p for p in v if p[0] > med]
    if len(v) < 12:
        P(f'    {lab:<18} n={len(v)} (too few)')
        continue
    ew2, lw2 = sum(1 for p in e if p[2]), sum(1 for p in l if p[2])
    P(f'    {lab:<18} early {pct(ew2, len(e))} (n={len(e):>3})   late {pct(lw2, len(l))} (n={len(l):>3})')
    fc[lab] = {'early': [ew2, len(e)], 'late': [lw2, len(l)]}
OUT['first_city'] = {'paired': {'i_first': [ew, ew + el], 'opp_first': [lw, lw + ll],
                                'sign_p': round(sign_test(ew + ll, el + lw), 4)},
                     'median_winner': st.median(wt), 'median_loser': st.median(lt), 'strata': fc}

H('5. AWARDS  (the largest single splits in the data)')
aw = {}
for cat, lab in ((CAT_LA, 'Largest Army'), (CAT_LR, 'Longest Road')):
    held = [g for g in DEC if cats(g, g['myColor']).get(cat, 0)]
    nh = [g for g in DEC if not cats(g, g['myColor']).get(cat, 0)]
    hw = sum(1 for g in held if g.get('iWon'))
    nw = sum(1 for g in nh if g.get('iWon'))
    P(f'  {lab:<14} held n={len(held):>4} win {pct(hw, len(held))}    not held n={len(nh):>4} win {pct(nw, len(nh))}')
    aw[lab] = {'held': [hw, len(held)], 'not_held': [nw, len(nh)]}
both = [g for g in DEC if cats(g, g['myColor']).get(CAT_LA, 0) and cats(g, g['myColor']).get(CAT_LR, 0)]
neither = [g for g in DEC if not cats(g, g['myColor']).get(CAT_LA, 0) and not cats(g, g['myColor']).get(CAT_LR, 0)]
P(f"  {'BOTH awards':<14} n={len(both):>4} win {pct(sum(1 for g in both if g.get('iWon')), len(both))}")
P(f"  {'NEITHER':<14} n={len(neither):>4} win {pct(sum(1 for g in neither if g.get('iWon')), len(neither))}")
devb = [(act(g).get('devCardsBought'), cats(g, g['myColor']).get(CAT_LA, 0)) for g in DEC]
devb = [(a, b) for a, b in devb if a is not None]
P(f"\n  median dev cards bought — with LA {st.median([a for a,b in devb if b]):.0f}  without {st.median([a for a,b in devb if not b]):.0f}")
P('  (LA partly MEASURES a working engine: buying dev needs sheep+wheat+ore. Cause and symptom are tangled.)')
OUT['awards'] = aw

H('6. OPENING QUALITY  →  OUTCOME   (the regret paradox)')
P('  regret = score gap between the advisor\'s best candidate and the corner actually taken,')
P('  under the scorer the player was SHOWN (v1.50/ee784b36 for every game here).\n')


def regret(g):
    v = [o.get('regret') for o in (g.get('opening') or []) if isinstance(o.get('regret'), (int, float))]
    return sum(v) if v else None


reg = {}
for lab, gs in (('decided wins', [g for g in DEC if g.get('iWon')]),
                ('decided losses', [g for g in DEC if not g.get('iWon')]),
                ('conceded', CON)):
    v = sorted(x for x in map(regret, gs) if x is not None)
    if v:
        P(f'  {lab:<16} n={len(v):>4}  mean {st.mean(v):.2f}  median {st.median(v):.2f}')
        reg[lab] = {'n': len(v), 'mean': round(st.mean(v), 2), 'median': round(st.median(v), 2)}
P('\n  By seat and pick number (all eligible games):')
cells = defaultdict(list)
for g in ELIG:
    seat = 'P1' if g.get('amFirst') else 'P2'
    for i, o in enumerate(g.get('opening') or []):
        if isinstance(o.get('regret'), (int, float)):
            cells[(seat, i + 1)].append((o['regret'], o.get('rank'), bool(g.get('decided')), bool(g.get('iWon'))))
P(f"  {'seat/pick':<12}{'n':>6}{'mean regret':>13}{'median':>9}{'took #1':>10}")
for k in sorted(cells):
    v = cells[k]
    rs = [x[0] for x in v]
    P(f'  {k[0]+" pick "+str(k[1]):<12}{len(v):>6}{st.mean(rs):>13.2f}{st.median(rs):>9.2f}'
      f'{100*sum(1 for x in v if x[1]==1)/len(v):>9.0f}%')
P('\n  Within decided games, mean regret by outcome:')
for k in sorted(cells):
    v = [x for x in cells[k] if x[2]]
    wv = [x[0] for x in v if x[3]]
    lv = [x[0] for x in v if not x[3]]
    if not wv or not lv:
        continue
    P(f'    {k[0]+" pick "+str(k[1]):<12} wins {st.mean(wv):>6.2f} (n={len(wv):>3})   losses {st.mean(lv):>6.2f} (n={len(lv):>3})'
      f'   {"winners WORSE" if st.mean(wv) > st.mean(lv) else "winners better"}')
OUT['regret'] = reg

H('7. ROBBER PRESSURE  (paired, within-game)')
rp = {}
for lab, gs in (('wins', [g for g in DEC if g.get('iWon')]), ('losses', [g for g in DEC if not g.get('iWon')])):
    me = [act(g).get('resourceIncomeBlocked') for g in gs]
    op = [act(g, 'opp').get('resourceIncomeBlocked') for g in gs]
    pairsb = [(a, b) for a, b in zip(me, op) if a is not None and b is not None]
    P(f'  {lab:<8} n={len(pairsb):>4}   my blocked {st.mean([p[0] for p in pairsb]):5.2f}   opp blocked {st.mean([p[1] for p in pairsb]):5.2f}'
      f'   differential {st.mean([p[0]-p[1] for p in pairsb]):+5.2f}')
    rp[lab] = {'mine': round(st.mean([p[0] for p in pairsb]), 2), 'opp': round(st.mean([p[1] for p in pairsb]), 2)}
OUT['robber'] = rp

H('8. PRODUCTION: OPENING  →  REALIZED')
def pearson(xs, ys):
    pr = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pr) < 3:
        return None, 0
    xs, ys = zip(*pr)
    mx, my = st.mean(xs), st.mean(ys)
    num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    dx = math.sqrt(sum((a - mx) ** 2 for a in xs))
    dy = math.sqrt(sum((b - my) ** 2 for b in ys))
    return (num / (dx * dy) if dx and dy else None), len(pr)


tot, perroll = [], []
for g in ELIG:
    rp_ = (g.get('openingState') or {}).get('resourcePips') or {}
    s = sum(v for v in rp_.values() if isinstance(v, (int, float)))
    ri, rolls = rst(g).get('rollingIncome'), g.get('rolls')
    if s and ri is not None and rolls:
        tot.append(s)
        perroll.append(ri / rolls)
r, nn = pearson(tot, perroll)
P(f'  total opening pips  vs  rolling income PER ROLL    r={r:+.2f} (n={nn})')
P('  per-resource opening pips vs income per roll:')
prod = {'total': round(r, 2)}
for res in RES:
    xs, ys = [], []
    for g in ELIG:
        rp_ = (g.get('openingState') or {}).get('resourcePips') or {}
        ri, rolls = rst(g).get('rollingIncome'), g.get('rolls')
        if res in rp_ and ri is not None and rolls:
            xs.append(rp_[res])
            ys.append(ri / rolls)
    rr, n2 = pearson(xs, ys)
    P(f'     {res:<7} r={rr:+.2f} (n={n2})')
    prod[res] = round(rr, 2)
OUT['production'] = prod

H('9. CONCESSIONS  (separate behavioural population)')
pos = Counter()
lens = defaultdict(list)
for g in CON:
    fv = g.get('finalVP') or {}
    me, op = fv.get(str(g.get('myColor'))), fv.get(str(g.get('oppColor')))
    if me is None or op is None:
        continue
    k = 'ahead' if me > op else 'behind' if me < op else 'tied'
    pos[k] += 1
    lens[k].append(g.get('rolls') or 0)
tot_c = sum(pos.values())
for k in ('ahead', 'behind', 'tied'):
    P(f'  {k:<8} {pos[k]:>4}  ({100*pos[k]/tot_c:4.1f}%)   median length {st.median(lens[k]):.0f} rolls')
P(f'\n  median concession length {st.median([g.get("rolls") or 0 for g in CON]):.0f} rolls'
  f'   vs decided {st.median([g.get("rolls") or 0 for g in DEC]):.0f}')
OUT['concessions'] = {k: [pos[k], tot_c] for k in ('ahead', 'behind', 'tied')}

H('10. POWER — what this sample can and cannot settle')
P(f'  decided games {len(DEC)}.  95% CI on the headline win rate: {pct(w, len(DEC))}')
P(f'  A 50/50 coin over {len(DEC)} games has a 95% CI of roughly ±{100*1.96*0.5/math.sqrt(len(DEC)):.1f}pp,')
P(f'  so any effect smaller than that is invisible here regardless of how it is sliced.')
P(f'  Detecting a +3pp win-rate change at 80% power needs ~{int(2*(1.96+0.84)**2*0.25/0.03**2):,} decided games.')
OUT['power'] = {'decided': len(DEC), 'win_rate_ci': wilson(w, len(DEC))}

if JSON_OUT:
    print(json.dumps(OUT, indent=1, default=str))
else:
    print('\n' + '=' * 78)
    print('Reproduce: python3 tools/analyze_corpus.py   (add --json for machine output)')
    print('=' * 78)
