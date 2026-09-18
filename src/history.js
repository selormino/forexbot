const db = require('./db');
const { SYMBOLS, historicalCandles, providerStatus } = require('./providers');
const { features } = require('./analysis');

const DEFAULT_TIMEFRAMES = (process.env.HISTORICAL_TIMEFRAMES || '1h,4h').split(',').map(x => x.trim()).filter(Boolean);
const MAX_BARS = Math.max(250, Math.min(5000, Number(process.env.HISTORICAL_BARS || 1500)));
const HORIZON = Math.max(1, Number(process.env.LABEL_HORIZON_BARS || 4));
const MIN_MOVE_BPS = Math.max(0, Number(process.env.LABEL_MIN_MOVE_BPS || 3));
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.HISTORY_REQUEST_DELAY_MS || 8500));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function featureVector(candles, index) {
  const window = candles.slice(Math.max(0, index - 119), index + 1);
  if (window.length < 60) return null;
  const f = features(window);
  if (![f.price, f.ema20, f.ema50, f.rsi, f.atr].every(Number.isFinite)) return null;
  const scale = f.atr || f.price * 0.001;
  return [
    Math.tanh(((f.ema20 - f.ema50) / scale) * 0.25),
    (f.rsi - 50) / 50,
    Math.tanh((f.macd - f.signal) / scale),
    (f.price - f.bbLower) / Math.max(1e-9, f.bbUpper - f.bbLower) - 0.5,
    0,
    0
  ];
}

function rebuildObservations(symbol, timeframe, horizon = HORIZON) {
  const rows = db.prepare('SELECT ts,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY ts').all(symbol, timeframe);
  const insert = db.prepare(`INSERT INTO observations(symbol,ts,features,label,price,timeframe,horizon,feature_version)
    VALUES(?,?,?,?,?,?,?,'technical-v1')
    ON CONFLICT(symbol,timeframe,ts,horizon) DO UPDATE SET features=excluded.features,label=excluded.label,price=excluded.price,feature_version=excluded.feature_version`);
  let written = 0;
  const threshold = MIN_MOVE_BPS / 10000;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM observations WHERE symbol=? AND timeframe=? AND horizon=?').run(symbol, timeframe, horizon);
    for (let i = 59; i + horizon < rows.length; i++) {
      const x = featureVector(rows, i);
      if (!x) continue;
      const futureReturn = rows[i + horizon].close / rows[i].close - 1;
      if (Math.abs(futureReturn) < threshold) continue;
      insert.run(symbol, rows[i].ts, JSON.stringify(x), futureReturn > 0 ? 1 : 0, rows[i].close, timeframe, horizon);
      written++;
    }
  });
  tx();
  return written;
}

async function ingestOne(symbol, timeframe, options = {}) {
  if (!SYMBOLS.includes(symbol)) throw new Error(`Unsupported symbol: ${symbol}`);
  const startedAt = Date.now();
  const run = db.prepare(`INSERT INTO ingestion_runs(started_at,symbol,timeframe,provider,status)
    VALUES(?,?,?,?,?)`).run(startedAt, symbol, timeframe, providerStatus().market, 'RUNNING');
  try {
    const latest = db.prepare('SELECT MAX(ts) ts FROM candles WHERE symbol=? AND timeframe=?').get(symbol, timeframe)?.ts || null;
    const fetched = await historicalCandles(symbol, timeframe, {
      outputsize: Number(options.outputsize || MAX_BARS),
      startTime: latest || null
    });
    const insert = db.prepare(`INSERT INTO candles(symbol,timeframe,ts,open,high,low,close,volume,provider,ingested_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(symbol,timeframe,ts) DO UPDATE SET
      open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,provider=excluded.provider,ingested_at=excluded.ingested_at`);
    let upserted = 0;
    const tx = db.transaction(() => {
      for (const c of fetched) {
        const r = insert.run(symbol, timeframe, c.time, c.open, c.high, c.low, c.close, c.volume || 0, c.provider || providerStatus().market, Date.now());
        upserted += r.changes;
      }
    });
    tx();
    const observations = rebuildObservations(symbol, timeframe, Number(options.horizon || HORIZON));
    db.prepare(`UPDATE ingestion_runs SET finished_at=?,fetched=?,inserted=?,observations=?,status='SUCCESS' WHERE id=?`)
      .run(Date.now(), fetched.length, upserted, observations, run.lastInsertRowid);
    return { symbol, timeframe, latestBefore: latest, fetched: fetched.length, upserted, observations, status: 'SUCCESS' };
  } catch (error) {
    db.prepare(`UPDATE ingestion_runs SET finished_at=?,status='FAILED',error=? WHERE id=?`).run(Date.now(), String(error.message).slice(0, 1000), run.lastInsertRowid);
    throw error;
  }
}

async function syncHistory({ symbols = SYMBOLS, timeframes = DEFAULT_TIMEFRAMES, outputsize = MAX_BARS } = {}) {
  const results = [];
  let requestIndex = 0;
  const totalRequests = symbols.length * timeframes.length;
  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      try { results.push(await ingestOne(symbol, timeframe, { outputsize })); }
      catch (error) { results.push({ symbol, timeframe, status: 'FAILED', error: error.message }); }
      requestIndex++;
      if (requestIndex < totalRequests && REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
    }
  }
  return results;
}

function status() {
  return {
    totals: db.prepare(`SELECT COUNT(*) candles,COUNT(DISTINCT symbol||':'||timeframe) series,MIN(ts) oldest,MAX(ts) newest FROM candles`).get(),
    observations: db.prepare('SELECT COUNT(*) total,SUM(CASE WHEN label IS NOT NULL THEN 1 ELSE 0 END) labeled FROM observations').get(),
    series: db.prepare(`SELECT symbol,timeframe,COUNT(*) candles,MIN(ts) oldest,MAX(ts) newest FROM candles GROUP BY symbol,timeframe ORDER BY symbol,timeframe`).all(),
    runs: db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 30').all()
  };
}

module.exports = { ingestOne, syncHistory, rebuildObservations, status, featureVector, DEFAULT_TIMEFRAMES };
