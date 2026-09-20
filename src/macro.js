const axios=require('axios');
const db=require('./db');

const SERIES={
  FEDFUNDS:'Federal funds rate',
  CPIAUCSL:'US consumer price index',
  UNRATE:'US unemployment rate',
  GDPC1:'US real GDP',
  DGS10:'US 10-year Treasury yield',
  DEXUSEU:'US dollar per euro',
  DEXUSUK:'US dollar per pound',
  DEXJPUS:'Japanese yen per US dollar'
};
const CORE_SERIES=['FEDFUNDS','CPIAUCSL','UNRATE','GDPC1','DGS10'];

db.exec(`
CREATE TABLE IF NOT EXISTS macro_vintages(
  series_id TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  realtime_start TEXT NOT NULL,
  realtime_end TEXT,
  value REAL NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY(series_id,observation_date,realtime_start)
);
CREATE INDEX IF NOT EXISTS macro_vintages_asof
  ON macro_vintages(series_id,realtime_start,observation_date);
`);

const day=x=>{
  const d=x instanceof Date?x:new Date(Number.isFinite(Number(x))?Number(x):x);
  if(Number.isNaN(d.getTime()))throw new Error('Invalid as-of date');
  return d.toISOString().slice(0,10);
};

async function fred(path,params){
  if(!process.env.FRED_API_KEY)throw new Error('FRED_API_KEY is not configured');
  const r=await axios.get('https://api.stlouisfed.org/fred/'+path,{
    params:{...params,api_key:process.env.FRED_API_KEY,file_type:'json'},
    timeout:30000
  });
  return r.data||{};
}

async function fetchSeries(seriesId,startDate){
  const data=await fred('series/observations',{
    series_id:seriesId,sort_order:'asc',...(startDate?{observation_start:startDate}:{})
  });
  return (data.observations||[])
    .filter(x=>x.value!=='.'&&Number.isFinite(Number(x.value)))
    .map(x=>({seriesId,date:x.date,value:Number(x.value)}));
}

async function fetchVintageChanges(seriesId,{startDate=process.env.ALFRED_START_DATE||'2000-01-01',endDate=day(Date.now())}={}){
  const data=await fred('series/observations',{
    series_id:seriesId,
    output_type:3,
    realtime_start:startDate,
    realtime_end:endDate,
    observation_start:startDate,
    observation_end:endDate,
    sort_order:'asc',
    limit:100000
  });
  return (data.observations||[])
    .filter(x=>x.value!=='.'&&Number.isFinite(Number(x.value))&&x.realtime_start)
    .map(x=>({
      seriesId,
      observationDate:x.date,
      realtimeStart:x.realtime_start,
      realtimeEnd:x.realtime_end||null,
      value:Number(x.value)
    }));
}

async function syncMacro(seriesIds=Object.keys(SERIES)){
  const insert=db.prepare(`INSERT INTO macro_observations(series_id,observation_date,value,ingested_at)
    VALUES(?,?,?,?) ON CONFLICT(series_id,observation_date)
    DO UPDATE SET value=excluded.value,ingested_at=excluded.ingested_at`);
  const results=[];
  for(const seriesId of seriesIds){
    try{
      const latest=db.prepare('SELECT MAX(observation_date) date FROM macro_observations WHERE series_id=?').get(seriesId)?.date;
      const rows=await fetchSeries(seriesId,latest||'2000-01-01');
      db.transaction(()=>rows.forEach(x=>insert.run(x.seriesId,x.date,x.value,Date.now())))();
      results.push({seriesId,name:SERIES[seriesId]||seriesId,fetched:rows.length,status:'SUCCESS'});
    }catch(error){
      results.push({seriesId,name:SERIES[seriesId]||seriesId,status:'FAILED',error:error.message});
    }
  }
  return results;
}

async function syncPointInTimeMacro(seriesIds=CORE_SERIES,options={}){
  const insert=db.prepare(`INSERT INTO macro_vintages(series_id,observation_date,realtime_start,realtime_end,value,ingested_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(series_id,observation_date,realtime_start)
    DO UPDATE SET realtime_end=excluded.realtime_end,value=excluded.value,ingested_at=excluded.ingested_at`);
  const results=[];
  for(const seriesId of seriesIds){
    try{
      const rows=await fetchVintageChanges(seriesId,options);
      const now=Date.now();
      db.transaction(()=>rows.forEach(x=>insert.run(x.seriesId,x.observationDate,x.realtimeStart,x.realtimeEnd,x.value,now)))();
      const coverage=db.prepare(`SELECT COUNT(*) revisions,MIN(realtime_start) oldestKnown,MAX(realtime_start) newestKnown
        FROM macro_vintages WHERE series_id=?`).get(seriesId);
      results.push({seriesId,name:SERIES[seriesId]||seriesId,fetched:rows.length,...coverage,status:'SUCCESS'});
    }catch(error){
      results.push({seriesId,name:SERIES[seriesId]||seriesId,status:'FAILED',error:error.message});
    }
  }
  return results;
}

function pointInTimeSeries(seriesId,at=Date.now(),limit=14){
  const asOf=day(at),n=Math.max(1,Math.min(100,Number(limit)||14));
  return db.prepare(`
    SELECT v.series_id,v.observation_date,v.realtime_start,v.realtime_end,v.value
    FROM macro_vintages v
    WHERE v.series_id=?
      AND v.observation_date<=?
      AND v.realtime_start<=?
      AND v.realtime_start=(
        SELECT MAX(v2.realtime_start)
        FROM macro_vintages v2
        WHERE v2.series_id=v.series_id
          AND v2.observation_date=v.observation_date
          AND v2.realtime_start<=?
      )
    ORDER BY v.observation_date DESC
    LIMIT ?`).all(seriesId,asOf,asOf,asOf,n);
}

function pointInTimeContext(at=Date.now(),seriesIds=CORE_SERIES){
  const values={};
  for(const id of seriesIds){
    const rows=pointInTimeSeries(id,at,14);
    if(rows.length){
      const first=rows[0],prior=rows[1];
      values[id]={
        level:first.value,
        change:prior&&Number.isFinite(prior.value)&&prior.value!==0?first.value/prior.value-1:0,
        observationDate:first.observation_date,
        knownAt:first.realtime_start
      };
    }
  }
  return values;
}

function macroStatus(){
  return db.prepare(`SELECT m.series_id,m.observations,m.oldest,m.newest,
      COALESCE(v.vintages,0) vintages,v.oldest_known,v.newest_known
    FROM (
      SELECT series_id,COUNT(*) observations,MIN(observation_date) oldest,MAX(observation_date) newest
      FROM macro_observations GROUP BY series_id
    ) m
    LEFT JOIN (
      SELECT series_id,COUNT(*) vintages,MIN(realtime_start) oldest_known,MAX(realtime_start) newest_known
      FROM macro_vintages GROUP BY series_id
    ) v ON v.series_id=m.series_id
    ORDER BY m.series_id`).all().map(x=>({...x,name:SERIES[x.series_id]||x.series_id}));
}

function vintageStatus(){
  return db.prepare(`SELECT series_id,COUNT(*) vintages,COUNT(DISTINCT observation_date) observations,
    MIN(realtime_start) oldestKnown,MAX(realtime_start) newestKnown
    FROM macro_vintages GROUP BY series_id ORDER BY series_id`).all()
    .map(x=>({...x,name:SERIES[x.series_id]||x.series_id}));
}

module.exports={SERIES,CORE_SERIES,fetchSeries,fetchVintageChanges,syncMacro,syncPointInTimeMacro,pointInTimeSeries,pointInTimeContext,macroStatus,vintageStatus};
