#!/usr/bin/env python3
"""Independent validation of CATAN_165_GAME_DATASET_ANALYSIS.md against the fresh corpus.

Fresh corpus ONLY (`Games after v.156`). Every number printed here is reproducible by rerunning
this file. Nothing is written; this is read-only analysis.

    python3 tools/audit165.py
"""
import json, os, glob, hashlib, math, sys
from collections import Counter, defaultdict

ROOT = os.path.expanduser('~/Downloads/Catan saved games/Games after v.156')
RAW = os.path.join(ROOT, 'raw')

def load(folder, pat='game-*.json'):
    out = {}
    for p in sorted(glob.glob(os.path.join(folder, pat))):
        gid = os.path.basename(p)[5:-5]
        try:
            out[gid] = json.load(open(p))
        except ValueError as e:
            out[gid] = {'__parse_error__': str(e)}
    return out

REC = load(ROOT)
RAWG = load(RAW)
H = lambda s: print('\n' + '=' * 78 + '\n' + s + '\n' + '=' * 78)
def row(label, val, expect=None):
    mark = ''
    if expect is not None:
        mark = '  ✅' if str(val) == str(expect) else f'  ❌ report said {expect}'
    print(f'  {label:<58} {val}{mark}')

# ──────────────────────────────────────────────────────────────────────────────
H('1. DATA INTEGRITY')
row('Derived records', len(REC), 165)
row('Matching raw captures', len(RAWG), 165)
row('Record IDs == raw IDs', set(REC) == set(RAWG))
parse_err = [k for k, v in REC.items() if '__parse_error__' in v]
row('Records that failed to parse', len(parse_err), 0)

ci = lambda g: g.get('captureIntegrity') or {}
checks = ['rawWritten', 'replayCompleted', 'boardValid', 'setupValid',
          'firstRollSeen', 'endGameMessageSeen', 'captureComplete', 'researchEligible']
for c in checks:
    row(f'captureIntegrity.{c}', f"{sum(1 for g in REC.values() if ci(g).get(c))}/{len(REC)}", f'{len(REC)}/{len(REC)}')

hashes = Counter(g.get('sourceHash') for g in REC.values())
row('sourceHash present', sum(1 for g in REC.values() if g.get('sourceHash')), 165)
row('sourceHash unique', len(hashes) == len(REC))
dupes = {k: v for k, v in hashes.items() if v > 1}
if dupes: print('   DUPLICATE HASHES:', dupes)

# raw message count vs recorded metadata
mm = [gid for gid in REC if ci(REC[gid]).get('rawMessageCount') not in (None, len(RAWG.get(gid) or []))]
row('rawMessageCount matches actual raw length', f'{len(REC)-len(mm)}/{len(REC)}', f'{len(REC)}/{len(REC)}')
if mm: print('   mismatches:', mm[:10])

# VP arithmetic
VP_PTS = {'0': 1, '1': 2, '2': 1, '3': 2, '4': 2}
bad_vp = []
for gid, g in REC.items():
    eg = g.get('endGame') or {}
    for col, pd in (eg.get('players') or {}).items():
        cat = pd.get('vpByCategory') or {}
        calc = sum(VP_PTS.get(str(k), 0) * (v or 0) for k, v in cat.items())
        if pd.get('vp') != calc:
            bad_vp.append((gid, col, pd.get('vp'), calc))
row('VP category arithmetic errors', len(bad_vp), 0)

# decided rule
bad_dec = []
for gid, g in REC.items():
    fv = {k: v for k, v in (g.get('finalVP') or {}).items() if isinstance(v, int)}
    if not fv: continue
    want = max(fv.values()) >= g.get('vpToWin', 15)
    if bool(g.get('decided')) != want: bad_dec.append((gid, g.get('decided'), want, fv))
row('decided disagrees with max(finalVP)>=vpToWin', len(bad_dec), 0)
if bad_dec: print('   ', bad_dec[:5])

# roll sequence vs counts
bad_roll = []
for gid, g in REC.items():
    seq = g.get('rollSequence')
    if not seq: continue
    c = Counter(seq)
    rc = {int(k): v for k, v in (g.get('rollCounts') or {}).items()}
    if dict(c) != {k: v for k, v in rc.items() if v}: bad_roll.append(gid)
    if g.get('rolls') is not None and len(seq) != g['rolls']: bad_roll.append(gid + ':len')
row('rollSequence disagrees with rollCounts', len(set(bad_roll)), 0)

# timestamps
bad_ts = [gid for gid, g in REC.items()
          if g.get('startedAt') and g.get('endedAt') and g['startedAt'] > g['endedAt']]
row('Timestamp ordering errors', len(bad_ts), 0)

# ──────────────────────────────────────────────────────────────────────────────
H('1b. MMR COMPLETENESS')
def mmr_complete(g):
    m = g.get('mmr') or {}
    return bool(m) and all(v and v.get('before') is not None and v.get('after') is not None for v in m.values())
