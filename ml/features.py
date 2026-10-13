"""
Feature + label extraction for the Catan placement learner.
Pure standard library (no dependencies) so it runs anywhere.

Input: the per-game JSON files the extension auto-saves to
`Downloads/Catan saved games/game-*.json` (also accepts an older `catan-dataset/v1`
bundle with a top-level `games` array). Records are deduped by gameId, so you can pool
files copied from both your Windows and Mac machines into one folder.

Target (chosen with the user): LUCK-ADJUSTED PRODUCTION.
  luck_adj_production = my_roll_income / (my_dice_luck% / 100)
Rationale: a single game's win/loss is mostly dice noise. Because we decoded
colonist's balanced-dice model, `luckMe` tells us how much the dice favoured your
board vs fair. Dividing your realized roll income by that factor removes the dice
luck and leaves a clean measure of how good the ENGINE your opening built was --
which is exactly what placement controls. (We also keep iWon as a secondary check.)
"""
import json

RES = ['wood', 'brick', 'sheep', 'wheat', 'ore']


def load_dataset(paths):
    """Load + merge game JSON files, deduped by gameId (latest wins).

    Accepts both per-game record files ({gameId: ...}) and an older bundle
    ({games: [...]}). Silently skips anything unparseable.
    """
    games = {}
    for p in paths:
        try:
            with open(p) as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        recs = d['games'] if isinstance(d, dict) and 'games' in d else ([d] if isinstance(d, dict) and d.get('gameId') else [])
        for g in recs:
            if g.get('gameId'):
                games[g['gameId']] = g
    return list(games.values())


ROOT = '~/Downloads/Catan saved games'

# Three generations, kept physically apart. Each was graded by a DIFFERENT scorer, and only the
# current one records end-game ground truth (final VP, decided/conceded, MMR), so pooling them
# silently blends incompatible datasets into one series.
CORPORA = {
    'current': ROOT + '/Games after v.156',        # v1.56+: full end-game truth + version block
    'v150':    ROOT + '/Games before v1.56/v150',  # v1.50-v1.55: scored by v1.50, no end-game data
    'v140':    ROOT + '/Games before v1.56',       # v1.40-era originals
}


def _glob(folder):
    import glob, os
    return sorted(glob.glob(os.path.expanduser(folder + '/game-*.json')))


def default_paths(which='current'):
    """Saved-game records for ONE generation. `which` in {'current','v150','v140','all'}.

    Always report which corpus a result came from. 'all' exists for completeness but mixing
    generations invalidates any outcome comparison — only the current one has concession flags.
    """
    if which == 'all':
        out = []
        for k in CORPORA:
            out += _glob(CORPORA[k])
        return out
    return _glob(CORPORA.get(which, CORPORA['current']))


def corpus_summary():
    """{name: n_records} — for printing which corpus a run actually used."""
    return {k: len(_glob(v)) for k, v in CORPORA.items()}


def upgrade_record(g):
    """Fill schema-3 fields on an older schema-2 record, in memory only.

    `terminalTurnNumber`, `leaderVP`/`leader` and `mmrComplete` were added in v1.60, but all three
    are DERIVABLE from fields schema-2 records already carry. Deriving them on read keeps the old
    and new games directly comparable without rewriting a single saved file (raw and derived records
    are treated as immutable). No-op on records that already have the fields.
    """
    eg = g.get('endGame') or {}
    if g.get('terminalTurnNumber') is None and eg.get('totalTurnCount') is not None:
        g['terminalTurnNumber'] = eg['totalTurnCount']
    if g.get('completedTurns') is None and g.get('turns') is not None:
        g['completedTurns'] = g['turns']
    fv = {k: v for k, v in (g.get('finalVP') or {}).items() if isinstance(v, int)}
    if g.get('leaderVP') is None and fv:
        lead = max(fv.items(), key=lambda kv: kv[1])
        g['leader'], g['leaderVP'] = lead[0], lead[1]
        # decided means "did ANYONE reach the target", which is robust to a leading player conceding.
        if g.get('vpToWin') is not None:
            g['decided'] = lead[1] >= g['vpToWin']
            g['conceded'] = not g['decided']
    if g.get('mmrComplete') is None:
        m = g.get('mmr') or {}
        g['mmrComplete'] = bool(m) and all(
            v and v.get('before') is not None and v.get('after') is not None for v in m.values())
    return g


