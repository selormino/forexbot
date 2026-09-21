process.env.DB_PATH=':memory:';
const test=require('node:test');
const assert=require('node:assert/strict');
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
