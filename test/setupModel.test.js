process.env.DB_PATH=':memory:';
const test=require('node:test');
const assert=require('node:assert/strict');
const setup=require('../src/setupModel');
const research=require('../src/research');

function row(futureBars){
  return {
    price:100,atr:1,x:[.2,-.1,.4],priceAction:{bias:.2},
    futureBars
  };
}
test('setup outcome excludes plans whose confirmation entry never triggers',()=>{
  const r=setup.outcome(row([
    {open:100,high:100.05,low:99.95,close:100},
    {open:100,high:100.06,low:99.94,close:100},
    {open:100,high:100.07,low:99.93,close:100},
    {open:100,high:100.08,low:99.92,close:100}
  ]),'EURUSD','LONG',0);
  assert.equal(r.triggered,false);
  assert.equal(r.settled,false);
});
test('setup outcome labels a triggered target hit as success',()=>{
  const bars=[
    {open:100,high:100.2,low:99.9,close:100.15},
    {open:100.15,high:103,low:100,close:102.5},
    {open:102.5,high:102.7,low:102.3,close:102.6},
    {open:102.6,high:102.8,low:102.4,close:102.7},
    {open:102.7,high:102.9,low:102.5,close:102.8},
    {open:102.8,high:103,low:102.6,close:102.9}
  ];
  const r=setup.outcome(row(bars),'EURUSD','LONG',0);
  assert.equal(r.triggered,true);
  assert.equal(r.settled,true);
  assert.equal(r.outcome,'TP');
  assert.equal(r.y,1);
  assert.ok(r.realizedR>1);
});
test('research split purges through full setup outcome window',()=>{
  const rows=Array.from({length:600},(_,i)=>({at:i,end:i+4,setupEnd:i+10}));
  const {train,cal,test}=research.split(rows);
  assert.ok(train.every(x=>x.setupEnd<cal[0].at));
  assert.ok(cal.every(x=>x.setupEnd<test[0].at));
});
test('setup logistic model returns bounded probabilities',()=>{
  const rows=Array.from({length:200},(_,i)=>({z:[i%2,(i%2)*.5],y:i%2}));
  const weights=setup.fit(rows),calibration=setup.calibrate(weights,rows);
  for(const z of [[0,0],[1,.5]]){
    const p=setup.predict({weights,calibration},z);
    assert.ok(p>0&&p<1);
  }
});


test('setup eligibility mirrors live structural gates',()=>{
  const base={
    regime:'trend',trend:1,atr:1,price:100,
    technicalBias:.5,priceAction:{bias:.2},
    context:{macroAvailable:true,macroBias:.2,newsAvailable:false,newsSentiment:0}
  };
  assert.equal(setup.eligible(base,'LONG',5),true);
  assert.equal(setup.eligible({...base,regime:'range'},'LONG',5),false);
  assert.equal(setup.eligible({...base,trend:-1},'LONG',5),false);
  assert.equal(setup.eligible({...base,priceAction:{bias:-.8}},'LONG',5),false);
  assert.equal(setup.eligible({...base,atr:.01},'LONG',5),false);
});


test('pooled setup rows never cross the target test cutoff',()=>{
  const rows=Array.from({length:400},(_,i)=>({at:i*10,end:i*10+4,setupEnd:i*10+9}));
  const cutoff=3200;
  const parts=research.poolSplitRows(rows,cutoff);
  assert.ok(parts.train.length>0);
  assert.ok(parts.tune.length>0);
  assert.ok(parts.cal.length>0);
  assert.ok(parts.train.every(r=>r.setupEnd<parts.tune[0].at));
  assert.ok(parts.tune.every(r=>r.setupEnd<parts.cal[0].at));
  assert.ok(parts.cal.every(r=>r.setupEnd<cutoff));
});
test('asset-family pooling stays within related markets',()=>{
  assert.deepEqual(research.assetFamily('EURUSD'),['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD']);
  assert.deepEqual(research.assetFamily('XAUUSD'),['XAUUSD','XAGUSD','WTI']);
  assert.deepEqual(research.assetFamily('BTCUSD'),['BTCUSD','ETHUSD','SOLUSD','XRPUSD','LTCUSD']);
});


