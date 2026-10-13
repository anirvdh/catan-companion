#!/usr/bin/env python3
"""Part 2 probe — which fields are actually observable DURING play, vs only in the end-game frame.

Answers "can the advisor see X live?" from evidence, not from the shape of the saved record.
For each field we report: how many games ever carry it, the earliest roll index it appears at,
and whether it appears before the type-45 end-game message.

    python3 tools/live_fields.py [n_games]
"""
import json, os, glob, sys
from collections import defaultdict, Counter

ROOT = os.path.expanduser('~/Downloads/Catan saved games/Games after v.156')
RAW = os.path.join(ROOT, 'raw')
N = int(sys.argv[1]) if len(sys.argv) > 1 else 40


def payload_of(d):
    if not isinstance(d, dict): return None
    o = d['data'] if isinstance(d.get('data'), dict) and d['data'].get('payload') else d
    p = o.get('payload') or d.get('payload')
    return p if isinstance(p, dict) else None


STATE_FIELDS = [
    'currentState', 'playerStates', 'mapState', 'gameLogState',
    'mechanicDevelopmentCardsState', 'mechanicLongestRoadState', 'mechanicLargestArmyState',
    'mechanicRobberState', 'mechanicTradeState', 'mechanicDiceState', 'mechanicTurnState',
    'mechanicMonopolyState', 'mechanicYearOfPlentyState', 'mechanicRoadBuildingState',
    'mechanicDiscardState', 'mechanicKnightState', 'mechanicBankTradeState',
]

seen_games = defaultdict(int)       # field -> games where it appeared pre-endgame
earliest = defaultdict(list)        # field -> earliest roll index per game
vp_live = 0                         # games where a live VP-ish field was seen
dev_enum_self, dev_enum_opp = 0, 0  # dev card composition visibility
ratio_live = 0
corner_bt = Counter()
games = sorted(glob.glob(os.path.join(RAW, 'game-*.json')))[:N]

for path in games:
    raw = json.load(open(path))
    msgs = raw.get('messages') or []
    rolls = 0
    ended = False
    first_seen = {}
    my_color = None
    saw_vp = False
    saw_dev_self = saw_dev_opp = False
    saw_ratio = False
    for m in msgs:
        p = payload_of(m.get('dec', m.get('data')))
        if p is None: continue
        if p.get('endGameState') or p.get('rankedUserStates'):
            ended = True
            continue
        if ended: continue
        if p.get('playerColor') is not None and my_color is None:
            my_color = str(p['playerColor'])
        g = p.get('gameState') or p.get('diff')
        if not isinstance(g, dict): continue
        gl = g.get('gameLogState')
        if isinstance(gl, dict):
            for v in gl.values():
                x = (v or {}).get('text') or {}
                if x.get('type') == 10 and isinstance(x.get('firstDice'), int): rolls += 1
        for f in STATE_FIELDS:
            if f in g and g[f] is not None and f not in first_seen:
                first_seen[f] = rolls
        # VP live?
        ps = g.get('playerStates')
        if isinstance(ps, dict):
            for c, pd in ps.items():
                if not isinstance(pd, dict): continue
                if any(k.lower().startswith('victorypoint') for k in pd):
                    saw_vp = True
                if pd.get('bankTradeRatiosState'): saw_ratio = True
        # dev-card composition: are enums revealed, and for whom?
        dcs = g.get('mechanicDevelopmentCardsState')
        if isinstance(dcs, dict) and isinstance(dcs.get('players'), dict):
            for c, pd in dcs['players'].items():
                cards = ((pd or {}).get('developmentCards') or {}).get('cards')
                if isinstance(cards, list) and cards:
                    revealed = any(isinstance(e, int) and e > 0 for e in cards)
                    if my_color is not None and str(c) == my_color:
                        if revealed: saw_dev_self = True
                    else:
                        if revealed: saw_dev_opp = True
        ms = g.get('mapState')
        if isinstance(ms, dict) and isinstance(ms.get('tileCornerStates'), dict):
            for cv in ms['tileCornerStates'].values():
                if isinstance(cv, dict) and cv.get('buildingType') is not None:
                    corner_bt[cv['buildingType']] += 1
    for f, r in first_seen.items():
        seen_games[f] += 1
        earliest[f].append(r)
    if saw_vp: vp_live += 1
    if saw_dev_self: dev_enum_self += 1
    if saw_dev_opp: dev_enum_opp += 1
    if saw_ratio: ratio_live += 1

print(f'Probed {len(games)} raw captures (pre-end-game frames only)\n')
print(f"{'field':<38}{'games w/ it':>13}{'median 1st roll':>17}")
print('-' * 68)
for f in STATE_FIELDS:
    n = seen_games.get(f, 0)
    if not n:
        print(f'{f:<38}{"0":>13}{"never":>17}')
        continue
    e = sorted(earliest[f])
    print(f'{f:<38}{f"{n}/{len(games)}":>13}{e[len(e)//2]:>17}')

print('\nSpecial probes')
print('-' * 68)
print(f'{"live victoryPoints field in playerStates":<50}{vp_live}/{len(games)}')
print(f'{"MY dev-card enums revealed live":<50}{dev_enum_self}/{len(games)}')
print(f'{"OPPONENT dev-card enums revealed live":<50}{dev_enum_opp}/{len(games)}')
print(f'{"bankTradeRatiosState present live":<50}{ratio_live}/{len(games)}')
print(f'\ncorner buildingType values seen live: {dict(corner_bt)}')