def parse_nums(label):
    """Dice numbers from a corner label like '8-ore/10-wheat/4-wood'."""
    out = []
    for tok in str(label).split('/'):
        tok = tok.strip()
        if tok and tok[0].isdigit():
            try:
                out.append(int(tok.split('-')[0]))
            except ValueError:
                pass
    return out


def game_features(g):
    """One feature row per game, from MY perspective."""
    op = g.get('opening', []) or []
    picks = [o['mine'] for o in op if o.get('mine')]
    kinds, nums, ports = set(), [], []
    pips = hscore = 0.0
    for p in picks:
        pips += p.get('pips', 0)
        hscore += p.get('score', 0)
        for k in p.get('kinds', []):
            kinds.add(k)
        nums += parse_nums(p.get('label', ''))
        if p.get('port'):
            ports.append(p['port'])
    ranks = [o.get('rank') for o in op if o.get('rank')]
    regret = sum(o.get('regret', 0) for o in op)

    me = g.get('me', {}) or {}
    luck = g.get('luckMe') or 100
    real = me.get('realIncome', 0) or 0
    luck_adj = real / (luck / 100.0) if luck else real

    f = {
        'gameId': g.get('gameId'),
        # ── features (opening profile) ──
        'amFirst': 1 if g.get('amFirst') else 0,
        'total_pips': pips,
        'n_res': len(kinds),
        'has_6or8': 1 if any(n in (6, 8) for n in nums) else 0,
        'n_6or8': sum(1 for n in nums if n in (6, 8)),
        'has_2to1_port': 1 if any(pt.get('ratio') == 2 for pt in ports) else 0,
        'has_3to1_port': 1 if any(pt.get('ratio') == 3 for pt in ports) else 0,
        'heuristic_score': round(hscore, 2),
        'my_regret': round(regret, 2),
        'avg_pick_rank': round(sum(ranks) / len(ranks), 2) if ranks else None,
        # ── labels / outcomes ──
        'luck_adj_production': round(luck_adj, 1),   # PRIMARY target
        'real_income': real,
        'luckMe': luck,
        'iWon': 1 if g.get('iWon') else 0,
        # Turn counting: completedTurns = turns FINISHED; terminalTurnNumber includes the turn the
        # game ended on. They differ by exactly 1. Never mix them in one average.
        'turns': g.get('turns'),                                  # alias of completedTurns
        'completed_turns': g.get('completedTurns', g.get('turns')),
        'terminal_turn': g.get('terminalTurnNumber'),
        'cities': me.get('cities', 0),
        # ── data-quality gates: filter on these BEFORE any outcome claim ──
        # decided=False means nobody reached vpToWin (concession/abandon) — ~53% of games.
        'decided': 1 if g.get('decided') else 0,
        'conceded': 1 if g.get('conceded') else 0,
        'research_eligible': 1 if (g.get('captureIntegrity') or {}).get('researchEligible') else 0,
        'mmr_complete': 1 if g.get('mmrComplete') else 0,
        # Server-designated winner vs who actually led on VP — these differ when the player who is
        # AHEAD concedes. Use leader_vp for board position, iWon for match outcome.
        'winner_vp': g.get('winnerVP'),
        'leader_vp': g.get('leaderVP'),
    }
    for r in RES:
        f['covers_' + r] = 1 if r in kinds else 0
    return f


# Columns used as model inputs (order matters for weight export).
FEATURE_COLS = (
    ['amFirst', 'total_pips', 'n_res', 'has_6or8', 'n_6or8',
     'has_2to1_port', 'has_3to1_port', 'heuristic_score']
    + ['covers_' + r for r in RES]
)
TARGET = 'luck_adj_production'


def build_table(games):
    return [game_features(upgrade_record(g)) for g in games]
