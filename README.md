# ForexBot AI

AI-assisted forex and commodities analysis platform. It combines market prices, technical features, macro/economic events, news context and a trainable probabilistic model to produce transparent trading signals.

## Important
This project is an analytical and paper-trading system. Predictions are probabilities, not guarantees. Live trading is disabled by default and should only be enabled after independent validation, broker testing, risk controls and regulatory review.

## Core features
- FX and commodity watchlists
- Technical indicators plus price action: EMA/RSI/ATR regimes, candlestick anatomy, engulfing and pin bars, inside/outside bars, 20-bar breakouts, swing structure, and support/resistance distance
- Economic calendar/event-risk layer
- News ingestion and sentiment context
- Explainable multi-factor signal scoring
- Trainable logistic model with time-ordered out-of-sample evaluation
- SQLite feature/trade/model store
- Incremental, idempotent 1H/4H historical candle ingestion
- FRED macro-history ingestion
- Automatic forward-return labeling and walk-forward validation
- Automatic paper-trading evaluation and broker-neutral execution-intent ledger
- Optional OANDA execution adapter (disabled by default)
- Responsive dashboard
- Railway-ready Node.js deployment

## Real data providers
The default `auto` mode now uses real external data instead of synthetic demo data:
- **Market:** Twelve Data when `TWELVE_DATA_API_KEY` is configured; otherwise Yahoo Finance chart data for FX and commodity futures.
- **News:** Finnhub when `FINNHUB_API_KEY` is configured; otherwise GDELT news search.
- **Economic calendar:** Finnhub when `FINNHUB_API_KEY` is configured; otherwise the weekly FairEconomy/ForexFactory feed.

Yahoo Finance is treated as a research-data fallback rather than a broker-grade execution feed. For production trading research, configure a licensed market-data provider such as Twelve Data. GDELT and the public calendar feed are likewise intended as data-ingestion fallbacks; validate licensing, coverage and timestamps before relying on them for automated execution.

## Environment
Copy `.env.example` to `.env` and configure only the providers you use.

Important variables:
```text
MARKET_PROVIDER=auto
MARKET_FALLBACK_SYMBOLS=XAGUSD,WTI
NEWS_PROVIDER=auto
CALENDAR_PROVIDER=auto
DATA_REFRESH_SECONDS=120
TWELVE_DATA_API_KEY=
FINNHUB_API_KEY=
FRED_API_KEY=
ADMIN_API_KEY=<generate-a-long-random-value>
HISTORY_AUTO_SYNC=true
HISTORY_SYNC_MINUTES=60
HISTORY_REQUEST_DELAY_MS=8500
MODEL_AUTO_TRAIN=true
MODEL_MIN_NEW_OBSERVATIONS=50
TRADING_ENABLED=false
EXECUTION_MODE=off
AUTO_PAPER_TRADING=false
BROKER_BRIDGE=none
```

## Run
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Railway
Connect this repository to Railway and deploy the `main` branch. Railway can automatically build and deploy a GitHub repository; generate a public domain after deployment.

## API
- `GET /health` — service and provider status
- `GET /api/providers` — active data-provider configuration
- `GET /api/market?symbol=EURUSD&interval=1h` — OHLC candles
- `GET /api/news?symbol=EURUSD` — recent news context
- `GET /api/calendar` — upcoming economic events
- `GET /api/signal?symbol=EURUSD` — synthesized probabilistic signal
- `GET /api/risk-plan?symbol=EURUSD` — risk-managed paper-trade plan
- `POST /api/model/train` — train the stored model
- `GET /api/history/status` — candle, label, run and macro coverage
- `GET /api/history/candles?symbol=EURUSD&timeframe=1h` — stored candles
- `POST /api/history/sync` — incremental sync (requires `x-admin-token`)
- `POST /api/macro/sync` — incremental FRED sync (requires `x-admin-token`)
- `POST /api/backtest/walk-forward` — expanding-window validation (requires `x-admin-token`)
- `GET /api/backtests/latest` — latest persisted walk-forward result

## Model training
The ingestion engine stores candles with a unique `(symbol, timeframe, timestamp)` key, resumes from the newest stored timestamp and safely upserts data. It generates normalized technical feature vectors and labels completed observations from forward returns after a configurable minimum-move threshold. `/api/model/train` uses a time-ordered 80/20 split, while `/api/backtest/walk-forward` runs expanding-window validation without random shuffling.

On Railway, SQLite must be placed on a persistent Volume (for example, mounted at `/data`) and `DB_PATH` set to `/data/forexbot.db`; otherwise redeployments can erase collected history. Keep `TRADING_ENABLED=false` during data collection, backtesting and demo validation.

Exness and XM commonly expose trading through MetaTrader 5 rather than a general-purpose cloud REST API. The planned execution adapter should therefore use a separately authenticated MT5 bridge/EA, with paper and demo validation, symbol mapping, stop-loss enforcement, drawdown limits and a kill switch before any live-money rollout.


## Execution architecture
Signals pass through research, event-risk, price-action and cost gates before a risk plan can create an execution intent. Supported modes are:
- `off` — analysis only.
- `paper` — broker-free paper ledger; when `AUTO_PAPER_TRADING=true`, eligible signals can be filled automatically in the paper ledger.
- `demo` — creates normalized intents for a future authenticated demo-broker bridge.
- `bridge` — creates broker-ready intents, but live submission is not performed by this service. Bridge intents require an explicit approval state before an external MT5 bridge may consume them.

The broker adapter is intentionally separate from the research engine so Exness, XM, or another MT5 broker can be mapped without changing signal generation. Keep live-money automation disabled until broker-demo validation and strategy approval gates are met.

## Price-action research
The current model version includes price-action features in every training row and live signal: candle body/wicks, bullish/bearish engulfing, pin bars, inside/outside bars, 20-bar breakouts, higher-high/lower-high/higher-low/lower-low structure, support/resistance distance in ATR units, and compression. Material price-action disagreement can block an otherwise directional signal.

## Quality gates
Run `npm test` locally. GitHub CI also runs syntax checks and price-action unit tests on pushes and pull requests.


## Signal monitoring and accuracy
The signal engine records one decision per closed candle for each supported market and monitored timeframe. A candidate is qualified only when its calibrated directional probability is at least `SIGNAL_MIN_PROBABILITY` (default 70%). Qualified candidates are monitored to the model horizon and settled using the next-bar entry and horizon-close exit, net of configured estimated transaction costs.

The dedicated `/signals.html` page shows the current 1H/4H board, price-action context, filters, historical signals, settled wins/losses, observed accuracy, and a 95% Wilson confidence interval. The broker-validation readiness gate requires a minimum settled sample and the configured empirical accuracy target; a model probability is never presented as proof of the same realized win rate.


## Broker connectivity
ForexBot now includes an HTTP client for an external MetaTrader 5 bridge. This is the broker-neutral boundary intended for Exness, XM, or another MT5 broker. Configure `MT5_BRIDGE_URL` and `MT5_BRIDGE_TOKEN` only after a bridge is running on a demo account. `GET /api/broker/status` checks bridge reachability and `POST /api/broker/demo-dispatch/:id` sends an eligible execution intent to the demo bridge.

The current service intentionally supports demo dispatch only. Live-money submission remains disabled while the monitored signal sample is accumulating and until the empirical accuracy/risk gates have been demonstrated.
