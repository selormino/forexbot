const db=require('./db');
const {distanceUnits}=require('./tradePlan');
const {signalMinProbability}=require('./settings');

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
function addColumn(name,def){const cols=db.prepare('PRAGMA table_info(signal_records)').all().map(x=>x.name);if(!cols.includes(name))db.exec(`ALTER TABLE signal_records ADD COLUMN ${name} ${def}`);}
addColumn('lean_direction',"TEXT");
addColumn('plan_json',"TEXT");
addColumn('analysis_json',"TEXT");
addColumn('entry_triggered_at',"INTEGER");
addColumn('entry_expiry_bars',"INTEGER NOT NULL DEFAULT 4");
addColumn('hold_bars',"INTEGER NOT NULL DEFAULT 6");
addColumn('stop_price',"REAL");
addColumn('target_price',"REAL");
addColumn('tp1_price',"REAL");
addColumn('stop_pips',"REAL");
addColumn('target_pips',"REAL");
addColumn('unit_label',"TEXT");
addColumn('outcome_pips',"REAL");
addColumn('realized_r',"REAL");
addColumn('mfe_pips',"REAL");
addColumn('mae_pips',"REAL");
addColumn('setup_probability',"REAL");
addColumn('directional_min_probability',"REAL");
addColumn('model_version',"TEXT");
addColumn('setup_probability',"REAL");
addColumn('directional_min_probability',"REAL");

const tfMs=tf=>({'1h':3600000,'4h':14400000}[tf]||0);
const minProbability=()=>signalMinProbability();

function record(signal){
  const step=tfMs(signal.timeframe);if(!step||!Number.isFinite(signal.sourceCandleTs))throw new Error('Signal is missing source candle metadata');
  const plan=signal.tradePlan;if(!plan)throw new Error('Signal is missing trade plan');
  const threshold=Number(signal.minProbability||minProbability()),directionalProbability=Number(signal.directionalProbability||0);
  const rawSetupProbability=signal.setupProbability,setupProbability=rawSetupProbability===null||rawSetupProbability===undefined?null:Number(rawSetupProbability);
  const directionalFloor=Number(signal.directionalMinProbability||process.env.DIRECTIONAL_MIN_PROBABILITY||.55);
  const lean=signal.leanDirection||signal.candidateDirection||'WAIT';
  const qualified=['LONG','SHORT'].includes(signal.candidateDirection)&&Number.isFinite(setupProbability)&&setupProbability>=threshold&&directionalProbability>=directionalFloor;
  const actionable=['LONG','SHORT'].includes(signal.direction);
  const modelVersion=String(signal.modelVersion||'legacy');
  const key=[signal.symbol,signal.timeframe,signal.sourceCandleTs,modelVersion].join(':');
  const status=qualified?'PENDING_ENTRY':'FILTERED';
  const dueAt=signal.sourceCandleTs+(1+plan.entryExpiryBars+plan.holdBars)*step;
  const row={
    key,createdAt:Date.now(),sourceTs:signal.sourceCandleTs,sourceCloseAt:signal.sourceCandleTs+step,dueAt,
    symbol:signal.symbol,timeframe:signal.timeframe,candidate:signal.candidateDirection||'WAIT',direction:signal.direction,
    lean,probability:Number(signal.probability),directionalProbability,setupProbability:Number.isFinite(setupProbability)?setupProbability:null,directionalFloor,threshold,price:Number(signal.price),modelId:signal.modelId||null,modelVersion,
    horizon:Number(signal.horizonBars||4),costBps:Number(signal.costs?.total||0),qualified:+qualified,actionable:+actionable,status,
    filters:JSON.stringify(signal.filters||[]),priceAction:JSON.stringify(signal.priceAction||null),plan:JSON.stringify(plan),analysis:JSON.stringify(signal.analysis||null),
    entry:plan.entry,stop:plan.stop,target:plan.target,tp1:plan.tp1,stopPips:plan.stopPips,targetPips:plan.targetPips,unitLabel:plan.unitLabel,
    entryExpiryBars:plan.entryExpiryBars,holdBars:plan.holdBars
  };
  db.prepare(`INSERT OR IGNORE INTO signal_records(
    signal_key,created_at,source_ts,source_close_at,due_at,symbol,timeframe,candidate_direction,direction,lean_direction,
    probability,directional_probability,threshold,price,model_id,horizon_bars,cost_bps,qualified,actionable,status,filters_json,price_action_json,
    plan_json,analysis_json,entry_price,stop_price,target_price,tp1_price,stop_pips,target_pips,unit_label,entry_expiry_bars,hold_bars,setup_probability,directional_min_probability,model_version
  ) VALUES(@key,@createdAt,@sourceTs,@sourceCloseAt,@dueAt,@symbol,@timeframe,@candidate,@direction,@lean,
    @probability,@directionalProbability,@threshold,@price,@modelId,@horizon,@costBps,@qualified,@actionable,@status,@filters,@priceAction,
    @plan,@analysis,@entry,@stop,@target,@tp1,@stopPips,@targetPips,@unitLabel,@entryExpiryBars,@holdBars,@setupProbability,@directionalFloor,@modelVersion)`).run(row);
  return db.prepare('SELECT * FROM signal_records WHERE signal_key=?').get(key);
}

