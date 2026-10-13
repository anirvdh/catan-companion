"""
Trajectory comparison: run the IDENTICAL learner pipeline on the first N games
(chronological by savedAt) for N = 50, 75, 100 and print the diffs side by side.
Also reports win-rate splits (overall / first / second) since a single game's W/L
is dice-noisy but the aggregate tells us if placement is systematically losing.
"""
import sys, os, json
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import cross_val_score, KFold

from features import load_dataset, build_table, default_paths, corpus_summary, FEATURE_COLS, TARGET, RES


def run_pipeline(df):
    n = len(df)
    feats = [c for c in FEATURE_COLS if df[c].nunique(dropna=True) > 1]
    X = df[feats].fillna(0).astype(float)
    y = df[TARGET].astype(float)

    gbm = GradientBoostingRegressor(n_estimators=200, max_depth=2, learning_rate=0.05,
                                    subsample=0.8, random_state=0)
    cv_r2 = None
    if n >= 30:
        cv = KFold(n_splits=min(5, n // 6), shuffle=True, random_state=0)
        cv_r2 = float(np.mean(cross_val_score(gbm, X, y, cv=cv, scoring='r2')))
    gbm.fit(X, y)
    importances = dict(zip(feats, (float(i) for i in gbm.feature_importances_)))

    Xs = StandardScaler().fit_transform(X)
    lin = LinearRegression().fit(Xs, y)
    coefs = dict(zip(feats, (float(c) for c in lin.coef_)))

    res_coef = {r: coefs.get('covers_' + r, 0.0) for r in RES}
    mean_c = np.mean(list(res_coef.values()))
    spread = (np.std(list(res_coef.values())) or 1.0)
    suggested = {r: round(float(np.clip(1.0 + 0.25 * (res_coef[r] - mean_c) / spread, 0.7, 1.4)), 3)
                 for r in RES}
    return {'n': n, 'cv_r2': cv_r2, 'importances': importances,
            'coefs': coefs, 'suggested': suggested, 'res_coef': res_coef}


def winsplit(df):
    def wr(sub):
        if len(sub) == 0:
            return '—'
        return f'{int(sub.iWon.sum())}/{len(sub)} = {100*sub.iWon.mean():.0f}%'
    return {
        'overall': wr(df),
        'first': wr(df[df.amFirst == 1]),
        'second': wr(df[df.amFirst == 0]),
    }


def main():
    games = load_dataset(default_paths('current'))
    # chronological order
    games.sort(key=lambda g: g.get('savedAt') or '')
    full = pd.DataFrame(build_table(games))
    print(f'Total games in corpus: {len(full)}\n')

    checkpoints = [n for n in (50, 75, 100) if n <= len(full)]
    if len(full) not in checkpoints:
        checkpoints.append(len(full))
    results = {}
    for n in checkpoints:
        sub = full.iloc[:n].copy()
        results[n] = {'pipe': run_pipeline(sub), 'win': winsplit(sub)}

    # ── Win-rate trajectory ──
    print('══ WIN RATE (cumulative, chronological) ══')
    print(f'{"@games":>8} | {"overall":>14} | {"as 1st":>14} | {"as 2nd":>14}')
    for n in checkpoints:
        w = results[n]['win']
        print(f'{n:>8} | {w["overall"]:>14} | {w["first"]:>14} | {w["second"]:>14}')

    # ── CV R² trajectory ──
    print('\n══ CROSS-VALIDATED R²  (can we predict engine quality from the opening?) ══')
    for n in checkpoints:
        r = results[n]['pipe']['cv_r2']
        print(f'  @{n:>3} games:  {r:+.3f}' if r is not None else f'  @{n:>3} games:  (skipped)')

    # ── Suggested resource weights side by side ──
    print('\n══ MODEL-SUGGESTED RESOURCE WEIGHTS (linear covers_* -> base weight) ══')
    print(f'{"res":>7} | ' + ' | '.join(f'@{n:<6}' for n in checkpoints) + ' | current')
    current = {'wood':1.0,'brick':1.0,'sheep':0.9,'wheat':1.15,'ore':1.1}
    for r in RES:
        row = ' | '.join(f'{results[n]["pipe"]["suggested"][r]:<7}' for n in checkpoints)
        print(f'{r:>7} | {row} | {current[r]}')

    # ── Raw covers_* linear coefficients (sign = does this resource help?) ──
    print('\n══ RAW LINEAR COEF covers_<res>  (+ = opening w/ this res scored higher engine) ══')
    print(f'{"res":>7} | ' + ' | '.join(f'@{n:<7}' for n in checkpoints))
    for r in RES:
        row = ' | '.join(f'{results[n]["pipe"]["res_coef"][r]:+8.2f}' for n in checkpoints)
        print(f'{r:>7} | {row}')

    # ── Feature importance @ full ──
    print(f'\n══ FEATURE IMPORTANCE @ {checkpoints[-1]} games (gradient-boosted) ══')
    imp = results[checkpoints[-1]]['pipe']['importances']
    for f, v in sorted(imp.items(), key=lambda t: -t[1]):
        bar = '█' * int(v * 40)
        print(f'  {f:<18}{v:6.3f}  {bar}')

    # ── Full linear coefficients @ full ──
    print(f'\n══ ALL STANDARDIZED LINEAR COEFS @ {checkpoints[-1]} games ══')
    coefs = results[checkpoints[-1]]['pipe']['coefs']
    for f, c in sorted(coefs.items(), key=lambda t: -abs(t[1])):
        print(f'  {f:<18}{c:+7.2f}')


if __name__ == '__main__':
    main()
