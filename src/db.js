const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/forexbot.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  provider TEXT,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY(symbol, timeframe, ts)
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  features TEXT NOT NULL,
  label INTEGER,
  price REAL
);
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  model_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry REAL NOT NULL,
  stop REAL,
  target REAL,
  units REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  pnl REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  provider TEXT,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS macro_observations (
  series_id TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  value REAL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY(series_id, observation_date)
);
`);

function addColumn(table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
  if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
addColumn('observations', "timeframe TEXT NOT NULL DEFAULT '1h'");
addColumn('observations', 'horizon INTEGER NOT NULL DEFAULT 4');
addColumn('observations', "feature_version TEXT NOT NULL DEFAULT 'technical-v1'");
db.exec(`
DELETE FROM observations WHERE id NOT IN (
  SELECT MIN(id) FROM observations GROUP BY symbol, timeframe, ts, horizon
);
CREATE UNIQUE INDEX IF NOT EXISTS observations_unique
  ON observations(symbol, timeframe, ts, horizon);
CREATE INDEX IF NOT EXISTS candles_lookup ON candles(symbol, timeframe, ts);
CREATE INDEX IF NOT EXISTS ingestion_runs_recent ON ingestion_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS macro_series_date ON macro_observations(series_id, observation_date);
`);

module.exports = db;