function hit(row,bar){
  const long=row.lean_direction==='LONG';
  const entryHit=long?bar.high>=row.entry_price:bar.low<=row.entry_price;
  const stopHit=long?bar.low<=row.stop_price:bar.high>=row.stop_price;
  const targetHit=long?bar.high>=row.target_price:bar.low<=row.target_price;
  return {entryHit,stopHit,targetHit};
}
function updateMfeMae(row,bars){
  const side=row.lean_direction==='LONG'?1:-1,entry=row.entry_price;
  let mfe=0,mae=0;
  for(const b of bars){
    const favorable=side===1?b.high-entry:entry-b.low;
    const adverse=side===1?entry-b.low:b.high-entry;
    mfe=Math.max(mfe,favorable);mae=Math.max(mae,adverse);
  }
  return {mfePips:distanceUnits(row.symbol,entry,entry+side*mfe),maePips:distanceUnits(row.symbol,entry,entry-side*mae)};
}
function finalize(row,outcome,exitPrice,settledAt,bars){
  const side=row.lean_direction==='LONG'?1:-1,raw=side*(exitPrice/row.entry_price-1),net=raw-row.cost_bps/10000;
  const success=['TP','TIMEOUT_WIN'].includes(outcome)?1:0;
  const outcomePips=side*distanceUnits(row.symbol,row.entry_price,exitPrice)*(exitPrice>=row.entry_price?1:-1);
  const realizedR=(side*(exitPrice-row.entry_price))/Math.max(Math.abs(row.entry_price-row.stop_price),1e-12);
  const mm=updateMfeMae(row,bars);
  db.prepare(`UPDATE signal_records SET settled_at=?,status='SETTLED',exit_price=?,gross_return=?,net_return=?,success=?,outcome=?,outcome_pips=?,realized_r=?,mfe_pips=?,mae_pips=? WHERE id=?`)
    .run(settledAt,exitPrice,raw,net,success,outcome,outcomePips,realizedR,mm.mfePips,mm.maePips,row.id);
  return success;
}
function advance(limit=3000){
  const rows=db.prepare("SELECT * FROM signal_records WHERE status IN ('PENDING_ENTRY','ACTIVE') ORDER BY id LIMIT ?").all(Math.max(1,Math.min(10000,Number(limit)||3000)));
  let triggered=0,expired=0,settled=0,wins=0;
  const tx=db.transaction(()=>{
    for(let row of rows){
      const after=db.prepare('SELECT ts,open,high,low,close FROM candles WHERE symbol=? AND timeframe=? AND ts>? ORDER BY ts LIMIT ?')
        .all(row.symbol,row.timeframe,row.source_ts,row.entry_expiry_bars+row.hold_bars+2);
      if(!after.length)continue;
      if(row.status==='PENDING_ENTRY'){
        const expirySlice=after.slice(0,row.entry_expiry_bars);
        let triggerIndex=-1;
        for(let i=0;i<expirySlice.length;i++){if(hit(row,expirySlice[i]).entryHit){triggerIndex=i;break;}}
        if(triggerIndex<0){
          if(after.length>=row.entry_expiry_bars){
            db.prepare("UPDATE signal_records SET status='EXPIRED',settled_at=?,outcome='NO_ENTRY' WHERE id=?").run(Date.now(),row.id);expired++;
          }
          continue;
        }
        const triggerBar=after[triggerIndex];
        db.prepare("UPDATE signal_records SET status='ACTIVE',entry_triggered_at=? WHERE id=?").run(triggerBar.ts,row.id);
        row={...row,status:'ACTIVE',entry_triggered_at:triggerBar.ts};triggered++;
      }
      const all=db.prepare('SELECT ts,open,high,low,close FROM candles WHERE symbol=? AND timeframe=? AND ts>=? ORDER BY ts LIMIT ?')
        .all(row.symbol,row.timeframe,row.entry_triggered_at,row.hold_bars);
      if(!all.length)continue;
      let outcome=null,exitPrice=null,endIndex=-1;
      for(let i=0;i<all.length;i++){
        const h=hit(row,all[i]);
        if(h.stopHit&&h.targetHit){outcome='SL';exitPrice=row.stop_price;endIndex=i;break;}
        if(h.stopHit){outcome='SL';exitPrice=row.stop_price;endIndex=i;break;}
        if(h.targetHit){outcome='TP';exitPrice=row.target_price;endIndex=i;break;}
      }
      if(!outcome&&all.length>=row.hold_bars){
        const last=all[all.length-1],side=row.lean_direction==='LONG'?1:-1;
        const net=side*(last.close/row.entry_price-1)-row.cost_bps/10000;
        outcome=net>0?'TIMEOUT_WIN':'TIMEOUT_LOSS';exitPrice=last.close;endIndex=all.length-1;
      }
      if(outcome){const success=finalize(row,outcome,exitPrice,all[endIndex].ts,all.slice(0,endIndex+1));settled++;wins+=success;}
    }
  });tx();
  return {triggered,expired,settled,wins};
}
function settle(limit=3000){return advance(limit);}

