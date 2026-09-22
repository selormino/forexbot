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


test('automatic research demo accepts threshold-qualified candidate when model approval is the only blocker',()=>{
  process.env.AUTO_DEMO_RESEARCH='true';
  const s={...strictSignal(),sourceCandleTs:222222222,direction:'WAIT',candidateDirection:'LONG',modelApproved:false,
    filters:['Model has not passed out-of-sample validation gates'],setupProbability:.66,minProbability:.60};
  const out=execution.createAutoResearchDemoIntent(s,{riskPct:.25});
  assert.equal(out.created,true);
});
test('automatic research demo rejects any additional quality blocker',()=>{
  process.env.AUTO_DEMO_RESEARCH='true';
  const s={...strictSignal(),sourceCandleTs:333333333,direction:'WAIT',candidateDirection:'LONG',modelApproved:false,
    filters:['Model has not passed out-of-sample validation gates','Missing fresh macro/news confirmation'],setupProbability:.70,minProbability:.60};
  const out=execution.createAutoResearchDemoIntent(s,{riskPct:.25});
  assert.equal(out.created,false);
  assert.match(out.reason,/blockers/);
});


test('automatic research demo accepts 60 percent evidence at the configured floor',()=>{
  process.env.AUTO_DEMO_RESEARCH='true';
  process.env.AUTO_MIN_CONFLUENCE='60';
  const base=strictSignal();
  const candidate={...base,sourceCandleTs:444444444,direction:'WAIT',candidateDirection:'LONG',modelApproved:false,
    filters:['Model has not passed out-of-sample validation gates'],setupProbability:.60,minProbability:.60,
    analysis:{confluence:{agreement:60}}};
  const out=execution.createAutoResearchDemoIntent(candidate,{riskPct:.25});
  assert.equal(out.created,true);
});


test('performance summary detects positive and negative recent expectancy',()=>{
  const profitable=Array.from({length:40},(_,i)=>({realized_r:i%5!==0?.9:-1}));
  const losing=Array.from({length:40},(_,i)=>({realized_r:i%2===0?.5:-1}));
  const good=execution.summarizePerformance(profitable),bad=execution.summarizePerformance(losing);
  assert.ok(good.averageR>0);
  assert.ok(good.expectancyLower95>0);
  assert.ok(good.profitFactorR>1);
  assert.ok(bad.averageR<0);
  assert.ok(bad.expectancyLower95<0);
});
