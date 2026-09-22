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
- Two-stage probabilistic research model: directional bias plus triggered setup-success probability, both time-ordered and out-of-sample evaluated
- SQLite feature/trade/model store
- Incremental, idempotent 1H/4H historical candle ingestion
- FRED current macro-history ingestion plus ALFRED point-in-time vintage storage for leakage-safe research
- Automatic forward-return labeling and walk-forward validation
- Automatic paper-trading evaluation, broker-neutral execution-intent ledger, XM demo reconciliation, and strict-signal demo automation
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
ALFRED_START_DATE=2000-01-01
ALFRED_AVAILABILITY_LAG_DAYS=1
ADMIN_API_KEY=<generate-a-long-random-value>
HISTORY_AUTO_SYNC=true
HISTORY_SYNC_MINUTES=60
HISTORY_REQUEST_DELAY_MS=8500
MODEL_AUTO_TRAIN=true
MODEL_MIN_NEW_OBSERVATIONS=50
TRADING_ENABLED=false
EXECUTION_MODE=off
AUTO_PAPER_TRADING=false
AUTO_DEMO_STRICT=false
AUTO_MIN_CONFLUENCE=60
CTA_MIN_PROBABILITY=0.40
BROKER_BRIDGE=none
BROKER_RECONCILE_ENABLED=false
BROKER_RECONCILE_SECONDS=60
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
- `GET /api/macro/vintages/status` — point-in-time ALFRED vintage coverage
- `POST /api/macro/vintages/sync` — backfill/refresh ALFRED vintages (requires `x-admin-token`)
- `POST /api/broker/reconcile` — refresh MT5 order lifecycle/P&L (requires `x-admin-token`)
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


## CTA trend-following strategy

Research v39 adds a separate **daily CTA-style trend-following family** rather than forcing slow trend trades through the 1H/4H setup rules. It uses 20/60-day momentum, EMA trend, ADX/directional movement and position within a 55-day channel. Candidate plans use wide ATR stops, 2.5R–5R targets and 30–60 daily-bar holding windows.

CTA signals use `CTA_MIN_PROBABILITY` (default 0.40) rather than the intraday setup floor because the strategy is intentionally asymmetric: it may be profitable with a win rate below 50% if average winners are several times larger than average losses. Approval remains expectancy-first and still requires positive net OOS expectancy confidence, profit factor, drawdown stability and chronological validation.

The CTA strategy currently trades only the existing ForexBot universe (FX, metals, WTI and crypto). Institutional CTA portfolios also diversify into rates and equity-index futures; those markets are not yet part of the current provider/broker symbol universe.

## Market-making feasibility

Market making is **not implemented for execution**. The current architecture polls market data and submits through an MT5 broker bridge; it does not have venue-native level-2 order-book data, queue position, colocated low-latency execution, maker rebates or reliable cancel/replace latency. A simple two-sided quoting bot in this environment would produce unrealistic backtests and would be highly exposed to adverse selection.

`GET /api/research/strategies` reports the strategy capability status and the infrastructure that would be required before market-making research could be credible. No market-making order generator exists.

## Profitability-first validation

Research v38 optimizes for **net expectancy after costs**, not a target win rate. Win rate remains visible, but plan selection, threshold recommendation, side/regime validation, and final model approval prioritize average R, profit factor, drawdown, and the 95% lower confidence bound of mean R. Final approval requires that lower expectancy bound to remain positive on the untouched chronological test window.

Historical broker bid/ask ticks are not yet available in the research store, so v38 does **not** pretend fixed spreads are broker truth. It uses conservative session- and volatility-adjusted spread/slippage estimates plus commission and a financing estimate by holding time. Configure symbol-specific financing with `FINANCING_BPS_PER_DAY_<SYMBOL>` when broker data is known.

Automatic demo dispatch also has a forward-performance guard. After `AUTO_PERFORMANCE_MIN_TRADES` monitored trades for a market/timeframe/model, broker automation pauses when recent average R or its 95% lower bound is non-positive, profit factor drops below 1, or recent R drawdown exceeds `AUTO_MAX_RECENT_DRAWDOWN_R`. Internal/shadow monitoring continues so the system can keep learning while broker dispatch is paused.

The MT5 bridge rejects an order when the live broker spread consumes too much of the planned stop or target. Use `MAX_SPREAD_STOP_RATIO` and `MAX_SPREAD_TARGET_RATIO` on the bridge host to tune those execution-cost guards.

## Signal monitoring and accuracy
The signal engine records one decision per closed candle for each supported market and monitored timeframe. The directional model first proposes LONG/SHORT only when `DIRECTIONAL_MIN_PROBABILITY` is met. A second model then estimates `P(success | confirmation entry triggers)` for the actual entry/SL/TP structure. `SIGNAL_MIN_PROBABILITY` is the minimum setup-success probability. No-entry setups expire and are not counted as losses.

