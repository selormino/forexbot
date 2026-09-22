const db=require('./db');
const {planTrade}=require('./risk');

db.exec(`
CREATE TABLE IF NOT EXISTS execution_intents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,
  entry REAL NOT NULL,
  stop REAL NOT NULL,
  target REAL NOT NULL,
  units REAL NOT NULL,
  probability REAL,
  model_id INTEGER,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reason TEXT,
  broker_order_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_intents_recent ON execution_intents(created_at DESC);
`);
function addExecColumn(name,def){const cols=db.prepare('PRAGMA table_info(execution_intents)').all().map(x=>x.name);if(!cols.includes(name))db.exec(`ALTER TABLE execution_intents ADD COLUMN ${name} ${def}`);}
addExecColumn('risk_pct','REAL');
addExecColumn('sizing_mode',"TEXT");
addExecColumn('manual','INTEGER NOT NULL DEFAULT 0');
addExecColumn('source_ts','INTEGER');
addExecColumn('signal_key','TEXT');
addExecColumn('confluence','REAL');
addExecColumn('broker_status','TEXT');
addExecColumn('broker_fill_price','REAL');
addExecColumn('broker_close_price','REAL');
addExecColumn('broker_profit','REAL');
addExecColumn('broker_position_id','TEXT');
addExecColumn('broker_updated_at','INTEGER');
addExecColumn('broker_payload_json','TEXT');

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS execution_auto_signal_unique
  ON execution_intents(signal_key) WHERE signal_key IS NOT NULL AND manual=0;
CREATE INDEX IF NOT EXISTS execution_broker_tracking
  ON execution_intents(broker_order_id,broker_status);
