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


test('plan selection requires positive expectancy and prefers stronger economic edge',()=>{
  const candidates=[
    {planOptions:{name:'bad'},stats:{samples:100,wilsonLower:.80,averageR:-.1,expectancyLower95:-.2,profitFactorR:.8}},
    {planOptions:{name:'good-a'},stats:{samples:100,wilsonLower:.55,averageR:.12,expectancyLower95:.06,profitFactorR:1.2}},
    {planOptions:{name:'good-b'},stats:{samples:100,wilsonLower:.60,averageR:.05,expectancyLower95:.02,profitFactorR:1.1}}
  ];
  const chosen=setup.choosePlan(candidates,40);
  assert.equal(chosen.planOptions.name,'good-a');
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
  const base={kind:'logistic',weights:[0,0,0,0],calibration:{a:1,b:0},planOptions:{name:'test-profile'}};
  const out=research.adaptSetupModel(base,train,cal,.6);
  assert.ok(out.model);
  assert.equal(out.model.planOptions.name,'test-profile');
  assert.ok(['pooled-local-cal','target-local','target-recent','side-specialized'].includes(out.selection.selected));
  assert.equal(out.selection.calibrationSamples,cal.length);
  if(out.model.kind==='side-composite'){
    const calibrated=Object.values(out.model.sideModels||{}).filter(m=>Number.isFinite(m?.calibration?.a)&&Number.isFinite(m?.calibration?.b));
    assert.ok(calibrated.length>0);
  }else{
    assert.ok(Number.isFinite(out.model.calibration.a));
    assert.ok(Number.isFinite(out.model.calibration.b));
  }
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
  for(let i=0;i<40;i++)rows.push({side:'LONG',z:[1],y:i<32?1:0,realizedR:i<32?.9:-1});
  for(let i=0;i<40;i++)rows.push({side:'SHORT',z:[-1],y:i<14?1:0,realizedR:i<14?.9:-1});
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


test('robust distribution gate follows model-important features',()=>{
  const model={kind:'logistic',weights:[0,.1,4,.2,3],calibration:{a:1,b:0}};
  const features=setup.modelFeatureIndices(model,2,4);
  assert.deepEqual(features,[1,3]);
  const rows=Array.from({length:80},(_,i)=>({side:'LONG',z:[50,1+(i%8)*.02,-40,2+(i%10)*.02]}));
  const gate=setup.fitDistributionGate(rows,{model,maxFeatures:2,quantile:.9});
  assert.deepEqual(gate.features,[1,3]);
  assert.equal(setup.inDistribution(gate,[999,1.05,-999,2.05]),true);
  assert.equal(setup.inDistribution(gate,[0,8,0,9]),false);
});
test('missing distribution gate is not treated as in-distribution',()=>{
  assert.equal(setup.inDistribution(null,[1,2,3]),false);
});


test('side-composite probability routes each direction through its specialized model',()=>{
  const composite={
    kind:'side-composite',
    base:{kind:'logistic',weights:[0,0],calibration:{a:1,b:0}},
    sideModels:{
      LONG:{kind:'logistic',weights:[0,2],calibration:{a:1,b:0}},
      SHORT:{kind:'logistic',weights:[0,-2],calibration:{a:1,b:0}}
    }
  };
  assert.ok(setup.predict(composite,[1])>.8);
  assert.ok(setup.predict(composite,[-1])>.8);
});
test('side-composite falls back to its base model when a side is unavailable',()=>{
  const composite={
    kind:'side-composite',
    base:{kind:'logistic',weights:[0,0],calibration:{a:1,b:0}},
    sideModels:{LONG:{kind:'logistic',weights:[0,2],calibration:{a:1,b:0}}}
  };
  assert.ok(setup.predict(composite,[1])>.8);
  assert.ok(Math.abs(setup.predict(composite,[-1])-.5)<1e-9);
});


test('policy operating stats ignore sides that fail validation',()=>{
  const model={kind:'logistic',weights:[0,2],calibration:{a:1,b:0}};
  const rows=[];
  for(let i=0;i<40;i++)rows.push({at:i,side:'LONG',z:[1],y:i<32?1:0,realizedR:i<32?.9:-1});
  for(let i=0;i<40;i++)rows.push({at:100+i,side:'SHORT',z:[-1],y:i<10?1:0,realizedR:i<10?.9:-1});
  const out=research.policyOperatingStats(model,rows,.6);
  assert.deepEqual(out.sideValidation.allowedSides,['LONG']);
  assert.equal(out.selected,40);
  assert.equal(out.selectedWins,32);
  assert.equal(out.selectedAccuracy,.8);
  assert.ok(out.expectancyLower95>0);
  assert.ok(out.averageR>0);
});


test('recent stability gate vetoes measurable failures but treats sparse recent evidence as neutral',()=>{
  const broad={allowedSides:['LONG','SHORT'],diagnostics:{LONG:{passed:true},SHORT:{passed:true}}};
  const recent={
    recentAllowedSides:['LONG'],
    recentPassesUserFloor:true,
    recentSideDiagnostics:{
      LONG:{passed:true,highProbability:{selected:14,minSamples:10}},
      SHORT:{passed:false,highProbability:{selected:12,minSamples:10}}
    }
  };
  const stable=research.stableSideGate(broad,recent);
  assert.deepEqual(stable.allowedSides,['LONG']);
  assert.deepEqual(stable.recentVetoSides,['SHORT']);
  assert.deepEqual(stable.insufficientRecentSides,[]);

  const sparse=research.stableSideGate(broad,{
    recentAllowedSides:[],
    recentPassesUserFloor:false,
    recentSideDiagnostics:{
      LONG:{passed:false,highProbability:{selected:0,minSamples:10}},
      SHORT:{passed:false,highProbability:{selected:4,minSamples:10}}
    }
  });
  assert.deepEqual(sparse.allowedSides,['LONG','SHORT']);
  assert.deepEqual(sparse.recentVetoSides,[]);
  assert.deepEqual(sparse.insufficientRecentSides,['LONG','SHORT']);
});


test('empirical constant model stays calibrated and bounded',()=>{
  const train=Array.from({length:200},(_,i)=>({z:[i%2],y:i<130?1:0}));
  const cal=Array.from({length:80},(_,i)=>({z:[i%2],y:i<52?1:0}));
  const out=setup.fitCompetitive(train,cal);
  assert.ok(['constant','logistic','boosted-stumps'].includes(out.comparison.selected));
  assert.ok(Number.isFinite(out.comparison.constant.logLoss));
  const p=setup.predict({kind:'constant',probability:.65,calibration:{a:1,b:0}},[1]);
  assert.ok(p>.64&&p<.66);
});
test('constant competitor is preferred when complexity adds no meaningful calibration gain',()=>{
  const train=Array.from({length:240},(_,i)=>({z:[(i%11)/10],y:i%5<3?1:0}));
  const cal=Array.from({length:100},(_,i)=>({z:[((i*7)%11)/10],y:i%5<3?1:0}));
  const out=setup.fitCompetitive(train,cal);
  assert.equal(out.comparison.selected,'constant');
});


test('isotonic calibration is monotone and bounded',()=>{
  const raw={kind:'logistic',weights:[0,1]};
  const rows=Array.from({length:120},(_,i)=>{
    const z=[(i-60)/20];
    const y=i<35?0:i<65?(i%3===0?1:0):1;
    return {z,y,at:i};
  });
  const cal=setup.fitIsotonicCalibration(raw,rows,{minBin:12,maxBins:6});
  assert.equal(cal.kind,'isotonic');
  assert.ok(cal.probs.every(p=>p>0&&p<1));
  for(let i=1;i<cal.probs.length;i++)assert.ok(cal.probs[i]>=cal.probs[i-1]);
  for(const score of [-5,-1,0,1,5]){
    const p=setup.applyCalibration(cal,score);
    assert.ok(p>0&&p<1);
  }
});
test('best calibration chooses only platt or isotonic using chronological validation',()=>{
  const raw={kind:'logistic',weights:[0,1]};
  const rows=Array.from({length:140},(_,i)=>({z:[(i-70)/20],y:i>80?1:0,at:i}));
  const out=setup.fitBestCalibration(raw,rows);
  assert.ok(['platt','isotonic'].includes(out.comparison.selected));
  assert.ok(out.comparison.fitSamples>0);
  assert.ok(out.comparison.validationSamples>0);
});


test('score gate promotes only a stable top-ranked subset above the 60% policy floor',()=>{
  const base={kind:'logistic',weights:[0,0,1]};
  const rows=Array.from({length:120},(_,i)=>{
    const score=i/119;
    const high=i>=72;
    const y=high?(i%5!==0?1:0):(i%5===0?1:0);
    return {z:[1,score],side:'LONG',y,realizedR:y?.8:-1,at:i};
  });
  const gate=setup.fitScoreGate(base,rows,{threshold:.60,minSamples:12});
  assert.ok(gate);
  assert.ok(gate.model.bySide.LONG);
  assert.ok(gate.model.bySide.LONG.highProbability>.60);
  const hi=setup.predict(gate.model,[1,.98]);
  const lo=setup.predict(gate.model,[1,.05]);
  assert.ok(hi>.60);
  assert.ok(lo<.60);
});

test('score gate refuses a high-ranked subset with negative expectancy',()=>{
  const base={kind:'logistic',weights:[0,0,1]};
  const rows=Array.from({length:120},(_,i)=>{
    const score=i/119;
    const y=i>=72?(i%2===0?1:0):(i%4===0?1:0);
    return {z:[1,score],side:'LONG',y,realizedR:y?.2:-1,at:i};
  });
  const gate=setup.fitScoreGate(base,rows,{threshold:.60,minSamples:12});
  assert.equal(gate,null);
});


test('v38 score gate requires at least 30 discovery examples by default',()=>{
  const base={kind:'logistic',weights:[0,0,1]};
  const rows=Array.from({length:100},(_,i)=>{
    const high=i>=70,y=high?(i%5!==0?1:0):(i%5===0?1:0);
    return {z:[1,i/99],side:'LONG',y,realizedR:y?.9:-1,at:i};
  });
  const gate=setup.fitScoreGate(base,rows,{threshold:.60});
  assert.ok(gate?.model?.bySide?.LONG);
  assert.ok(gate.model.bySide.LONG.samples>=30);
});

test('risk summary reports drawdown and rolling expectancy',()=>{
  const rows=Array.from({length:60},(_,i)=>({at:i,y:i%3?1:0,realizedR:i%3?.8:-1}));
  const stats=setup.summarizeExamples(rows);
  assert.ok(Number.isFinite(stats.maxDrawdownR));
  assert.ok(Number.isFinite(stats.worstRolling20R));
  assert.ok(Number.isFinite(stats.worstRolling50R));
});


test('expectancy confidence is positive only when the R distribution supports it',()=>{
  const strong=Array.from({length:80},(_,i)=>({at:i,y:i%5!==0?1:0,realizedR:i%5!==0?.9:-1}));
  const weak=Array.from({length:80},(_,i)=>({at:i,y:i%2===0?1:0,realizedR:i%2===0?.6:-1}));
  const a=setup.summarizeExamples(strong),b=setup.summarizeExamples(weak);
  assert.ok(a.averageR>0);
  assert.ok(a.expectancyLower95>0);
  assert.ok(b.averageR<0);
  assert.ok(b.expectancyLower95<0);
});

test('plan selection prefers stronger net expectancy over a higher win rate',()=>{
  const highWinLowEdge={planOptions:{name:'high-win-low-edge'},stats:setup.summarizeExamples(
    Array.from({length:100},(_,i)=>({at:i,y:i<75?1:0,realizedR:i<75?.25:-1}))
  )};
  const lowerWinHighEdge={planOptions:{name:'lower-win-high-edge'},stats:setup.summarizeExamples(
    Array.from({length:100},(_,i)=>({at:i,y:i<55?1:0,realizedR:i<55?1.4:-1}))
  )};
  assert.ok(highWinLowEdge.stats.accuracy>lowerWinHighEdge.stats.accuracy);
  assert.ok(lowerWinHighEdge.stats.averageR>highWinLowEdge.stats.averageR);
  const chosen=setup.choosePlan([highWinLowEdge,lowerWinHighEdge],40);
  assert.equal(chosen.planOptions.name,'lower-win-high-edge');
});

test('trade outcome deducts row-specific execution costs and financing from R',()=>{
  const row={
    price:100,atr:1,trend:1,technicalBias:.8,regime:'trend',at:0,barMs:14_400_000,
    costBps:20,financingBpsPerDay:4,priceAction:{bias:.5},context:{macroAvailable:false,newsAvailable:false},
    x:[1],futureBars:[{ts:1,open:100,high:101.5,low:100,close:101},{ts:14_400_001,open:101,high:103,low:100.5,close:102}]
  };
  const result=setup.outcome(row,'EURUSD','LONG',0,{entryBufferAtr:0,stopAtr:1,targetR:2,entryExpiryBars:1,holdBars:2});
  assert.equal(result.settled,true);
  assert.ok(result.totalCostBps>20);
  assert.ok(result.realizedR<2);
});
