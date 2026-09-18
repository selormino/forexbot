# Context-aware research engine

Each symbol and 1H/4H timeframe now has an independent, versioned logistic model. Legacy pooled models remain stored but are not used by signals. News headline sentiment is a heuristic, not a language model or a causal FX forecast.

## Point-in-time inputs

FRED levels/changes are captured in immutable first-observed snapshots. Existing revised historical FRED values are NOT retrospectively assigned to earlier candles. Macro inputs currently describe US conditions, not bilateral interest-rate differentials. News is deduplicated with both publication and first-observed timestamps. Missing history remains missing with coverage indicators; at least 100 training samples with macro and news coverage are required for approval. Accumulating this coverage takes time. Historical ALFRED vintage ingestion is not implemented.

## Validation and costs

Only closed candles enter research datasets. Inputs end at the decision candle; entry is next open and exit four bars later. Outcome windows crossing gaps or changing providers are excluded. Chronological 60/20/20 train/calibration/test sets are purged using actual outcome-end timestamps. Platt-style logistic calibration is fitted only on the calibration segment. Three expanding-window evaluations record accuracy, log loss, Brier score, reliability bins, non-overlapping trade returns, expectancy, profit factor and drawdown.

Costs are estimated round-trip spread plus two-sided slippage and commission in basis points. Configure SPREAD_BPS_EURUSD (and other symbol suffixes), SLIPPAGE_BPS and COMMISSION_BPS. Defaults are illustrative, not Exness/XM quotes. Returns are unlevered fixed-horizon estimates, not a stop-loss execution simulator; overnight financing is excluded.

## Trade filters

Signals WAIT unless the latest per-series model passes coverage, baseline log-loss, positive net expectancy, and minimum-trade gates. Further filters require fresh closed candles, complete recent candle sequences, a trend regime agreeing with direction, 62% directional probability, sufficient ATR relative to costs, fresh macro/news context, and a calendar free from high-impact events within one hour. Yahoo futures-proxy feeds are research-only and blocked from actionable signals. Calendar lockout is deliberately conservative across all currencies.

Live execution remains unimplemented/disabled. Approval does not mean profitability is guaranteed. The probability estimates positive future return, NOT probability of hitting take-profit.

## API

- GET /api/research/status: per-symbol/timeframe validation reports and coverage.
- GET /api/news/history?symbol=EURUSD: observed sentiment history.
- POST /api/research/train with symbol/timeframe: protected by x-admin-token.
- GET /api/signal?symbol=EURUSD&timeframe=4h: filtered v2 signal.

All POST API requests now require the admin token. Historical legacy backtest endpoints remain available for comparison; v2 reports are under /api/research/status. Scheduled collection captures context and trains v2 series when MODEL_AUTO_TRAIN is enabled. No provider keys are returned to clients.

Tests: node --test test/research.test.js