test('plan selection requires positive expectancy and prefers stronger lower-bound accuracy',()=>{
  const candidates=[
    {planOptions:{name:'bad'},stats:{samples:100,wilsonLower:.80,averageR:-.1,profitFactorR:.8}},
    {planOptions:{name:'good-a'},stats:{samples:100,wilsonLower:.55,averageR:.12,profitFactorR:1.2}},
    {planOptions:{name:'good-b'},stats:{samples:100,wilsonLower:.60,averageR:.05,profitFactorR:1.1}}
  ];
  const chosen=setup.choosePlan(candidates,40);
  assert.equal(chosen.planOptions.name,'good-b');
});
test('custom plan profile changes the generated trade geometry',()=>{
  const r=row([{open:100,high:105,low:95,close:100}]);
  r.regime='trend';r.trend=1;r.technicalBias=.6;r.context={macroAvailable:false,newsAvailable:false,macroBias:0,newsSentiment:0};r.priceAction={bias:.2};
  const a=setup.outcome(r,'EURUSD','LONG',0,{entryBufferAtr:.05,stopAtr:1,targetR:1});
  const b=setup.outcome(r,'EURUSD','LONG',0,{entryBufferAtr:.2,stopAtr:1.5,targetR:1.5});
  assert.notEqual(a.plan.entry,b.plan.entry);
  assert.notEqual(a.plan.stop,b.plan.stop);
  assert.notEqual(a.plan.target,b.plan.target);
});


test('boosted setup model returns bounded probabilities',()=>{
  const rows=Array.from({length:240},(_,i)=>{
    const a=(i%12)/11,b=((i*7)%13)/12;
    return {z:[a,b,a*b],y:(a>.55&&b>.35)?1:0};
  });
  const base=setup.fitBoosted(rows,{rounds:12});
  const calibration=setup.calibrateModel(base,rows);
  const model={...base,calibration};
  for(const z of [[0,0,0],[1,1,1],[.7,.4,.28]]){
    const p=setup.predict(model,z);
    assert.ok(p>0&&p<1);
  }
});
test('competitive setup model reports a calibrated candidate choice',()=>{
  const train=Array.from({length:220},(_,i)=>{
    const a=(i%20)/19,b=((i*11)%17)/16;
    return {z:[a,b,a*b],y:(a>.6&&b>.45)?1:0};
  });
  const cal=Array.from({length:80},(_,i)=>{
    const a=((i+3)%20)/19,b=((i*5+2)%17)/16;
    return {z:[a,b,a*b],y:(a>.6&&b>.45)?1:0};
  });
  const out=setup.fitCompetitive(train,cal);
  assert.ok(['logistic','boosted-stumps'].includes(out.comparison.selected));
  assert.ok(Number.isFinite(out.comparison.logistic.logLoss));
  assert.ok(Number.isFinite(out.comparison.boosted.logLoss));
  assert.ok(out.model.calibration);
});


test('adaptive setup selection only needs pre-test train and calibration examples',()=>{
  const train=Array.from({length:180},(_,i)=>{
    const a=(i%20)/19,b=((i*7)%17)/16;
    return {z:[a,b,a*b],y:(a>.58&&b>.35)?1:0,realizedR:(a>.58&&b>.35)?.8:-1,at:i};
  });
  const cal=Array.from({length:80},(_,i)=>{
    const a=((i+4)%20)/19,b=((i*5+1)%17)/16;
    return {z:[a,b,a*b],y:(a>.58&&b>.35)?1:0,realizedR:(a>.58&&b>.35)?.8:-1,at:1000+i};
  });
  const base={kind:'logistic',weights:[0,0,0],calibration:{a:1,b:0},planOptions:{name:'test-profile'}};
  const out=research.adaptSetupModel(base,train,cal,.6);
  assert.ok(out.model);
  assert.equal(out.model.planOptions.name,'test-profile');
  assert.ok(['pooled-local-cal','target-local','target-recent'].includes(out.selection.selected));
  assert.equal(out.selection.calibrationSamples,cal.length);
  assert.ok(Number.isFinite(out.model.calibration.a));
  assert.ok(Number.isFinite(out.model.calibration.b));
});
test('conservative plan profiles include positive-expectancy 0.8R choices',()=>{
  const names=setup.PLAN_PROFILES.map(x=>x.name);
  assert.ok(names.includes('tight-0.8r'));
  assert.ok(names.includes('base-0.8r'));
  assert.ok(names.includes('wide-0.8r'));
});


