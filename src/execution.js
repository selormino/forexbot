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
module.exports={status,createIntent,list,approve};
