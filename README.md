# ForexBot AI

AI-assisted forex and commodities analysis platform. It combines market prices, technical features, macro/economic events, news context and a trainable probabilistic model to produce transparent trading signals.

## Important
This project is an analytical and paper-trading system. Predictions are probabilities, not guarantees. Live trading is disabled by default and should only be enabled after independent validation, broker testing, risk controls and regulatory review.

## Core features
- FX and commodity watchlists
- Technical indicators: EMA, RSI, MACD, ATR, Bollinger Bands
- Economic calendar/event-risk layer
- News ingestion and sentiment context
- Explainable multi-factor signal scoring
- Trainable logistic model with time-ordered out-of-sample evaluation
- SQLite feature/trade/model store
- Incremental, idempotent 1H/4H historical candle ingestion
- FRED macro-history ingestion
- Automatic forward-return labeling and walk-forward validation
- Paper trading ledger
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
TRADING_ENABLED=false
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

## Model training
The ingestion engine stores candles with a unique `(symbol, timeframe, timestamp)` key, resumes from the newest stored timestamp and safely upserts data. It generates normalized technical feature vectors and labels completed observations from forward returns after a configurable minimum-move threshold. `/api/model/train` uses a time-ordered 80/20 split, while `/api/backtest/walk-forward` runs expanding-window validation without random shuffling.

On Railway, SQLite must be placed on a persistent Volume (for example, mounted at `/data`) and `DB_PATH` set to `/data/forexbot.db`; otherwise redeployments can erase collected history. Keep `TRADING_ENABLED=false` during data collection, backtesting and demo validation.

Exness and XM commonly expose trading through MetaTrader 5 rather than a general-purpose cloud REST API. The planned execution adapter should therefore use a separately authenticated MT5 bridge/EA, with paper and demo validation, symbol mapping, stop-loss enforcement, drawdown limits and a kill switch before any live-money rollout.