inc = sorted([gid for gid, g in REC.items() if not mmr_complete(g)])
row('MMR complete', f'{len(REC)-len(inc)}/{len(REC)}', '162/165')
row('Incomplete games', ', '.join(inc), 'path1301, sail6757, fort6728')

# ──────────────────────────────────────────────────────────────────────────────
H('2. VERSION CONSISTENCY')
ver = Counter((g.get('version', {}).get('scorer'), g.get('version', {}).get('scorerConfigHash')) for g in REC.values())
row('scorer/configHash combos', dict(ver), "{('v1.50','ee784b36'): 165}")
rs = Counter((g.get('version', {}).get('replay'), g.get('version', {}).get('recordSchema')) for g in REC.values())
print('  replay/schema split:')
for k, v in sorted(rs.items()): print(f'     replay {k[0]} / schema {k[1]}: {v}')
row('  → report said 1.56/2=69, 1.60/3=96', dict(rs))

# ──────────────────────────────────────────────────────────────────────────────
H('3. OUTCOME POPULATION')
dec = {gid: g for gid, g in REC.items() if g.get('decided')}
con = {gid: g for gid, g in REC.items() if not g.get('decided')}
row('decided', f'{len(dec)} ({100*len(dec)/len(REC):.1f}%)', '86 (52.1%)')
row('conceded', f'{len(con)} ({100*len(con)/len(REC):.1f}%)', '79 (47.9%)')
w = sum(1 for g in dec.values() if g.get('iWon'))
row('wins among decided', f'{w}/{len(dec)} = {100*w/len(dec):.1f}%', '54/86 = 62.8%')

# MMR advantage
advs = []
for g in dec.values():
    if not mmr_complete(g): continue
    me, opp = g.get('myColor'), g.get('oppColor')
    m = g['mmr']
    if me in m and opp in m: advs.append(m[me]['before'] - m[opp]['before'])
row('mean pre-game MMR advantage (decided, complete)', f'{sum(advs)/len(advs):+.1f} (n={len(advs)})', '~+35')
row('median MMR advantage', f'{sorted(advs)[len(advs)//2]:+.0f}')

print('\n  Seat split:')
for seat, lab in ((True, 'P1'), (False, 'P2')):
    allg = [g for g in REC.values() if bool(g.get('amFirst')) == seat]
    d = [g for g in allg if g.get('decided')]
    ww = sum(1 for g in d if g.get('iWon'))
    print(f'     {lab}: {len(allg)} games | decided {len(d)} | wins {ww} | win rate {100*ww/len(d) if d else 0:.1f}%')
print('     report: P1 76 games/46 dec/30 w/65.2% · P2 89 games/40 dec/24 w/60.0%')

print('\n  Concession positions (recorded player vs opponent VP):')
pos = Counter()
for g in con.values():
    fv = g.get('finalVP') or {}
    me, opp = fv.get(g.get('myColor')), fv.get(g.get('oppColor'))
    if me is None or opp is None: pos['unknown'] += 1
    else: pos['ahead' if me > opp else 'behind' if me < opp else 'tied'] += 1
for k in ('ahead', 'behind', 'tied', 'unknown'):
    if pos[k]: print(f'     {k:<8} {pos[k]:>3} ({100*pos[k]/len(con):.1f}%)')
print('     report: ahead 37 (46.8%) · behind 30 (38.0%) · tied 12 (15.2%)')

# ──────────────────────────────────────────────────────────────────────────────
H('4. WINNER vs LEADER')
diff_id, strict_lower, tied = [], [], []
for gid, g in REC.items():
    fv = {k: v for k, v in (g.get('finalVP') or {}).items() if isinstance(v, int)}
    if not fv or not g.get('winner'): continue
    mx = max(fv.values())
    wvp = fv.get(str(g['winner']))
    leaders = [c for c, v in fv.items() if v == mx]
    if str(g['winner']) not in leaders: diff_id.append(gid)
    if wvp is not None and wvp < mx: strict_lower.append((gid, wvp, mx, g.get('decided')))
    if len(leaders) > 1: tied.append(gid)
row('winner is NOT (a) VP leader', len(diff_id), '11')
row('winner VP strictly < max(finalVP)', len(strict_lower), '4')
row('games with TIED max VP (leader ambiguous)', len(tied))
print('   strictly-lower cases:', strict_lower)

print('\n  Decided-winner VP distribution:')
dist = Counter(max(g['finalVP'].values()) for g in dec.values() if g.get('finalVP'))
for k in sorted(dist): print(f'     {k} VP: {dist[k]}')
print('     report: 82 at 15, 4 at 16')

