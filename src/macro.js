const axios = require('axios');
const db = require('./db');

const SERIES = {
  FEDFUNDS: 'Federal funds rate',
  CPIAUCSL: 'US consumer price index',
  UNRATE: 'US unemployment rate',
  GDPC1: 'US real GDP',
  DGS10: 'US 10-year Treasury yield',
  DEXUSEU: 'US dollar per euro',
  DEXUSUK: 'US dollar per pound',
  DEXJPUS: 'Japanese yen per US dollar'
};

async function fetchSeries(seriesId, startDate) {
  if (!process.env.FRED_API_KEY) throw new Error('FRED_API_KEY is not configured');
  const params = { series_id: seriesId, api_key: process.env.FRED_API_KEY, file_type: 'json', sort_order: 'asc' };
  if (startDate) params.observation_start = startDate;
  const response = await axios.get('https://api.stlouisfed.org/fred/series/observations', { params, timeout: 20000 });
  return (response.data?.observations || [])
    .filter(x => x.value !== '.' && Number.isFinite(Number(x.value)))
    .map(x => ({ seriesId, date: x.date, value: Number(x.value) }));
}

async function syncMacro(seriesIds = Object.keys(SERIES)) {
  const insert = db.prepare(`INSERT INTO macro_observations(series_id,observation_date,value,ingested_at)
    VALUES(?,?,?,?) ON CONFLICT(series_id,observation_date) DO UPDATE SET value=excluded.value,ingested_at=excluded.ingested_at`);
  const results = [];
  for (const seriesId of seriesIds) {
    try {
      const latest = db.prepare('SELECT MAX(observation_date) date FROM macro_observations WHERE series_id=?').get(seriesId)?.date;
      const rows = await fetchSeries(seriesId, latest || '2000-01-01');
      const tx = db.transaction(() => rows.forEach(x => insert.run(x.seriesId, x.date, x.value, Date.now())));
      tx();
      results.push({ seriesId, name: SERIES[seriesId] || seriesId, fetched: rows.length, status: 'SUCCESS' });
    } catch (error) {
      results.push({ seriesId, name: SERIES[seriesId] || seriesId, status: 'FAILED', error: error.message });
    }
  }
  return results;
}

function macroStatus() {
  return db.prepare(`SELECT series_id,COUNT(*) observations,MIN(observation_date) oldest,MAX(observation_date) newest
    FROM macro_observations GROUP BY series_id ORDER BY series_id`).all().map(x => ({ ...x, name: SERIES[x.series_id] || x.series_id }));
}

module.exports = { SERIES, syncMacro, macroStatus };
