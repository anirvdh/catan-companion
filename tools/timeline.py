#!/usr/bin/env python3
"""Reconstruct per-game event timelines from the IMMUTABLE raw captures.

Research-only. Nothing here is added to the extension; it exists so intermediate-progression
questions (first city, first dev card, build order, robber pressure) can be answered offline
without building permanent recording infrastructure.

Emits one dict per game:
  {gameId, decided, iWon, myColor, oppColor, amFirst,
   events:[{turn, roll_idx, color, kind, piece}], firstCity:{color:turn}, ...}

Turn index = number of dice rolls seen so far (a robust, monotone clock that needs no
turn-boundary reconstruction). We ALSO read the server's own completedTurns when present.
"""
import json, os, glob, sys
from collections import defaultdict

ROOT = os.path.expanduser('~/Downloads/Catan saved games/Games after v.156')
RAW = os.path.join(ROOT, 'raw')

PIECE = {0: 'road', 2: 'settlement', 3: 'city'}


def payload_of(d):
    """Mirror of sidepanel.js `payloadOf` — the payload sits at data.payload or payload."""
    if not isinstance(d, dict):
        return None
    o = d['data'] if isinstance(d.get('data'), dict) and d['data'].get('payload') else d
    p = o.get('payload') or d.get('payload')
    return p if isinstance(p, dict) else None


def analyze(gid):
    """Replay one raw capture. Log entries are keyed by a monotone LOG ID and nested under
    `.text`; the same entry is re-sent inside later snapshots, so dedupe by id exactly as
    reviewAnalyze does (content-dedupe would wrongly collapse two identical 8-rolls)."""
    raw = json.load(open(os.path.join(RAW, f'game-{gid}.json')))
    msgs = raw.get('messages') or []
    rolls = 0
    completed = 0
    ev = []
    seen = set()
    for m in msgs:
        p = payload_of(m.get('dec', m.get('data')))
        if p is None:
            continue
        g = p.get('gameState') or p.get('diff')
        if isinstance(g, dict):
            cs = g.get('currentState')
            if isinstance(cs, dict) and isinstance(cs.get('completedTurns'), int):
                completed = cs['completedTurns']
        if isinstance(g, dict) and isinstance(g.get('gameLogState'), dict):
            gl = g['gameLogState']
            for logId in sorted(gl.keys(), key=lambda s: int(s) if str(s).lstrip('-').isdigit() else 0):
                if logId in seen:
                    continue
                seen.add(logId)
                x = (gl[logId] or {}).get('text')
                if not isinstance(x, dict):
                    continue
                t = x.get('type')
                if t is None:
                    continue
                c = x.get('playerColor')
                if t == 10 and isinstance(x.get('firstDice'), int):
                    rolls += 1
                    ev.append({'turn': completed, 'roll': rolls, 'color': str(c), 'kind': 'roll',
                               'total': x['firstDice'] + x['secondDice']})
                elif t == 5:
                    ev.append({'turn': completed, 'roll': rolls, 'color': str(c), 'kind': 'build',
                               'piece': PIECE.get(x.get('pieceEnum'), str(x.get('pieceEnum')))})
                elif t == 4:
                    ev.append({'turn': completed, 'roll': rolls, 'color': str(c), 'kind': 'setup_build',
                               'piece': PIECE.get(x.get('pieceEnum'), str(x.get('pieceEnum')))})
                elif t == 20:
                    ev.append({'turn': completed, 'roll': rolls, 'color': str(c), 'kind': 'dev_play',
                               'card': x.get('cardEnum')})
                elif t == 116:
                    ev.append({'turn': completed, 'roll': rolls, 'color': str(c), 'kind': 'trade',
                               'gave': x.get('givenCardEnums'), 'got': x.get('receivedCardEnums')})
                elif t in (14, 15):
                    ev.append({'turn': completed, 'roll': rolls, 'color': str(c), 'kind': 'steal', 'dir': t})
    return ev


def summarize(gid, rec):
    ev = analyze(gid)
    builds = [e for e in ev if e['kind'] == 'build']
    out = {'gameId': gid, 'decided': bool(rec.get('decided')), 'iWon': bool(rec.get('iWon')),
           'amFirst': bool(rec.get('amFirst')), 'myColor': str(rec.get('myColor')),
           'oppColor': str(rec.get('oppColor')), 'nEvents': len(ev),
           'rolls': max([e['roll'] for e in ev], default=0),
           'recRolls': rec.get('rolls'), 'recTurns': rec.get('turns')}
    firsts = {}
    counts = defaultdict(lambda: defaultdict(int))
    for e in builds:
        counts[e['color']][e['piece']] += 1
        k = (e['color'], e['piece'])
        if k not in firsts: firsts[k] = e
    out['buildCounts'] = {c: dict(v) for c, v in counts.items()}
    out['firstCity'] = {c: firsts[(c, 'city')]['turn'] for c in (out['myColor'], out['oppColor'])
                        if (c, 'city') in firsts}
    out['firstCityRoll'] = {c: firsts[(c, 'city')]['roll'] for c in (out['myColor'], out['oppColor'])
                            if (c, 'city') in firsts}
    devp = [e for e in ev if e['kind'] == 'dev_play']
    out['firstDevPlay'] = {}
    for c in (out['myColor'], out['oppColor']):
        d = [e for e in devp if e['color'] == c]
        if d: out['firstDevPlay'][c] = d[0]['turn']
    out['events'] = ev
    return out


if __name__ == '__main__':
    recs = {os.path.basename(p)[5:-5]: json.load(open(p)) for p in sorted(glob.glob(os.path.join(ROOT, 'game-*.json')))}
    res = []
    for i, (gid, rec) in enumerate(sorted(recs.items())):
        try:
            res.append(summarize(gid, rec))
        except Exception as e:
            print(f'  !! {gid}: {e}', file=sys.stderr)
    out = os.path.join(os.path.dirname(__file__), 'timeline_cache.json')
    slim = [{k: v for k, v in r.items() if k != 'events'} for r in res]
    json.dump(slim, open(out, 'w'))
    print(f'reconstructed {len(res)} games -> {out}')
