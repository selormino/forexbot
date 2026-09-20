process.env.DB_PATH=':memory:';
process.env.AUTO_DEMO_STRICT='true';
process.env.BROKER_BRIDGE_MODE='demo';
const test=require('node:test'),assert=require('node:assert/strict');
const execution=require('../src/execution');

function strictSignal(){
  return {
    symbol:'EURUSD',timeframe:'1h',sourceCandleTs:123456789,
    direction:'LONG',directionalProbability:.74,setupProbability:.76,minProbability:.70,
    modelApproved:true,modelId:42,filters:[],
    analysis:{confluence:{agreement:78}},
    tradePlan:{side:'LONG',entry:1.1,stop:1.095,target:1.108,riskReward:1.6}
  };
}
test('automatic demo intent requires strict approved confluence and deduplicates source candle',()=>{
  const first=execution.createAutoDemoIntent(strictSignal(),{riskPct:.5});
  assert.equal(first.created,true);
  const duplicate=execution.createAutoDemoIntent(strictSignal(),{riskPct:.5});
  assert.equal(duplicate.created,false);
  assert.equal(duplicate.duplicateId,first.id);
});
test('automatic demo intent rejects weak evidence agreement',()=>{
  const s={...strictSignal(),sourceCandleTs:987654321,analysis:{confluence:{agreement:40}}};
  const out=execution.createAutoDemoIntent(s,{riskPct:.5});
  assert.equal(out.created,false);
  assert.match(out.reason,/Evidence agreement/);
});