The dedicated `/signals.html` page shows the current 1H/4H/1D board, price-action context, filters, historical signals, settled wins/losses, observed accuracy, and a 95% Wilson confidence interval. The broker-validation readiness gate requires a minimum settled sample and the configured empirical accuracy target; a model probability is never presented as proof of the same realized win rate.


## Broker connectivity
ForexBot now includes an HTTP client for an external MetaTrader 5 bridge. This is the broker-neutral boundary intended for Exness, XM, or another MT5 broker. Configure `MT5_BRIDGE_URL` and `MT5_BRIDGE_TOKEN` only after a bridge is running on a demo account. `GET /api/broker/status` checks bridge reachability and `POST /api/broker/demo-dispatch/:id` sends an eligible execution intent to the demo bridge.

The current service intentionally supports demo dispatch only. Live-money submission remains disabled while the monitored signal sample is accumulating and until the empirical accuracy/risk gates have been demonstrated.


## Triggered trade-plan monitoring
Current research signals now include a concrete confirmation entry, ATR-adjusted stop loss, TP1, final target, expected pips/points/ticks, and risk/reward ratio. Monitoring does not assume a trade exists immediately: a setup moves from `PENDING_ENTRY` to `ACTIVE` only after a subsequent candle reaches the predicted entry price. The engine then checks candle highs/lows against SL and TP. Setups that never reach entry expire and do not count as wins or losses.

Settled records include realized pips/points, realized R, maximum favorable excursion (MFE), and maximum adverse excursion (MAE). If both SL and TP fall inside the same candle, the monitor conservatively records SL because intrabar ordering is unknown.

## Manual broker action
The Signals page allows an explicit manual trade intent from any displayed setup, even below the automated setup-success probability gate. Manual actions are tagged separately and do not change strict-signal statistics. Broker submission uses the MT5 bridge. Demo mode can be used once the bridge URL/token are configured. Live manual dispatch is additionally gated by `ALLOW_MANUAL_LIVE=true`, broker mode `live`, an admin token, and an explicit per-order confirmation. Autonomous live-money dispatch remains disabled.


## Crypto analysis
ForexBot now analyzes `BTCUSD`, `ETHUSD`, `SOLUSD`, `XRPUSD`, and `LTCUSD` alongside forex, metals, and WTI. Crypto uses the same 1H/4H technical, price-action, news, macro-context, trade-plan, monitoring, and backtest pipeline. Expected crypto movement is displayed in USD price movement rather than using a broker-specific pip convention.

## Adjustable setup-success threshold
The Signals page includes an admin-protected setup-success threshold from 50% to 95%. The value is stored in the persistent SQLite database, so it survives deploys and can be changed without editing Railway variables. Direction selection has a separate `DIRECTIONAL_MIN_PROBABILITY` floor. Existing signal records preserve the thresholds used when they were created.

## XM MT5 demo testing
The Windows MT5 bridge supports private XM credentials through `bridge/mt5/.env`, broker symbol discovery, and a preview-before-send workflow. The XM login/password/server remain on the Windows/VPS host. ForexBot only stores the HTTPS bridge URL/token. Use demo mode first. A manual signal creates an execution intent, calls MT5 `order_check` through `/preview`, shows broker symbol/lot size/risk/entry/SL/TP, and sends the pending order only after explicit confirmation.

## Point-in-time fundamentals
Research version v8 uses ALFRED/FRED real-time vintages instead of treating today's revised macro history as if it were known in the past. `macro_vintages` stores observation date, real-time availability date, revision window and value. Historical feature generation selects only revisions available by the candle timestamp. `ALFRED_AVAILABILITY_LAG_DAYS=1` is conservative for intraday bars because FRED vintage availability is date-level rather than an exact release timestamp. Live economic-event surprise analysis remains separate and uses the current calendar feed.

## Automatic strict demo execution
`AUTO_DEMO_STRICT=true` enables automatic **demo-only** broker dispatch for signals that are already STRICT, come from an approved model, meet the configured probability threshold, pass every signal filter, and meet `AUTO_MIN_CONFLUENCE`. One automatic intent is allowed per source candle. This switch never enables live automation.

## MT5 reconciliation
Bridge v1.2 adds `GET /orders/{ticket}` and `DELETE /orders/{ticket}`. ForexBot stores broker status, fill price, close price, position ID and realized broker P/L. When `BROKER_RECONCILE_ENABLED=true`, it periodically refreshes broker tickets. Automatic pending demo orders are cancelled when their corresponding research signal expires before entry. Manual orders are not automatically cancelled by this rule.

## Two-stage probability model
The directional logistic model estimates market direction. A separate triggered-setup model is trained only on historical plans whose confirmation entry was actually reached, and predicts whether the same ATR-based stop/target structure succeeds after entry. Train/calibration/test splits are chronological and purged through the full entry-expiry plus hold window. Model approval requires the setup-success layer to beat its baseline log loss, maintain positive average R, meet the configured accuracy target with enough out-of-sample selections, and remain stable across expanding chronological folds.
