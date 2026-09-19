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

const mode=()=>String(process.env.EXECUTION_MODE||'off').toLowerCase();
function status(){
  return {
    mode:mode(),
    autoPaper:process.env.AUTO_PAPER_TRADING==='true',
    liveAutomation:false,
    brokerBridge:String(process.env.BROKER_BRIDGE||'none'),
    pending:db.prepare("SELECT COUNT(*) n FROM execution_intents WHERE status='PENDING'").get().n
  };
}
function createIntent(signal,options={}){
  const plan=planTrade(signal,options);
  if(!plan.allowed)return {created:false,plan};
  const m=mode();
  if(!['paper','demo','bridge'].includes(m))return {created:false,plan,reason:'Execution mode is off'};
  const duplicate=db.prepare("SELECT id FROM execution_intents WHERE symbol=? AND timeframe=? AND model_id IS ? AND side=? AND created_at>? AND status IN ('PENDING','PAPER_FILLED','APPROVED') ORDER BY id DESC LIMIT 1")
    .get(signal.symbol,signal.timeframe||'1h',signal.modelId||null,plan.side,Date.now()-30*60000);
  if(duplicate)return {created:false,duplicateId:duplicate.id,plan};
  const r=db.prepare(`INSERT INTO execution_intents(created_at,symbol,timeframe,side,entry,stop,target,units,probability,model_id,mode,status,reason,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(Date.now(),signal.symbol,signal.timeframe||'1h',plan.side,plan.entry,plan.stop,plan.target,plan.units,signal.probability,signal.modelId||null,m,'PENDING','Research gates passed',Date.now());
  if(m==='paper'&&process.env.AUTO_PAPER_TRADING==='true'){
    const trade=db.prepare('INSERT INTO paper_trades(created_at,symbol,side,entry,stop,target,units) VALUES(?,?,?,?,?,?,?)').run(Date.now(),signal.symbol,plan.side,plan.entry,plan.stop,plan.target,plan.units);
    db.prepare("UPDATE execution_intents SET status='PAPER_FILLED',reason=?,broker_order_id=?,updated_at=? WHERE id=?").run('Automatically filled in paper ledger',String(trade.lastInsertRowid),Date.now(),r.lastInsertRowid);
    return {created:true,id:r.lastInsertRowid,status:'PAPER_FILLED',paperTradeId:trade.lastInsertRowid,plan};
  }
  return {created:true,id:r.lastInsertRowid,status:'PENDING',plan};
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
  const r=db.prepare(`INSERT INTO execution_intents(created_at,symbol,timeframe,side,entry,stop,target,units,probability,model_id,mode,status,reason,updated_at,risk_pct,sizing_mode,manual)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(Date.now(),signal.symbol,signal.timeframe||'1h',chosen,entry,stop,target,0,signal.directionalProbability,signal.modelId||null,m,'PENDING','Manual user-selected signal; probability threshold may be below automated gate',Date.now(),riskPct,'BROKER_RISK_PERCENT',1);
  return {created:true,id:r.lastInsertRowid,status:'PENDING',manual:true,plan:{side:chosen,entry,stop,target,riskPct,sizingMode:'BROKER_RISK_PERCENT',riskReward:Math.abs(target-entry)/stopDistance}};
}
module.exports={status,createIntent,createManualIntent,list,approve};
