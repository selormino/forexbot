# ForexBot AI

AI-assisted forex and commodities analysis platform. It combines market prices, technical features, macro/economic events, news sentiment and a trainable probabilistic model to produce transparent trading signals.

## Important
This project is an analytical and paper-trading system. Predictions are probabilities, not guarantees. Live trading is disabled by default and should only be enabled after independent validation, broker testing, risk controls and regulatory review.

## Core features
- FX and commodity watchlists
- Technical indicators: EMA, RSI, MACD, ATR, Bollinger Bands
- Economic calendar/event-risk layer
- News ingestion adapter
- Explainable multi-factor signal scoring
- Trainable logistic model with walk-forward backtesting
- SQLite feature/trade/model store
- Paper trading ledger
- Optional OANDA execution adapter (disabled by default)
- Sleek responsive dashboard
- Railway-ready Node.js deployment

## Data providers
The app supports provider adapters via environment variables. It runs in demo mode without credentials so the UI can be tested immediately.

Suggested production providers:
- Twelve Data / Alpha Vantage / Polygon for market data
- Finnhub / NewsAPI for news
- FRED or another macro provider for economic series
- OANDA for optional execution

## Environment
Copy `.env.example` to `.env` and configure only the providers you use.

## Run
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Railway
Connect this repository to Railway and deploy the `main` branch. Railway can automatically build and deploy a GitHub repository; generate a public domain after deployment.

## Model training
The `/api/model/train` endpoint trains on stored feature/label rows. The platform includes walk-forward evaluation and stores model metrics so future versions can be compared rather than blindly promoted.
