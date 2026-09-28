const fs=require('fs');
const path=require('path');
const db=require('./db');

const MB=1024*1024;
const dbPath=process.env.DB_PATH||'./data/forexbot.db';

function tableExists(name){
  return !!db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function safeCount(name){
  if(!tableExists(name))return 0;
  return Number(db.prepare('SELECT COUNT(*) n FROM '+name).get()?.n||0);
}
function fileBytes(file){
  if(!file||file===':memory:')return 0;
  try{return fs.statSync(path.resolve(file)).size;}catch{return 0;}
}
function pragmaNumber(name){
  try{return Number(db.pragma(name,{simple:true})||0);}catch{return 0;}
}
function ensureSchema(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_maintenance_runs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      deleted_json TEXT,
      before_json TEXT,
      after_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS storage_maintenance_recent ON storage_maintenance_runs(started_at DESC);
  `);
}
ensureSchema();

function databaseStats(){
  const main=fileBytes(dbPath),wal=fileBytes(dbPath===':memory:'?null:dbPath+'-wal'),shm=fileBytes(dbPath===':memory:'?null:dbPath+'-shm');
  const pageSize=pragmaNumber('page_size'),pageCount=pragmaNumber('page_count'),freePages=pragmaNumber('freelist_count');
  const capacityMB=Math.max(0,Number(process.env.STORAGE_VOLUME_CAPACITY_MB||0));
  const sqliteBytes=main+wal+shm;
  const logicalBytes=Math.max(0,(pageCount-freePages)*pageSize);
  return {
    dbPath:dbPath===':memory:'?':memory:':path.resolve(dbPath),
    mainMB:main/MB,walMB:wal/MB,shmMB:shm/MB,sqliteFilesMB:sqliteBytes/MB,
    pageSize,pageCount,freePages,reclaimableMB:(freePages*pageSize)/MB,logicalUsedMB:logicalBytes/MB,
    capacityMB:capacityMB||null,
    percentOfConfiguredCapacity:capacityMB?sqliteBytes/MB/capacityMB*100:null
  };
}

function retentionConfig(){
  return {
    researchKeepVersions:Math.max(1,Math.min(12,Number(process.env.STORAGE_RESEARCH_KEEP_VERSIONS||3))),
    researchKeepCurrentPerSeries:Math.max(1,Math.min(50,Number(process.env.STORAGE_RESEARCH_KEEP_PER_SERIES||4))),
    researchKeepOldPerSeries:Math.max(1,Math.min(10,Number(process.env.STORAGE_RESEARCH_KEEP_OLD_PER_SERIES||1))),
    ingestionRunDays:Math.max(1,Number(process.env.STORAGE_INGESTION_RUN_DAYS||14)),
    legacyBacktests:Math.max(10,Number(process.env.STORAGE_BACKTEST_KEEP||100)),
    legacyModels:Math.max(5,Number(process.env.STORAGE_LEGACY_MODEL_KEEP||20)),
    candleMaxPerSeries:Math.max(5000,Number(process.env.STORAGE_CANDLE_MAX_PER_SERIES||20000)),
    maintenanceHours:Math.max(1,Number(process.env.STORAGE_MAINTENANCE_HOURS||24)),
    modelTrainIntervalMinutes:Math.max(15,Number(process.env.MODEL_TRAIN_INTERVAL_MINUTES||60))
  };
}

function snapshot(){
  const tables=['candles','observations','research_models','ingestion_runs','signal_records','news_history','context_snapshots','macro_observations','macro_vintages','backtests','models','paper_trades'];
  return {files:databaseStats(),rows:Object.fromEntries(tables.filter(tableExists).map(t=>[t,safeCount(t)]))};
}

function deleteRanked(table,partition,order,where,args,keep){
  if(!tableExists(table))return 0;
  const predicate=where?(' WHERE '+where):'';
  const sql=`DELETE FROM ${table} WHERE id IN (
    SELECT id FROM (
      SELECT id,ROW_NUMBER() OVER(PARTITION BY ${partition} ORDER BY ${order}) rn
      FROM ${table}${predicate}
    ) ranked WHERE rn>?
  )`;
  return db.prepare(sql).run(...(args||[]),keep).changes;
}

function pruneResearchModels(config){
  if(!tableExists('research_models'))return {versions:0,current:0,old:0};
  const versions=db.prepare('SELECT version,MAX(id) max_id FROM research_models GROUP BY version ORDER BY max_id DESC').all();
  if(!versions.length)return {versions:0,current:0,old:0};
  const keepVersions=versions.slice(0,config.researchKeepVersions).map(x=>x.version);
  let removedVersions=0;
  if(versions.length>keepVersions.length){
    const marks=keepVersions.map(()=>'?').join(',');
    removedVersions=db.prepare(`DELETE FROM research_models WHERE version NOT IN (${marks})`).run(...keepVersions).changes;
  }
  const current=keepVersions[0];
  const currentRemoved=deleteRanked('research_models','symbol,timeframe,version','id DESC','version=?',[current],config.researchKeepCurrentPerSeries);
  let oldRemoved=0;
  for(const version of keepVersions.slice(1)){
    oldRemoved+=deleteRanked('research_models','symbol,timeframe,version','id DESC','version=?',[version],config.researchKeepOldPerSeries);
  }
  return {versions:removedVersions,current:currentRemoved,old:oldRemoved};
}

function pruneCandles(config){
  if(!tableExists('candles'))return {candles:0,observations:0};
  const candleDelete=db.prepare(`DELETE FROM candles WHERE rowid IN (
    SELECT rowid FROM (
      SELECT rowid,ROW_NUMBER() OVER(PARTITION BY symbol,timeframe ORDER BY ts DESC) rn
      FROM candles
    ) ranked WHERE rn>?
  )`).run(config.candleMaxPerSeries).changes;
  let observations=0;
  if(candleDelete&&tableExists('observations')){
    observations=db.prepare(`DELETE FROM observations
      WHERE NOT EXISTS(
        SELECT 1 FROM candles c
        WHERE c.symbol=observations.symbol AND c.timeframe=observations.timeframe AND c.ts=observations.ts
      )`).run().changes;
  }
  return {candles:candleDelete,observations};
}

function pruneSimple(config,now){
  const out={};
  if(tableExists('ingestion_runs')){
    out.ingestionRuns=db.prepare('DELETE FROM ingestion_runs WHERE started_at<?').run(now-config.ingestionRunDays*86400000).changes;
  }
  if(tableExists('backtests')){
    out.backtests=db.prepare('DELETE FROM backtests WHERE id NOT IN (SELECT id FROM backtests ORDER BY id DESC LIMIT ?)').run(config.legacyBacktests).changes;
  }
  if(tableExists('models')){
    out.legacyModels=db.prepare('DELETE FROM models WHERE id NOT IN (SELECT id FROM models ORDER BY id DESC LIMIT ?)').run(config.legacyModels).changes;
  }
  if(tableExists('storage_maintenance_runs')){
    out.maintenanceRuns=db.prepare('DELETE FROM storage_maintenance_runs WHERE started_at<?').run(now-90*86400000).changes;
  }
  return out;
}

function checkpoint(){
  try{db.pragma('wal_checkpoint(TRUNCATE)');}catch{}
  try{db.pragma('optimize');}catch{}
}

function run({now=Date.now()}={}){
  ensureSchema();
  const config=retentionConfig(),before=snapshot();
  const started=db.prepare("INSERT INTO storage_maintenance_runs(started_at,status,before_json) VALUES(?,'RUNNING',?)")
    .run(now,JSON.stringify(before));
  try{
    const deleted=db.transaction(()=>({
      researchModels:pruneResearchModels(config),
      ...pruneCandles(config),
      ...pruneSimple(config,now)
    }))();
    checkpoint();
    const after=snapshot();
    db.prepare("UPDATE storage_maintenance_runs SET finished_at=?,status='SUCCESS',deleted_json=?,after_json=? WHERE id=?")
      .run(Date.now(),JSON.stringify(deleted),JSON.stringify(after),started.lastInsertRowid);
    return {ok:true,config,deleted,before,after};
  }catch(error){
    db.prepare("UPDATE storage_maintenance_runs SET finished_at=?,status='FAILED',error=? WHERE id=?")
      .run(Date.now(),String(error.message).slice(0,1000),started.lastInsertRowid);
    throw error;
  }
}

function lastRun(){
  if(!tableExists('storage_maintenance_runs'))return null;
  const row=db.prepare("SELECT * FROM storage_maintenance_runs WHERE status='SUCCESS' ORDER BY id DESC LIMIT 1").get();
  if(!row)return null;
  return {...row,deleted:JSON.parse(row.deleted_json||'{}'),before:JSON.parse(row.before_json||'{}'),after:JSON.parse(row.after_json||'{}'),deleted_json:undefined,before_json:undefined,after_json:undefined};
}
function maybeRun({now=Date.now()}={}){
  const last=lastRun(),hours=retentionConfig().maintenanceHours;
  if(last&&now-last.started_at<hours*3600000)return {ok:true,skipped:true,reason:'maintenance interval not reached',lastRun:last};
  return run({now});
}
function shouldTrainResearch(version,{now=Date.now()}={}){
  const interval=retentionConfig().modelTrainIntervalMinutes;
  if(!tableExists('research_models'))return {due:true,intervalMinutes:interval,lastTrainedAt:null};
  const last=db.prepare('SELECT MAX(created_at) ts FROM research_models WHERE version=?').get(version)?.ts||null;
  return {due:!last||now-last>=interval*60000,intervalMinutes:interval,lastTrainedAt:last};
}
function status(){
  return {config:retentionConfig(),current:snapshot(),lastRun:lastRun()};
}

module.exports={status,run,maybeRun,shouldTrainResearch,retentionConfig,databaseStats,tableExists};
