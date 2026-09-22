process.env.DB_PATH=':memory:';
const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../src/db');
const monitor=require('../src/signalMonitor');

test('setup-qualified signal is monitored even when directional model is low-confidence',()=>{
  const row=monitor.record({
    symbol:'EURUSD',timeframe:'1h',sourceCandleTs:1_000_000,
    candidateDirection:'LONG',direction:'WAIT',leanDirection:'LONG',
    probability:.72,setupProbability:.72,directionalProbability:.51,directionalMinProbability:.55,
    minProbability:.60,price:1.1,modelId:1,modelVersion:'test-v1',horizonBars:4,
    costs:{total:5},filters:['Model has not passed out-of-sample validation gates'],
    priceAction:{bias:.4},analysis:{},
    tradePlan:{entry:1.101,stop:1.095,target:1.106,tp1:1.103,stopPips:60,targetPips:50,unitLabel:'pips',entryExpiryBars:4,holdBars:6}
  });
  assert.equal(row.qualified,1);
  assert.equal(row.actionable,0);
  assert.equal(row.status,'PENDING_ENTRY');
});


test('metrics preserve all-time records across research model versions',()=>{
  monitor.record({
    symbol:'EURUSD',timeframe:'1h',sourceCandleTs:2_000_000,candidateDirection:'LONG',direction:'LONG',leanDirection:'LONG',
    probability:.75,setupProbability:.75,directionalProbability:.70,directionalMinProbability:.55,minProbability:.60,price:1.1,
    modelId:2,modelVersion:'older-v',horizonBars:4,costs:{total:5},filters:[],priceAction:{},analysis:{},
    tradePlan:{entry:1.101,stop:1.095,target:1.106,tp1:1.103,stopPips:60,targetPips:50,unitLabel:'pips',entryExpiryBars:4,holdBars:6}
  });
  const m=monitor.metrics();
  assert.ok(m.allTimeActionable.total>=1);
});


test('filtered signals are shadow-tracked through entry and outcome',()=>{
  const source=3_000_000;
  const row=monitor.record({
    symbol:'EURUSD',timeframe:'1h',sourceCandleTs:source,
    candidateDirection:'WAIT',direction:'WAIT',leanDirection:'LONG',
    probability:.55,setupProbability:.55,directionalProbability:.55,directionalMinProbability:.55,
    minProbability:.60,price:1.1,modelId:3,modelVersion:'shadow-v1',horizonBars:4,
    costs:{total:5},filters:['Setup success probability below 60% threshold'],
    priceAction:{bias:.2},analysis:{confluence:{agreement:58}},
    tradePlan:{entry:1.101,stop:1.095,target:1.106,tp1:1.103,stopPips:60,targetPips:50,unitLabel:'pips',entryExpiryBars:4,holdBars:6}
  });
  assert.equal(row.status,'FILTERED');
  assert.equal(row.shadow_status,'PENDING_ENTRY');
  db.prepare('INSERT INTO candles(symbol,timeframe,ts,open,high,low,close,volume,provider,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('EURUSD','1h',source+3_600_000,1.100,1.107,1.100,1.106,1000,'test',Date.now());
  const result=monitor.advance();
  assert.equal(result.shadowTriggered,1);
  assert.equal(result.shadowSettled,1);
  const latest=monitor.history(20).find(x=>x.signal_key===row.signal_key);
  assert.equal(latest.shadow_status,'SETTLED');
  assert.equal(latest.shadow_outcome,'TP');
  assert.equal(latest.shadow_success,1);
});


test('forward realized R is net of execution costs and financing',()=>{
  const source=4_000_000;
  const row=monitor.record({
    symbol:'EURUSD',timeframe:'1h',sourceCandleTs:source,
    candidateDirection:'LONG',direction:'LONG',leanDirection:'LONG',
    probability:.72,setupProbability:.72,directionalProbability:.70,directionalMinProbability:.55,
    minProbability:.60,price:1.1,modelId:4,modelVersion:'net-r-v1',horizonBars:4,
    costs:{total:10,financingBpsPerDay:5},filters:[],priceAction:{bias:.4},analysis:{},
    tradePlan:{entry:1.1,stop:1.09,target:1.11,tp1:1.105,stopPips:100,targetPips:100,unitLabel:'pips',entryExpiryBars:2,holdBars:2}
  });
  db.prepare('INSERT INTO candles(symbol,timeframe,ts,open,high,low,close,volume,provider,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('EURUSD','1h',source+3_600_000,1.1,1.111,1.1,1.11,1000,'test',Date.now());
  const result=monitor.advance();
  assert.equal(result.settled>=1,true);
  const latest=monitor.history(20).find(x=>x.signal_key===row.signal_key);
  assert.equal(latest.outcome,'TP');
  assert.ok(latest.realized_r<1);
  assert.ok(latest.net_return<latest.gross_return);
});