test('side validation can allow only the statistically stronger direction',()=>{
  const model={kind:'logistic',weights:[0,2],calibration:{a:1,b:0}};
  const rows=[];
  for(let i=0;i<20;i++)rows.push({side:'LONG',z:[1],y:i<14?1:0,realizedR:i<14?.8:-1});
  for(let i=0;i<20;i++)rows.push({side:'SHORT',z:[-1],y:i<8?1:0,realizedR:i<8?.8:-1});
  const gate=research.chooseValidatedSides(model,rows,.6);
  assert.deepEqual(gate.allowedSides,['LONG']);
  assert.equal(gate.diagnostics.LONG.passed,true);
  assert.equal(gate.diagnostics.SHORT.passed,false);
});


test('distribution gate rejects unfamiliar feature regimes',()=>{
  const rows=Array.from({length:60},(_,i)=>({z:[1,(i%10)/10,((i*3)%10)/10],side:'LONG'}));
  const gate=setup.fitDistributionGate(rows,{dims:3,quantile:.8});
  assert.ok(gate);
  assert.equal(setup.inDistribution(gate,[1,.4,.4]),true);
  assert.equal(setup.inDistribution(gate,[1,8,8]),false);
});
test('side distribution gates are fit independently',()=>{
  const rows=[];
  for(let i=0;i<30;i++)rows.push({z:[1,i/30],side:'LONG'});
  for(let i=0;i<30;i++)rows.push({z:[-1,-i/30],side:'SHORT'});
  const gates=setup.fitSideDistributionGates(rows,{dims:2,quantile:.8});
  assert.ok(gates.LONG&&gates.SHORT);
  assert.equal(setup.inDistribution(gates.LONG,[1,.4]),true);
  assert.equal(setup.inDistribution(gates.SHORT,[-1,-.4]),true);
});


test('joint policy meta-label keeps only the directional side',()=>{
  const directional={weights:[0,2],calibration:{a:1,b:0}};
  const examples=[
    {side:'LONG',directionalX:[1],z:[1],y:1,realizedR:.8},
    {side:'SHORT',directionalX:[1],z:[-1],y:0,realizedR:-1},
    {side:'SHORT',directionalX:[-1],z:[1],y:1,realizedR:.8}
  ];
  const kept=research.jointPolicyExamples(examples,directional,.55);
  assert.equal(kept.length,2);
  assert.equal(kept[0].side,'LONG');
  assert.equal(kept[1].side,'SHORT');
});
test('joint policy meta-label rejects low directional confidence',()=>{
  const directional={weights:[0,.05],calibration:{a:1,b:0}};
  const examples=[{side:'LONG',directionalX:[1],z:[1],y:1,realizedR:.8}];
  assert.equal(research.jointPolicyExamples(examples,directional,.60).length,0);
});


test('directional model competition returns a calibrated model',()=>{
  const train=Array.from({length:220},(_,i)=>{
    const a=(i%20)/19,b=((i*7)%17)/16;
    return {x:[a,b,a*b],y:(a>.55&&b>.4)?1:0};
  });
  const cal=Array.from({length:80},(_,i)=>{
    const a=((i+3)%20)/19,b=((i*5+1)%17)/16;
    return {x:[a,b,a*b],y:(a>.55&&b>.4)?1:0};
  });
  const out=research.fitDirectionalModel(train,cal);
  assert.ok(out.model);
  assert.ok(['logistic','boosted-stumps'].includes(out.comparison.selected));
  assert.ok(Number.isFinite(out.comparison.logistic.logLoss));
  assert.ok(Number.isFinite(out.comparison.boosted.logLoss));
});