# ──────────────────────────────────────────────────────────────────────────────
H('5. DECIDED-WINNER COMPOSITION')
# winner's own category counts
chars = Counter(); n = 0
splits = []
for g in dec.values():
    eg = g.get('endGame') or {}
    wcol = None
    for col, pd in (eg.get('players') or {}).items():
        if pd.get('winner'): wcol = col
    # use the VP LEADER as "the winner of the board", robust to concession labelling
    fv = {k: v for k, v in (g.get('finalVP') or {}).items() if isinstance(v, int)}
    lead = max(fv.items(), key=lambda kv: kv[1])[0] if fv else None
    pd = (eg.get('players') or {}).get(lead)
    if not pd: continue
    cat = {str(k): v for k, v in (pd.get('vpByCategory') or {}).items()}
    n += 1
    cities = cat.get('1', 0)
    if cat.get('2', 0) >= 1: chars['vp_card'] += 1
    if cat.get('3', 0) or cat.get('4', 0): chars['any_award'] += 1
    if cat.get('3', 0): chars['longest_road'] += 1
    if cat.get('4', 0): chars['largest_army'] += 1
    if 3 <= cities <= 4: chars['cities_3_4'] += 1
    if cities >= 2: chars['cities_ge2'] += 1
    build = cat.get('0', 0) * 1 + cities * 2
    other = cat.get('2', 0) * 1 + cat.get('3', 0) * 2 + cat.get('4', 0) * 2
    splits.append((build, other))
exp = {'vp_card': '83/86 96.5%', 'any_award': '85/86 98.8%', 'longest_road': '62/86 72.1%',
       'largest_army': '64/86 74.4%', 'cities_3_4': '74/86 86.0%', 'cities_ge2': '86/86 100%'}
for k in ('vp_card', 'any_award', 'longest_road', 'largest_army', 'cities_3_4', 'cities_ge2'):
    row(k, f'{chars[k]}/{n} = {100*chars[k]/n:.1f}%', exp[k])
row('avg VP split buildings / cards+awards',
    f'{sum(s[0] for s in splits)/len(splits):.1f} / {sum(s[1] for s in splits)/len(splits):.1f}', '9.9 / 5.1')

# ──────────────────────────────────────────────────────────────────────────────
H('7. ENGINE CLASS (recorded player\'s ACTUAL opening)')
tbl = defaultdict(lambda: [0, 0, 0])
for g in REC.values():
    ec = ((g.get('openingState') or {}).get('engineClass')) or 'NONE'
    tbl[ec][0] += 1
    if g.get('decided'):
        tbl[ec][1] += 1
        if g.get('iWon'): tbl[ec][2] += 1
print(f"  {'class':<10}{'all':>6}{'decided':>9}{'wins':>6}{'win%':>8}")
for k in ('STRONG', 'WEAK', 'FRAGILE', 'MISSING', 'NONE'):
    if k in tbl:
        a, d, wn = tbl[k]
        print(f'  {k:<10}{a:>6}{d:>9}{wn:>6}{(100*wn/d if d else 0):>7.1f}%')
print('  report: STRONG 131/69/46/66.7 · WEAK 15/8/4/50.0 · FRAGILE 3/3/2/66.7 · MISSING 16/6/2/33.3')

# ──────────────────────────────────────────────────────────────────────────────
H('8. OPENING REGRET (combined, actual selected settlements)')
def regret(g):
    op = g.get('opening') or []
    vals = [o.get('regret') for o in op if isinstance(o.get('regret'), (int, float))]
    return sum(vals) if vals else None
def stats(gs):
    v = sorted(x for x in (regret(g) for g in gs) if x is not None)
    if not v: return (0, None, None)
    return (len(v), sum(v)/len(v), v[len(v)//2])
for lab, gs, e in (('decided wins', [g for g in dec.values() if g.get('iWon')], '54 / 2.01 / 1.80'),
                   ('decided losses', [g for g in dec.values() if not g.get('iWon')], '32 / 1.18 / 0.56'),
                   ('conceded', list(con.values()), '79 / 1.63 / 1.30')):
    nn, mean, med = stats(gs)
    print(f'  {lab:<18} n={nn:<4} mean={mean if mean is None else round(mean,2):<7} median={med if med is None else round(med,2):<7} (report: {e})')

# ──────────────────────────────────────────────────────────────────────────────
H('9. RESOURCE / ACTIVITY METRICS (decided only)')
def act(g, who='me'):
    eg = g.get('endGame') or {}
    col = g.get('myColor') if who == 'me' else g.get('oppColor')
    rs = (eg.get('resourceStats') or {}).get(col) or {}
    ac = (eg.get('activityStats') or {}).get(col) or {}
    inc = sum(v for k, v in rs.items() if k.endswith('Income') and isinstance(v, (int, float)))
    return inc, ac.get('resourceIncomeBlocked'), ac.get('devCardsBought'), ac.get('devCardsUsed'), ac.get('trades')
for lab, gs in (('wins', [g for g in dec.values() if g.get('iWon')]),
                ('losses', [g for g in dec.values() if not g.get('iWon')])):
    inc = [act(g)[0] for g in gs]
    blk = [act(g)[1] for g in gs if act(g)[1] is not None]
    print(f'  {lab:<8} n={len(gs):<4} mean total income={sum(inc)/len(inc):.1f}   mean blocked={sum(blk)/len(blk) if blk else float("nan"):.1f} (n={len(blk)})')
print('  report: income 119 vs 106 · blocked 5.9 vs 8.7')

print('\n' + '=' * 78)
print('END — every figure above is reproducible via: python3 tools/audit165.py')
print('=' * 78)