`);

const mode=()=>String(process.env.EXECUTION_MODE||'off').toLowerCase();
function summarizePerformance(rows){
  const rs=(rows||[]).map(r=>Number(r.realized_r??r.realizedR)).filter(Number.isFinite);
  const n=rs.length;
  if(!n)return {samples:0,averageR:null,expectancyLower95:null,profitFactorR:null,maxDrawdownR:0};
  const averageR=rs.reduce((a,b)=>a+b,0)/n;
  const variance=n>1?rs.reduce((a,v)=>a+(v-averageR)**2,0)/(n-1):0;
  const expectancyLower95=averageR-1.96*Math.sqrt(variance/n);
  const gains=rs.reduce((a,v)=>a+Math.max(0,v),0),losses=rs.reduce((a,v)=>a+Math.max(0,-v),0);
  let equity=0,peak=0,maxDrawdownR=0;
  for(const r of rs.slice().reverse()){equity+=r;peak=Math.max(peak,equity);maxDrawdownR=Math.max(maxDrawdownR,peak-equity);}
  return {samples:n,averageR,expectancyLower95,profitFactorR:losses?gains/losses:null,maxDrawdownR};
}
function performanceGuard(signal){
  if(process.env.AUTO_PERFORMANCE_GUARD==='false')return {allowed:true,enabled:false,reason:'Performance guard disabled'};
  const exists=db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='signal_records'").get();
  if(!exists)return {allowed:true,enabled:true,reason:'No monitored signal history yet'};
  const minTrades=Math.max(10,Number(process.env.AUTO_PERFORMANCE_MIN_TRADES||20));
  const lookback=Math.max(minTrades,Math.min(200,Number(process.env.AUTO_PERFORMANCE_LOOKBACK||30)));
  const version=String(signal.modelVersion||'');
  const rows=db.prepare(`SELECT realized_r FROM signal_records
    WHERE qualified=1 AND status='SETTLED' AND symbol=? AND timeframe=? AND (?='' OR model_version=?)
      AND realized_r IS NOT NULL ORDER BY settled_at DESC,id DESC LIMIT ?`)
    .all(signal.symbol,signal.timeframe||'1h',version,version,lookback);
  const stats=summarizePerformance(rows);
  if(stats.samples<minTrades)return {allowed:true,enabled:true,collecting:true,minTrades,...stats,reason:`Collecting performance sample (${stats.samples}/${minTrades})`};
  let maxDrawdownR=Math.max(1,Number(process.env.AUTO_MAX_RECENT_DRAWDOWN_R||4));
  try{
    const modelRow=db.prepare("SELECT report FROM research_models WHERE symbol=? AND timeframe=? AND (?='' OR version=?) ORDER BY id DESC LIMIT 1").get(signal.symbol,signal.timeframe||'1h',version,version);
    const historical=Number(JSON.parse(modelRow?.report||'{}')?.setupProbability?.maxDrawdownR);
    if(Number.isFinite(historical)&&!process.env.AUTO_MAX_RECENT_DRAWDOWN_R)maxDrawdownR=Math.max(3,historical*1.25);
  }catch{}
  const failures=[];
  if(!(stats.averageR>0))failures.push('recent average R is not positive');
  if(!(stats.expectancyLower95>0))failures.push('95% lower expectancy bound is not positive');
  if(stats.profitFactorR!==null&&stats.profitFactorR<1)failures.push('recent profit factor is below 1');
  if(stats.maxDrawdownR>maxDrawdownR)failures.push(`recent drawdown ${stats.maxDrawdownR.toFixed(2)}R exceeds ${maxDrawdownR.toFixed(2)}R guard`);
  return {allowed:failures.length===0,enabled:true,minTrades,lookback,maxDrawdownLimitR:maxDrawdownR,...stats,reason:failures.length?failures.join('; '):'Recent monitored expectancy is within guard'};
}
function status(){
  return {
    mode:mode(),
    autoPaper:process.env.AUTO_PAPER_TRADING==='true',
    autoDemoStrict:process.env.AUTO_DEMO_STRICT==='true',
    autoDemoResearch:process.env.AUTO_DEMO_RESEARCH==='true',
    autoDemoResearchRiskPct:Number(process.env.AUTO_DEMO_RESEARCH_RISK_PCT||0.25),
    autoMinConfluence:Number(process.env.AUTO_MIN_CONFLUENCE||60),
    performanceGuardEnabled:process.env.AUTO_PERFORMANCE_GUARD!=='false',
    performanceGuardMinTrades:Number(process.env.AUTO_PERFORMANCE_MIN_TRADES||20),
    performanceGuardLookback:Number(process.env.AUTO_PERFORMANCE_LOOKBACK||30),
    liveAutomation:false,
    brokerBridge:String(process.env.BROKER_BRIDGE||'none'),
    pending:db.prepare("SELECT COUNT(*) n FROM execution_intents WHERE status='PENDING'").get().n,
    brokerTracked:db.prepare("SELECT COUNT(*) n FROM execution_intents WHERE broker_order_id IS NOT NULL AND broker_order_id<>''").get().n
  };
}
function createIntent(signal,options={}){
  const plan=planTrade(signal,options);
  if(!plan.allowed)return {created:false,plan};
  const m=mode();
  if(!['paper','demo','bridge'].includes(m))return {created:false,plan,reason:'Execution mode is off'};
  const duplicate=db.prepare("SELECT id FROM execution_intents WHERE symbol=? AND timeframe=? AND model_id IS ? AND side=? AND created_at>? AND status IN ('PENDING','PAPER_FILLED','APPROVED','DEMO_SENT','DEMO_FILLED') ORDER BY id DESC LIMIT 1")
    .get(signal.symbol,signal.timeframe||'1h',signal.modelId||null,plan.side,Date.now()-30*60000);
  if(duplicate)return {created:false,duplicateId:duplicate.id,plan};
  const r=db.prepare(`INSERT INTO execution_intents(created_at,symbol,timeframe,side,entry,stop,target,units,probability,model_id,mode,status,reason,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(Date.now(),signal.symbol,signal.timeframe||'1h',plan.side,plan.entry,plan.stop,plan.target,plan.units,signal.setupProbability??signal.probability,signal.modelId||null,m,'PENDING','Research gates passed',Date.now());
  if(m==='paper'&&process.env.AUTO_PAPER_TRADING==='true'){
    const trade=db.prepare('INSERT INTO paper_trades(created_at,symbol,side,entry,stop,target,units) VALUES(?,?,?,?,?,?,?)').run(Date.now(),signal.symbol,plan.side,plan.entry,plan.stop,plan.target,plan.units);
    db.prepare("UPDATE execution_intents SET status='PAPER_FILLED',reason=?,broker_order_id=?,updated_at=? WHERE id=?").run('Automatically filled in paper ledger',String(trade.lastInsertRowid),Date.now(),r.lastInsertRowid);
    return {created:true,id:r.lastInsertRowid,status:'PAPER_FILLED',paperTradeId:trade.lastInsertRowid,plan};
  }
  return {created:true,id:r.lastInsertRowid,status:'PENDING',plan};
}
function createAutoDemoIntent(signal,{riskPct=Number(process.env.RISK_PER_TRADE_PCT||0.5)}={}){
  if(process.env.AUTO_DEMO_STRICT!=='true')return {created:false,reason:'Automatic strict demo execution is disabled'};
  if(String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase()!=='demo')return {created:false,reason:'Automatic execution is restricted to demo bridge mode'};
  const side=signal.direction,prob=Number(signal.setupProbability??signal.probability??0),threshold=Number(signal.minProbability||0.7);
  const agreement=Number(signal.analysis?.confluence?.agreement||0),minAgreement=Number(process.env.AUTO_MIN_CONFLUENCE||60);
  if(!['LONG','SHORT'].includes(side)||!signal.modelApproved||(signal.filters||[]).length||prob<threshold)return {created:false,reason:'Signal is not STRICT and model-approved'};
  if(!Number.isFinite(agreement)||agreement<minAgreement)return {created:false,reason:`Evidence agreement below automatic demo minimum (${minAgreement}%)`};
  const plan=signal.tradePlan;
  if(!plan||![plan.entry,plan.stop,plan.target].every(Number.isFinite))return {created:false,reason:'Signal has no valid trade plan'};
  if(!Number.isFinite(riskPct)||riskPct<=0||riskPct>1)return {created:false,reason:'Automatic demo risk must be >0 and <=1%'};
  const guard=performanceGuard(signal);if(!guard.allowed)return {created:false,reason:'Automatic demo paused by performance guard: '+guard.reason,performanceGuard:guard};
  const signalKey=[signal.symbol,signal.timeframe,signal.sourceCandleTs].join(':');
  const prior=db.prepare('SELECT id,status,broker_order_id FROM execution_intents WHERE signal_key=? AND manual=0').get(signalKey);
  if(prior)return {created:false,duplicateId:prior.id,status:prior.status,reason:'This source candle already has an automatic execution intent'};
  const r=db.prepare(`INSERT INTO execution_intents(
      created_at,symbol,timeframe,side,entry,stop,target,units,probability,model_id,mode,status,reason,updated_at,
      risk_pct,sizing_mode,manual,source_ts,signal_key,confluence)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(Date.now(),signal.symbol,signal.timeframe||'1h',side,Number(plan.entry),Number(plan.stop),Number(plan.target),0,prob,signal.modelId||null,'demo','PENDING',
      'Automatic STRICT demo signal awaiting broker-safe preview',Date.now(),riskPct,'BROKER_RISK_PERCENT',0,signal.sourceCandleTs,signalKey,agreement);
  return {created:true,id:r.lastInsertRowid,status:'PENDING',signalKey,plan:{side,entry:plan.entry,stop:plan.stop,target:plan.target,riskPct,agreement}};
}

function createAutoResearchDemoIntent(signal,{riskPct=Number(process.env.AUTO_DEMO_RESEARCH_RISK_PCT||0.25)}={}){
  if(process.env.AUTO_DEMO_RESEARCH!=='true')return {created:false,reason:'Automatic research demo execution is disabled'};
  if(String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase()!=='demo')return {created:false,reason:'Automatic research execution is restricted to demo bridge mode'};
  if(signal.modelApproved)return {created:false,reason:'Approved signals use the strict demo path'};
  const side=String(signal.candidateDirection||'').toUpperCase();
  const prob=Number(signal.setupProbability??0),threshold=Number(signal.minProbability||0.7);
  if(!['LONG','SHORT'].includes(side)||!Number.isFinite(prob)||prob<threshold)return {created:false,reason:'Research candidate is below the setup threshold'};
  const blockers=(signal.filters||[]).filter(x=>x!=='Model has not passed out-of-sample validation gates');
  if(blockers.length)return {created:false,reason:'Research candidate still has safety/quality blockers',blockers};
  if(signal.eventRisk)return {created:false,reason:'Research candidate has event risk'};
  const agreement=Number(signal.analysis?.confluence?.agreement||0),minAgreement=Number(process.env.AUTO_MIN_CONFLUENCE||60);
  if(!Number.isFinite(agreement)||agreement<minAgreement)return {created:false,reason:`Evidence agreement below automatic demo minimum (${minAgreement}%)`};
  const plan=signal.tradePlan;
  if(!plan||![plan.entry,plan.stop,plan.target].every(Number.isFinite))return {created:false,reason:'Signal has no valid trade plan'};
  if(!Number.isFinite(riskPct)||riskPct<=0||riskPct>0.5)return {created:false,reason:'Automatic research demo risk must be >0 and <=0.5%'};
  const guard=performanceGuard(signal);if(!guard.allowed)return {created:false,reason:'Automatic research demo paused by performance guard: '+guard.reason,performanceGuard:guard};
  const signalKey=[signal.symbol,signal.timeframe,signal.sourceCandleTs].join(':');
  const prior=db.prepare('SELECT id,status,broker_order_id FROM execution_intents WHERE signal_key=? AND manual=0').get(signalKey);
  if(prior)return {created:false,duplicateId:prior.id,status:prior.status,reason:'This source candle already has an automatic execution intent'};
  const r=db.prepare(`INSERT INTO execution_intents(
      created_at,symbol,timeframe,side,entry,stop,target,units,probability,model_id,mode,status,reason,updated_at,
      risk_pct,sizing_mode,manual,source_ts,signal_key,confluence)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(Date.now(),signal.symbol,signal.timeframe||'1h',side,Number(plan.entry),Number(plan.stop),Number(plan.target),0,prob,signal.modelId||null,'demo','PENDING',
      'Automatic RESEARCH demo candidate awaiting broker-safe preview',Date.now(),riskPct,'BROKER_RISK_PERCENT',0,signal.sourceCandleTs,signalKey,agreement);
  return {created:true,id:r.lastInsertRowid,status:'PENDING',signalKey,plan:{side,entry:plan.entry,stop:plan.stop,target:plan.target,riskPct,agreement}};
}

function list(limit=100){return db.prepare('SELECT * FROM execution_intents ORDER BY id DESC LIMIT ?').all(Math.max(1,Math.min(500,Number(limit)||100)));}
function approve(id){
  const row=db.prepare('SELECT * FROM execution_intents WHERE id=?').get(id);
  if(!row)throw new Error('Intent not found');
  if(row.mode!=='bridge')throw new Error('Only bridge intents can be approved');
  if(row.status!=='PENDING')throw new Error('Intent is not pending');
  db.prepare("UPDATE execution_intents SET status='APPROVED',reason='Explicitly approved for broker bridge',updated_at=? WHERE id=?").run(Date.now(),id);
  return db.prepare('SELECT * FROM execution_intents WHERE id=?').get(id);
}
function createManualIntent(signal,{side,equity=10000,riskPct=.5,maxPositionUnits=100000}={}){
  const plan=signal.tradePlan;
  const chosen=side||signal.leanDirection;
  if(!plan||!['LONG','SHORT'].includes(chosen))throw new Error('Signal has no manual trade plan');
  const entry=Number(plan.entry),stop=chosen===plan.side?Number(plan.stop):entry+(chosen==='LONG'?-1:1)*Math.abs(Number(plan.stop)-entry);
  const target=chosen===plan.side?Number(plan.target):entry+(chosen==='LONG'?1:-1)*Math.abs(Number(plan.target)-entry);
  const stopDistance=Math.abs(entry-stop);
  if(![entry,stop,target,equity,riskPct,maxPositionUnits].every(Number.isFinite)||stopDistance<=0||equity<=0||riskPct<=0||riskPct>2)throw new Error('Invalid manual trade parameters');
  const m=mode();
  if(!['paper','demo','bridge'].includes(m))throw new Error('Execution mode is off');
  const r=db.prepare(`INSERT INTO execution_intents(created_at,symbol,timeframe,side,entry,stop,target,units,probability,model_id,mode,status,reason,updated_at,risk_pct,sizing_mode,manual,source_ts,signal_key,confluence)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(Date.now(),signal.symbol,signal.timeframe||'1h',chosen,entry,stop,target,0,signal.setupProbability??signal.probability,signal.modelId||null,m,'PENDING','Manual user-selected signal; probability threshold may be below automated gate',Date.now(),riskPct,'BROKER_RISK_PERCENT',1,signal.sourceCandleTs||null,null,Number(signal.analysis?.confluence?.agreement||0));
  return {created:true,id:r.lastInsertRowid,status:'PENDING',manual:true,plan:{side:chosen,entry,stop,target,riskPct,sizingMode:'BROKER_RISK_PERCENT',riskReward:Math.abs(target-entry)/stopDistance}};
}
module.exports={status,summarizePerformance,performanceGuard,createIntent,createAutoDemoIntent,createAutoResearchDemoIntent,createManualIntent,list,approve};
