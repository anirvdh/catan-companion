"""
Train the placement-weight learner on your game corpus.
Needs the libraries in requirements.txt:  pip install -r requirements.txt

Usage:
  python3 train.py                        # auto-reads ~/Downloads/Catan saved games/game-*.json
  python3 train.py <file.json> [more...]   # or point it at specific files

What it does:
  1. Builds the feature table (features.py) with LUCK-ADJUSTED PRODUCTION as the target.
  2. Fits a gradient-boosted model (nonlinear, catches interactions like
     "ore-port only helps if you have ore") -> feature importances.
  3. Fits a standardized linear model -> signed, comparable weights (direction + magnitude).
  4. Derives SUGGESTED per-resource weights that map directly onto the extension's
     `base` resource weights in buildBoardGeo (sidepanel.js), and writes learned_weights.json.
  5. Cross-validates honestly and refuses to over-claim on small samples.
"""
import sys, os, glob, json
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import cross_val_score, KFold

from features import load_dataset, build_table, default_paths, corpus_summary, FEATURE_COLS, TARGET, RES


def main():
    which = 'legacy' if '--legacy' in sys.argv else ('all' if '--all' in sys.argv else 'current')
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    paths = args or default_paths(which)
    nc, nl = corpus_summary()
    print(f'Corpus: {which}  (v150 folder: {nc} games | legacy: {nl} games)  -- never pool without saying so.')
    if not paths:
        print('No game files in ~/Downloads/Catan saved games/. Play some games (they auto-save) first.')
        return
    games = load_dataset(paths)
    df = pd.DataFrame(build_table(games))
    n = len(df)
    print(f'Loaded {n} games from {len(paths)} file(s). Record: '
          f'{int(df.iWon.sum())}W-{n - int(df.iWon.sum())}L')
    if n < 25:
        print(f'\n⚠  {n} games is too few to train reliably. Run analyze.py for directional signal;')
        print('   come back to train.py around 40-50+ games.')
        if n < 12:
            return

    # Keep only features that actually vary in this dataset.
    feats = [c for c in FEATURE_COLS if df[c].nunique(dropna=True) > 1]
    X = df[feats].fillna(0).astype(float)
    y = df[TARGET].astype(float)

    # ── Gradient-boosted model: nonlinear importances ──
    gbm = GradientBoostingRegressor(n_estimators=200, max_depth=2, learning_rate=0.05,
                                    subsample=0.8, random_state=0)
    cv_r2 = None
    if n >= 30:
        cv = KFold(n_splits=min(5, n // 6), shuffle=True, random_state=0)
        cv_r2 = float(np.mean(cross_val_score(gbm, X, y, cv=cv, scoring='r2')))
    gbm.fit(X, y)
    importances = sorted(zip(feats, gbm.feature_importances_), key=lambda t: -t[1])

    # ── Standardized linear model: signed, comparable weights ──
    Xs = StandardScaler().fit_transform(X)
    lin = LinearRegression().fit(Xs, y)
    coefs = dict(zip(feats, (float(c) for c in lin.coef_)))

    # ── Suggested per-resource weights (map onto buildBoardGeo `base`) ──
    # Use covers_<res> linear coefficients, normalized around 1.0 and gently clamped.
    res_coef = {r: coefs.get('covers_' + r, 0.0) for r in RES}
    mean_c = np.mean(list(res_coef.values())) if res_coef else 0.0
    spread = (np.std(list(res_coef.values())) or 1.0)
    suggested = {r: round(float(np.clip(1.0 + 0.25 * (res_coef[r] - mean_c) / spread, 0.7, 1.4)), 3)
                 for r in RES}

    # ── Report ──
    print('\n── Feature importance (gradient-boosted) ──')
    for f, imp in importances:
        print(f'  {f:<20}{imp:6.3f}')
    print('\n── Standardized linear coefficients (sign = direction, size = strength) ──')
    for f, c in sorted(coefs.items(), key=lambda t: -abs(t[1])):
        print(f'  {f:<20}{c:+7.2f}')
    print('\n── Suggested per-resource weights (drop into buildBoardGeo `base`) ──')
    print('  ' + '  '.join(f'{r}:{suggested[r]}' for r in RES))
    if cv_r2 is not None:
        print(f'\nCross-validated R²: {cv_r2:+.2f}  '
              f'({"usable" if cv_r2 > 0.1 else "weak — collect more games / more features"})')
    else:
        print(f'\n(Only {n} games — skipped cross-validation. Treat weights as provisional.)')

    out = {
        'schema': 'catan-learned-weights/v1',
        'n_games': n,
        'target': TARGET,
        'cv_r2': cv_r2,
        'feature_importances': [{'feature': f, 'importance': round(float(i), 4)} for f, i in importances],
        'linear_coefficients': {f: round(c, 4) for f, c in coefs.items()},
        'suggested_resource_weights': suggested,
        'note': 'Provisional until ~50+ games. suggested_resource_weights map onto the '
                '`base` resource weights in buildBoardGeo (sidepanel.js).',
    }
    with open(os.path.join(os.path.dirname(__file__), 'learned_weights.json'), 'w') as f:
        json.dump(out, f, indent=2)
    print('\nWrote learned_weights.json')


if __name__ == '__main__':
    main()