function wilson(wins,n,z=1.96){if(!n)return {lower:0,upper:0};const p=wins/n,z2=z*z,den=1+z2/n,center=(p+z2/(2*n))/den,margin=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)/den;return {lower:Math.max(0,center-margin),upper:Math.min(1,center+margin)};}
function aggregate(rows){
  const settled=rows.filter(r=>r.status==='SETTLED'),wins=settled.filter(r=>r.success===1).length,ci=wilson(wins,settled.length);
  const tp=settled.filter(r=>r.outcome==='TP').length,sl=settled.filter(r=>r.outcome==='SL').length;
  return {total:rows.length,pendingEntry:rows.filter(r=>r.status==='PENDING_ENTRY').length,active:rows.filter(r=>r.status==='ACTIVE').length,
    expired:rows.filter(r=>r.status==='EXPIRED').length,settled:settled.length,wins,losses:settled.length-wins,tp,sl,
    accuracy:settled.length?wins/settled.length:null,confidence95:ci,
    averageProbability:settled.length?settled.reduce((s,r)=>s+Number(r.setup_probability??r.directional_probability),0)/settled.length:null,
    averageR:settled.length?settled.reduce((s,r)=>s+Number(r.realized_r||0),0)/settled.length:null};
}
function currentVersion(){return db.prepare('SELECT version FROM research_models ORDER BY id DESC LIMIT 1').get()?.version||null;}
function metrics(){
  const version=currentVersion();
  const qualified=version?db.prepare('SELECT * FROM signal_records WHERE qualified=1 AND model_version=? ORDER BY created_at').all(version):[],actionable=qualified.filter(r=>r.actionable===1),groups={};
  for(const r of qualified){const k=r.symbol+':'+r.timeframe;(groups[k]||(groups[k]=[])).push(r);}
  const q=aggregate(qualified);
  return {targetAccuracy:Number(process.env.SIGNAL_TARGET_ACCURACY||.70),minProbability:minProbability(),qualified:q,actionable:aggregate(actionable),
    bySeries:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,aggregate(v)])),
    readyForBrokerValidation:q.settled>=Number(process.env.SIGNAL_MIN_SETTLED||50)&&(q.accuracy||0)>=Number(process.env.SIGNAL_TARGET_ACCURACY||.70)&&q.confidence95.lower>=Number(process.env.SIGNAL_MIN_CONFIDENCE_LOWER||.60)};
}
function history(limit=300){
  const version=currentVersion();if(!version)return [];
  return db.prepare('SELECT * FROM signal_records WHERE model_version=? ORDER BY id DESC LIMIT ?').all(version,Math.max(1,Math.min(2000,Number(limit)||300))).map(r=>({
    ...r,filters:JSON.parse(r.filters_json||'[]'),priceAction:JSON.parse(r.price_action_json||'null'),plan:JSON.parse(r.plan_json||'null'),analysis:JSON.parse(r.analysis_json||'null'),
    filters_json:undefined,price_action_json:undefined,plan_json:undefined,analysis_json:undefined
  }));
}
module.exports={record,advance,settle,metrics,history,minProbability,wilson};
