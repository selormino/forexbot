process.env.DB_PATH=':memory:';
process.env.STORAGE_RESEARCH_KEEP_VERSIONS='2';
process.env.STORAGE_RESEARCH_KEEP_PER_SERIES='2';
process.env.STORAGE_RESEARCH_KEEP_OLD_PER_SERIES='1';
process.env.STORAGE_INGESTION_RUN_DAYS='14';
process.env.MODEL_TRAIN_INTERVAL_MINUTES='60';

const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../src/db');

db.exec(`
CREATE TABLE IF NOT EXISTS research_models(
  id INTEGER PRIMARY KEY,
  created_at INTEGER,
  symbol TEXT,
  timeframe TEXT,
  version TEXT,
  model TEXT,
  report TEXT,
  approved INTEGER
);
CREATE TABLE IF NOT EXISTS signal_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER
);
`);

const storage=require('../src/storageMaintenance');

function reset(){
  for(const table of ['research_models','ingestion_runs','backtests','models','signal_records','storage_maintenance_runs']){
    if(storage.tableExists(table))db.prepare('DELETE FROM '+table).run();
  }
}

test('storage cleanup keeps only recent research versions and bounded snapshots',()=>{
  reset();
  const ins=db.prepare('INSERT INTO research_models(created_at,symbol,timeframe,version,model,report,approved) VALUES(?,?,?,?,?,?,0)');
  let idTime=1000;
  for(const version of ['v1','v2','v3']){
    for(let i=0;i<4;i++)ins.run(idTime++,'EURUSD','1h',version,'{}','{}');
  }
  db.prepare('INSERT INTO signal_records(created_at) VALUES(?)').run(1);
  const out=storage.run({now:30*86400000});
  assert.equal(out.ok,true);
  const versions=db.prepare('SELECT DISTINCT version FROM research_models ORDER BY version').all().map(x=>x.version);
  assert.deepEqual(versions,['v2','v3']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM research_models WHERE version='v3'").get().n,2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM research_models WHERE version='v2'").get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM signal_records').get().n,1);
});

test('storage cleanup removes old ingestion runs but preserves recent runs',()=>{
  reset();
  const now=40*86400000;
  db.prepare("INSERT INTO ingestion_runs(started_at,symbol,timeframe,status) VALUES(?,?,?,'SUCCESS')").run(now-20*86400000,'EURUSD','1h');
  db.prepare("INSERT INTO ingestion_runs(started_at,symbol,timeframe,status) VALUES(?,?,?,'SUCCESS')").run(now-2*86400000,'EURUSD','1h');
  storage.run({now});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ingestion_runs').get().n,1);
});

test('research retraining waits for configured interval',()=>{
  reset();
  const now=10_000_000;
  db.prepare('INSERT INTO research_models(created_at,symbol,timeframe,version,model,report,approved) VALUES(?,?,?,?,?,?,0)')
    .run(now-30*60000,'EURUSD','1h','v39','{}','{}');
  assert.equal(storage.shouldTrainResearch('v39',{now}).due,false);
  assert.equal(storage.shouldTrainResearch('v39',{now:now+31*60000}).due,true);
});

test('storage status exposes configured capacity without requiring a filesystem database',()=>{
  process.env.STORAGE_VOLUME_CAPACITY_MB='5000';
  const s=storage.status();
  assert.equal(s.config.researchKeepVersions,2);
  assert.equal(s.current.files.capacityMB,5000);
});