test('best-side selection takes at most one trade per timestamp',()=>{
  const model={kind:'logistic',weights:[0,1],calibration:{a:1,b:0}};
  const rows=[
    {at:1,side:'LONG',z:[2],y:1,realizedR:.8},
    {at:1,side:'SHORT',z:[1],y:0,realizedR:-1},
    {at:2,side:'LONG',z:[-.5],y:0,realizedR:-1},
    {at:2,side:'SHORT',z:[1.5],y:1,realizedR:.8}
  ];
  const chosen=setup.bestSideSelections(model,rows,.6);
  assert.equal(chosen.length,2);
  assert.equal(chosen[0].side,'LONG');
  assert.equal(chosen[1].side,'SHORT');
  assert.equal(new Set(chosen.map(x=>x.at)).size,chosen.length);
});


test('target setup fallback trains from local pre-test examples',()=>{
  const train=Array.from({length:160},(_,i)=>{
    const a=(i%20)/19,b=((i*7)%17)/16;
    return {z:[a,b,a*b],y:(a>.55&&b>.35)?1:0,realizedR:(a>.55&&b>.35)?.8:-1,side:i%2?'LONG':'SHORT',at:i};
  });
  const cal=Array.from({length:60},(_,i)=>{
    const a=((i+3)%20)/19,b=((i*5+1)%17)/16;
    return {z:[a,b,a*b],y:(a>.55&&b>.35)?1:0,realizedR:(a>.55&&b>.35)?.8:-1,side:i%2?'LONG':'SHORT',at:1000+i};
  });
  const out=research.fitTargetSetupFallback(train,cal,{name:'local-test',targetR:.8});
  assert.ok(out?.model);
  assert.equal(out.model.planOptions.name,'local-test');
  assert.ok(['logistic','boosted-stumps'].includes(out.comparison.selected));
});


test('side gate evaluates the high-probability policy subset instead of untraded low-confidence rows',()=>{
  const model={kind:'logistic',weights:[0,1],calibration:{a:1,b:0}};
  const rows=[];
  for(let i=0;i<11;i++)rows.push({side:'SHORT',z:[2],y:i<9?1:0,realizedR:i<9?.8:-1});
  for(let i=0;i<20;i++)rows.push({side:'SHORT',z:[0],y:i<5?1:0,realizedR:i<5?.8:-1});
  const gate=research.chooseValidatedSides(model,rows,.6);
  assert.ok(gate.diagnostics.SHORT.accuracy<.60);
  assert.equal(gate.diagnostics.SHORT.highProbability.selected,11);
  assert.ok(gate.diagnostics.SHORT.highProbability.accuracy>.80);
  assert.ok(gate.diagnostics.SHORT.highProbability.averageR>0);
  assert.ok(gate.diagnostics.SHORT.highProbability.wilsonLower>=.45);
  assert.deepEqual(gate.allowedSides,['SHORT']);
});
test('side gate rejects a marginal 60 percent subset with weak statistical support',()=>{
  const model={kind:'logistic',weights:[0,1],calibration:{a:1,b:0}};
  const rows=Array.from({length:10},(_,i)=>({side:'LONG',z:[2],y:i<6?1:0,realizedR:i<6?.8:-1}));
  const gate=research.chooseValidatedSides(model,rows,.6);
  assert.equal(gate.diagnostics.LONG.highProbability.accuracy,.6);
  assert.ok(gate.diagnostics.LONG.highProbability.wilsonLower<.45);
  assert.equal(gate.diagnostics.LONG.passed,false);
});


test('target plan fallback can select a market-specific conservative profile',()=>{
  const future=Array.from({length:8},()=>({open:100,high:101.0,low:99.9,close:99.9}));
  const rows=Array.from({length:320},(_,i)=>({
    price:100,atr:1,trend:1,technicalBias:.7,regime:'trend',
    priceAction:{bias:.4},context:{macroAvailable:false,newsAvailable:false,macroBias:0,newsSentiment:0},
    x:[.4,.2,.1],at:i*100,setupEnd:i*100+50,futureBars:future
  }));
  const out=research.chooseTargetPlanFallback('EURUSD',rows,0);
  assert.ok(out?.chosen);
  assert.equal(out.chosen.planOptions.name,'tight-0.8r');
  assert.ok(out.chosen.stats.accuracy>.9);
  assert.ok(out.chosen.stats.averageR>0);
});
