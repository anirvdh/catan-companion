"""
Quick, dependency-free look at your game corpus. Runs with plain Python 3 — no
pip installs needed. Gives directional insight and validates the dataset before you
bother with the full trainer.

Usage:
  python3 analyze.py                        # auto-reads ~/Downloads/Catan saved games/game-*.json
  python3 analyze.py <file.json> [more...]   # or point it at specific files

What it tells you:
  - your record (W/L, 1st vs 2nd pick counts)
  - how each opening feature correlates with LUCK-ADJUSTED PRODUCTION (the target)
  - 1st-pick vs 2nd-pick differences (does position change what's good?)
  - a heuristic backtest: does the current advisor's "regret" predict worse results?
"""
import sys, os, glob
from features import load_dataset, build_table, FEATURE_COLS, TARGET, RES


def pearson(xs, ys):
    pts = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    n = len(pts)
    if n < 4:
        return None
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    num = sum((p[0] - mx) * (p[1] - my) for p in pts)
    dx = sum((p[0] - mx) ** 2 for p in pts) ** 0.5
    dy = sum((p[1] - my) ** 2 for p in pts) ** 0.5
    return num / (dx * dy) if dx and dy else None


def col(rows, key):
    return [r.get(key) for r in rows]


def main():
    from features import default_paths
    which = 'legacy' if '--legacy' in sys.argv else ('all' if '--all' in sys.argv else 'current')
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    paths = args or default_paths(which)
    nc, nl = corpus_summary()
    print(f'Corpus: {which}  (v150 folder: {nc} games | legacy: {nl} games)  -- never pool without saying so.')
    if not paths:
        print('No game files found in ~/Downloads/Catan saved games/.')
        print('Play a game (they auto-save), or pass file paths: python3 analyze.py <file.json> ...')
        return
    games = load_dataset(paths)
    rows = build_table(games)
    n = len(rows)
    print(f'\nLoaded {n} games from {len(paths)} file(s).')
    if not n:
        return

    wins = sum(r['iWon'] for r in rows)
    firsts = sum(r['amFirst'] for r in rows)
    print(f'Record: {wins}W - {n - wins}L   |   1st pick: {firsts}   2nd pick: {n - firsts}')
    tgt = [r[TARGET] for r in rows]
    print(f'{TARGET}: mean {sum(tgt)/n:.1f}  min {min(tgt):.1f}  max {max(tgt):.1f}')

    print('\n── Feature correlation with luck-adjusted production (and with winning) ──')
    print(f'{"feature":<20}{"vs production":>14}{"vs win":>10}')
    for c in FEATURE_COLS:
        rp = pearson(col(rows, c), tgt)
        rw = pearson(col(rows, c), [r['iWon'] for r in rows])
        fp = f'{rp:+.2f}' if rp is not None else '  n/a'
        fw = f'{rw:+.2f}' if rw is not None else '  n/a'
        print(f'{c:<20}{fp:>14}{fw:>10}')

    print('\n── 1st vs 2nd pick (mean luck-adjusted production) ──')
    for label, want in (('1st pick', 1), ('2nd pick', 0)):
        sub = [r[TARGET] for r in rows if r['amFirst'] == want]
        if sub:
            print(f'  {label}: {sum(sub)/len(sub):.1f}   (n={len(sub)})')

    print('\n── Heuristic backtest ──')
    reg = pearson(col(rows, 'my_regret'), tgt)
    if reg is not None:
        verdict = 'advisor looks aligned' if reg < -0.1 else ('advisor may be MISranking — worth retuning' if reg > 0.1 else 'inconclusive')
        print(f'  corr(my_regret, production) = {reg:+.2f}  → {verdict}')
        print('  (negative = when you deviated from the advisor you did worse = advisor is right)')
    else:
        print('  not enough games yet.')

    print('\n── Verdict ──')
    if n < 25:
        print(f'  {n} games — too few to trust. This is plumbing/validation only.')
        print('  Keep playing; re-run around 40-50 games, then run train.py for real weights.')
    elif n < 60:
        print(f'  {n} games — directional signal only. Patterns forming; not yet weights-grade.')
    else:
        print(f'  {n} games — enough for train.py to learn corrected weights. Go.')
    print()


if __name__ == '__main__':
    main()
