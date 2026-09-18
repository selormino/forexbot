const db=require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS signal_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  source_ts INTEGER NOT NULL,
  source_close_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  settled_at INTEGER,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candidate_direction TEXT NOT NULL,
  direction TEXT NOT NULL,
  probability REAL NOT NULL,
  directional_probability REAL NOT NULL,
  threshold REAL NOT NULL,
  price REAL NOT NULL,
  model_id INTEGER,
  horizon_bars INTEGER NOT NULL,
  cost_bps REAL NOT NULL DEFAULT 0,
  qualified INTEGER NOT NULL DEFAULT 0,
  actionable INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  price_action_json TEXT,
  entry_price REAL,
  exit_price REAL,
  gross_return REAL,
  net_return REAL,
  success INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS signal_records_recent ON signal_records(created_at DESC);
CREATE INDEX IF NOT EXISTS signal_records_pending ON signal_records(status,due_at);
CREATE INDEX IF NOT EXISTS signal_records_symbol ON signal_records(symbol,timeframe,created_at DESC);
`);

const tfMs=tf=>({'1h':3600000,'4h':14400000}[tf]||0);
const minProbability=()=>Math.max(.5,Math.min(.95,Number(process.env.SIGNAL_MIN_PROBABILITY||.70)));

function record(signal){
  const step=tfMs(signal.timeframe); if(!step||!Number.isFinite(signal.sourceCandleTs))throw new Error('Signal is missing source candle metadata');
  const horizon=Math.max(1,Number(signal.horizonBars||4));
  const threshold=Number(signal.minProbability||minProbability());
  const candidate=signal.candidateDirection||'WAIT';
  const directionalProbability=Number(signal.directionalProbability||0);
  const qualified=['LONG','SHORT'].includes(candidate)&&directionalProbability>=threshold;
  const actionable=['LONG','SHORT'].includes(signal.direction);
  const key=[signal.symbol,signal.timeframe,signal.sourceCandleTs].join(':');
  const status=qualified?'MONITORING':'FILTERED';
  const row={
    key,createdAt:Date.now(),sourceTs:signal.sourceCandleTs,sourceCloseAt:signal.sourceCandleTs+step,
    dueAt:signal.sourceCandleTs+(horizon+1)*step,symbol:signal.symbol,timeframe:signal.timeframe,
    candidate,direction:signal.direction,probability:Number(signal.probability),directionalProbability,
    threshold,price:Number(signal.price),modelId:signal.modelId||null,horizon,costBps:Number(signal.costs?.total||0),
    qualified:+qualified,actionable:+actionable,status,filters:JSON.stringify(signal.filters||[]),
    priceAction:JSON.stringify(signal.priceAction||null)
  };
  db.prepare(`INSERT OR IGNORE INTO signal_records(
    signal_key,created_at,source_ts,source_close_at,due_at,symbol,timeframe,candidate_direction,direction,
    probability,directional_probability,threshold,price,model_id,horizon_bars,cost_bps,qualified,actionable,status,filters_json,price_action_json
  ) VALUES(@key,@createdAt,@sourceTs,@sourceCloseAt,@dueAt,@symbol,@timeframe,@candidate,@direction,
    @probability,@directionalProbability,@threshold,@price,@modelId,@horizon,@costBps,@qualified,@actionable,@status,@filters,@priceAction)`).run(row);
  return db.prepare('SELECT * FROM signal_records WHERE signal_key=?').get(key);
}

function settle(limit=2000){
  const pending=db.prepare("SELECT * FROM signal_records WHERE status='MONITORING' AND due_at<=? ORDER BY due_at LIMIT ?").all(Date.now(),Math.max(1,Math.min(10000,Number(limit)||2000)));
  const update=db.prepare(`UPDATE signal_records SET settled_at=?,status='SETTLED',entry_price=?,exit_price=?,gross_return=?,net_return=?,success=?,outcome=? WHERE id=?`);
  let settled=0,wins=0;
  const tx=db.transaction(()=>{
    for(const s of pending){
      const step=tfMs(s.timeframe);
      const entry=db.prepare('SELECT open FROM candles WHERE symbol=? AND timeframe=? AND ts=?').get(s.symbol,s.timeframe,s.source_ts+step);
      const exit=db.prepare('SELECT close FROM candles WHERE symbol=? AND timeframe=? AND ts=?').get(s.symbol,s.timeframe,s.source_ts+s.horizon_bars*step);
      if(!entry||!exit)continue;
      const raw=exit.close/entry.open-1,side=s.candidate_direction==='LONG'?1:-1;
      const gross=side*raw,net=gross-s.cost_bps/10000,success=net>0?1:0;
      update.run(Date.now(),entry.open,exit.close,gross,net,success,success?'WIN':'LOSS',s.id);
      settled++;wins+=success;
    }
  }); tx();
  return {settled,wins};
}

function wilson(wins,n,z=1.96){
  if(!n)return {lower:0,upper:0};
  const p=wins/n,z2=z*z,den=1+z2/n,center=(p+z2/(2*n))/den,margin=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)/den;
  return {lower:Math.max(0,center-margin),upper:Math.min(1,center+margin)};
}
function aggregate(rows){
  const settled=rows.filter(r=>r.status==='SETTLED'),wins=settled.filter(r=>r.success===1).length;
  const ci=wilson(wins,settled.length);
  return {total:rows.length,settled:settled.length,pending:rows.filter(r=>r.status==='MONITORING').length,wins,losses:settled.length-wins,
    accuracy:settled.length?wins/settled.length:null,confidence95:ci,
    averageProbability:settled.length?settled.reduce((s,r)=>s+r.directional_probability,0)/settled.length:null};
}
function metrics(){
  const qualified=db.prepare('SELECT * FROM signal_records WHERE qualified=1 ORDER BY created_at').all();
  const actionable=qualified.filter(r=>r.actionable===1);
  const groups={};
  for(const r of qualified){const k=r.symbol+':'+r.timeframe;(groups[k]||(groups[k]=[])).push(r);}
  return {
    targetAccuracy:Number(process.env.SIGNAL_TARGET_ACCURACY||.70),
    minProbability:minProbability(),
    qualified:aggregate(qualified),
    actionable:aggregate(actionable),
    bySeries:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,aggregate(v)])),
    readyForBrokerValidation:aggregate(qualified).settled>=Number(process.env.SIGNAL_MIN_SETTLED||50)&&(aggregate(qualified).accuracy||0)>=Number(process.env.SIGNAL_TARGET_ACCURACY||.70)&&aggregate(qualified).confidence95.lower>=Number(process.env.SIGNAL_MIN_CONFIDENCE_LOWER||.60)
  };
}
function history(limit=250){
  return db.prepare(`SELECT id,created_at,source_close_at,due_at,settled_at,symbol,timeframe,candidate_direction,direction,
    directional_probability,threshold,price,model_id,qualified,actionable,status,entry_price,exit_price,net_return,success,outcome,
    filters_json,price_action_json FROM signal_records ORDER BY id DESC LIMIT ?`).all(Math.max(1,Math.min(2000,Number(limit)||250)))
    .map(r=>({...r,filters:JSON.parse(r.filters_json||'[]'),priceAction:JSON.parse(r.price_action_json||'null'),filters_json:undefined,price_action_json:undefined}));
}
module.exports={record,settle,metrics,history,minProbability,wilson};
