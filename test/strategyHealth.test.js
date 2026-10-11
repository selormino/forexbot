process.env.DB_PATH=':memory:';
const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../src/db');
const research=require('../src/research');
const health=require('../src/strategyHealth');

test('edge status says not validated and surfaces recent quota failures',()=>{
  db.prepare("INSERT INTO ingestion_runs(started_at,symbol,timeframe,provider,status,error) VALUES(?,?,?,?,?,?)")
    .run(Date.now(),'EURUSD','15m','twelvedata','FAILED','API credits used 1764, current limit 800');
  const s=health.status();
  assert.equal(s.verdict,'NOT_VALIDATED');
  assert.equal(s.convincing,false);
  assert.equal(s.dataHealth,'DEGRADED');
  assert.equal(s.data.quotaFailures,1);
  assert.ok(s.reasons.some(x=>/quota|data/i.test(x)));
});

test('approved models without enough forward evidence remain validating',()=>{
  db.prepare('DELETE FROM ingestion_runs').run();
  db.prepare('INSERT INTO research_models(created_at,symbol,timeframe,version,model,report,approved) VALUES(?,?,?,?,?,?,?)')
    .run(Date.now(),'EURUSD','1h',research.VERSION,'{}',JSON.stringify({symbol:'EURUSD',timeframe:'1h',approved:true}),1);
  const s=health.status();
  assert.equal(s.approvedSeries,1);
  assert.equal(s.verdict,'VALIDATING');
  assert.equal(s.convincing,false);
});
