const {buildTradePlan}=require('./tradePlan');

const sigmoid=z=>1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));
const dot=(w,x)=>w[0]+x.reduce((s,v,i)=>s+w[i+1]*v,0);

function vector(row,side){
  const sign=side==='LONG'?1:-1;
  const x=(row.x||[]).map(v=>Number(v)||0);
  const signed=x.map(v=>sign*v);
  const magnitude=x.slice(0,16).map(v=>Math.abs(v));
  return [sign,...signed,...magnitude];
}
function fit(rows){
  if(rows.length<100)throw new Error('Insufficient triggered setup samples');
  const w=Array(rows[0].z.length+1).fill(0);
  for(let epoch=0;epoch<160;epoch++){
    const g=Array(w.length).fill(0);
    for(const r of rows){
      const err=sigmoid(dot(w,r.z))-r.y;
      g[0]+=err;
      r.z.forEach((v,i)=>g[i+1]+=err*v);
    }
    w.forEach((v,i)=>w[i]-=.12*(g[i]/rows.length+(i?.002*v:0)));
  }
  return w;
}
function calibrate(weights,rows){
  if(rows.length<30)return {a:1,b:0};
  let a=1,b=0;
  for(let k=0;k<250;k++){
    let da=0,db=0;
    for(const r of rows){
      const z=dot(weights,r.z),e=sigmoid(a*z+b)-r.y;
      da+=e*z;db+=e;
    }
    a-=.04*(da/rows.length+.01*(a-1));
    b-=.04*db/rows.length;
  }
  return {a,b};
}
function rawScore(model,z){
  if(model?.kind==='constant'){
    const p=Math.max(.001,Math.min(.999,Number(model.probability)||.5));
    return Math.log(p/(1-p));
  }
  if(model?.kind==='boosted-stumps'){
    let score=Number(model.baseScore||0);
    for(const s of model.stumps||[])score+=z[s.feature]<=s.threshold?s.left:s.right;
    return score;
  }
  return dot(model.weights,z);
}
function calibrateModel(model,rows){
  if(rows.length<30)return {a:1,b:0};
  let a=1,b=0;
  for(let k=0;k<250;k++){
    let da=0,db=0;
    for(const r of rows){
      const z=rawScore(model,r.z),e=sigmoid(a*z+b)-r.y;
      da+=e*z;db+=e;
    }
    a-=.04*(da/rows.length+.01*(a-1));
    b-=.04*db/rows.length;
  }
  return {a,b};
}
function resolvePredictModel(model,z){
  if(model?.kind!=='side-composite')return model;
  const side=Number(z?.[0]||0)>=0?'LONG':'SHORT';
  return model.sideModels?.[side]||model.base||null;
}
function applyCalibration(calibration,score){
  if(calibration?.kind==='isotonic'){
    const cuts=calibration.cuts||[],probs=calibration.probs||[];
    if(!probs.length)return .5;
    let i=0;while(i<cuts.length-1&&score>cuts[i])i++;
    return Math.max(.001,Math.min(.999,Number(probs[Math.min(i,probs.length-1)])||.5));
  }
  return sigmoid((calibration?.a??1)*score+(calibration?.b??0));
}
function predictScoreGate(model,z){
  const side=Number(z?.[0]||0)>=0?'LONG':'SHORT',gate=model.bySide?.[side];
  if(!gate)return .5;
  const base=resolvePredictModel(model.base,z);
  if(!base)return .5;
  const score=rawScore(base,z);
  return score>=gate.cutoff?gate.highProbability:gate.lowProbability;
}
const predict=(model,z)=>{
  if(model?.kind==='score-gate')return predictScoreGate(model,z);
  const resolved=resolvePredictModel(model,z);
  if(!resolved)return .5;
  if(resolved?.kind==='score-gate')return predictScoreGate(resolved,z);
  return applyCalibration(resolved.calibration,rawScore(resolved,z));
};
function fitScoreGate(baseModel,rows,{threshold=.60,minSamples=30}={}){
  const bySide={},diagnostics={};
  for(const side of ['LONG','SHORT']){
    const part=(rows||[]).filter(x=>x.side===side).map(x=>{
      const base=resolvePredictModel(baseModel,x.z);
      return {...x,raw:base?rawScore(base,x.z):0};
    }).sort((a,b)=>b.raw-a.raw);
    if(part.length<minSamples){
      diagnostics[side]={available:false,samples:part.length,reason:'insufficient-side-samples'};
      continue;
    }
    const sizes=[.15,.20,.25,.30,.40,.50].map(frac=>Math.max(minSamples,Math.floor(part.length*frac)));
    const candidates=[...new Set(sizes)].filter(n=>n<=part.length).map(n=>{
      const selected=part.slice(0,n),stats=summarizeExamples(selected);
      const highProbability=(stats.wins+2)/(stats.samples+4);
      return {n,cutoff:selected.at(-1).raw,highProbability,stats,
        passed:stats.samples>=minSamples&&highProbability>=threshold&&(stats.averageR||0)>0&&(stats.profitFactorR===null||stats.profitFactorR>1)&&(stats.expectancyLower95??-Infinity)>0};
    });
    const passing=candidates.filter(x=>x.passed).sort((a,b)=>((b.stats.expectancyLower95??-Infinity)-(a.stats.expectancyLower95??-Infinity))||((b.stats.averageR||0)-(a.stats.averageR||0))||((b.stats.profitFactorR||0)-(a.stats.profitFactorR||0))||(b.n-a.n));
    const chosen=passing[0];
    diagnostics[side]={available:true,samples:part.length,candidates:candidates.map(x=>({n:x.n,cutoff:x.cutoff,highProbability:x.highProbability,accuracy:x.stats.accuracy,averageR:x.stats.averageR,expectancyLower95:x.stats.expectancyLower95,profitFactorR:x.stats.profitFactorR,wilsonLower:x.stats.wilsonLower,passed:x.passed})),chosen:chosen?{n:chosen.n,highProbability:chosen.highProbability,accuracy:chosen.stats.accuracy,averageR:chosen.stats.averageR,expectancyLower95:chosen.stats.expectancyLower95,profitFactorR:chosen.stats.profitFactorR,wilsonLower:chosen.stats.wilsonLower}:null};
    if(!chosen)continue;
    const rest=part.slice(chosen.n),restWins=rest.reduce((s,x)=>s+x.y,0);
    const lowProbability=Math.min(.59,rest.length?(restWins+2)/(rest.length+4):.5);
    bySide[side]={cutoff:chosen.cutoff,highProbability:Math.max(threshold+.001,Math.min(.95,chosen.highProbability)),lowProbability:Math.max(.05,Math.min(.59,lowProbability)),samples:chosen.n};
  }
  if(!Object.keys(bySide).length)return null;
  return {model:{kind:'score-gate',base:baseModel,bySide},diagnostics};
}
function fitIsotonicCalibration(model,rows,{minBin=12,maxBins=8}={}){
  if(!rows?.length)return {kind:'isotonic',cuts:[Infinity],probs:[.5],bins:1};
  const sorted=rows.map(r=>({score:rawScore(model,r.z),y:r.y})).sort((a,b)=>a.score-b.score);
  const binCount=Math.max(1,Math.min(maxBins,Math.floor(sorted.length/Math.max(4,minBin))));
  const bins=[];
  for(let b=0;b<binCount;b++){
    const start=Math.floor(b*sorted.length/binCount),end=Math.floor((b+1)*sorted.length/binCount);
    const part=sorted.slice(start,end);if(!part.length)continue;
    bins.push({n:part.length,wins:part.reduce((s,x)=>s+x.y,0),maxScore:part.at(-1).score});
  }
  for(const bin of bins)bin.p=(bin.wins+1)/(bin.n+2);
  let i=1;
  while(i<bins.length){
    if(bins[i-1].p<=bins[i].p){i++;continue;}
    const left=bins[i-1],right=bins[i],merged={n:left.n+right.n,wins:left.wins+right.wins,maxScore:right.maxScore};
    merged.p=(merged.wins+1)/(merged.n+2);
    bins.splice(i-1,2,merged);i=Math.max(1,i-1);
  }
  return {kind:'isotonic',cuts:bins.map(x=>x.maxScore),probs:bins.map(x=>x.p),bins:bins.length,minBin};
}
function fitBestCalibration(model,rows){
  if((rows||[]).length<60)return {calibration:calibrateModel(model,rows||[]),comparison:{selected:'platt',reason:'small-calibration-sample'}};
  const ordered=[...rows].sort((a,b)=>(a.at||0)-(b.at||0));
  const cut=Math.max(30,Math.min(ordered.length-20,Math.floor(ordered.length*.70)));
  const fitRows=ordered.slice(0,cut),validation=ordered.slice(cut);
  const platt=calibrateModel(model,fitRows),iso=fitIsotonicCalibration(model,fitRows);
  const plattMetrics=probabilityMetrics({...model,calibration:platt},validation);
  const isoMetrics=probabilityMetrics({...model,calibration:iso},validation);
  const useIso=iso.bins>=2&&Number.isFinite(isoMetrics.logLoss)&&isoMetrics.logLoss+.01<plattMetrics.logLoss;
  const selected=useIso?'isotonic':'platt';
  return {
    calibration:selected==='isotonic'?fitIsotonicCalibration(model,ordered):calibrateModel(model,ordered),
    comparison:{selected,fitSamples:fitRows.length,validationSamples:validation.length,platt:plattMetrics,isotonic:isoMetrics,requiredImprovement:.01}
  };
}

function fitBoosted(rows,{rounds=30,learningRate=.12,lambda=1}={}){
  if(rows.length<100)throw new Error('Insufficient triggered setup samples');
  const dim=rows[0].z.length,mean=Math.max(.01,Math.min(.99,rows.reduce((s,r)=>s+r.y,0)/rows.length));
  const baseScore=Math.log(mean/(1-mean)),scores=Array(rows.length).fill(baseScore),stumps=[];
  const thresholds=Array.from({length:dim},(_,j)=>{
    const v=rows.map(r=>r.z[j]).sort((a,b)=>a-b),out=[];
    for(const q of [.2,.4,.6,.8]){
      const x=v[Math.min(v.length-1,Math.floor((v.length-1)*q))];
      if(Number.isFinite(x)&&!out.includes(x))out.push(x);
    }
    return out;
  });
  for(let round=0;round<rounds;round++){
    const g=rows.map((r,i)=>r.y-sigmoid(scores[i])),h=rows.map((r,i)=>{const p=sigmoid(scores[i]);return Math.max(1e-4,p*(1-p));});
    let best=null;
    for(let j=0;j<dim;j++)for(const threshold of thresholds[j]){
      let gl=0,hl=0,gr=0,hr=0,nl=0,nr=0;
      for(let i=0;i<rows.length;i++){
        if(rows[i].z[j]<=threshold){gl+=g[i];hl+=h[i];nl++;}else{gr+=g[i];hr+=h[i];nr++;}
      }
      if(nl<10||nr<10)continue;
      const gain=gl*gl/(hl+lambda)+gr*gr/(hr+lambda);
      if(!best||gain>best.gain){
        const clip=x=>Math.max(-2,Math.min(2,x));
        best={feature:j,threshold,left:learningRate*clip(gl/(hl+lambda)),right:learningRate*clip(gr/(hr+lambda)),gain};
      }
    }
    if(!best||best.gain<1e-6)break;
    stumps.push(best);
    for(let i=0;i<rows.length;i++)scores[i]+=rows[i].z[best.feature]<=best.threshold?best.left:best.right;
  }
  return {kind:'boosted-stumps',baseScore,stumps};
}
function probabilityMetrics(model,rows){
  if(!rows.length)return {samples:0,logLoss:null,brier:null,accuracy:null};
  let ll=0,brier=0,correct=0;
  for(const r of rows){
    const p=predict(model,r.z);
    ll-=r.y*Math.log(p+1e-9)+(1-r.y)*Math.log(1-p+1e-9);
    brier+=(p-r.y)**2;correct+=(p>=.5)===(r.y===1);
  }
  return {samples:rows.length,logLoss:ll/rows.length,brier:brier/rows.length,accuracy:correct/rows.length};
}
function fitCompetitive(trainRows,calRows){
  const logisticBase={kind:'logistic',weights:fit(trainRows)},logisticCal=fitBestCalibration(logisticBase,calRows);
  const logistic={...logisticBase,calibration:logisticCal.calibration};
  const boostedBase=fitBoosted(trainRows),boostedCal=fitBestCalibration(boostedBase,calRows);
  const boosted={...boostedBase,calibration:boostedCal.calibration};
  const trainWins=trainRows.reduce((s,r)=>s+r.y,0);
  const constantBase={kind:'constant',probability:(trainWins+1)/(trainRows.length+2)},constantCal=fitBestCalibration(constantBase,calRows);
  const constant={...constantBase,calibration:constantCal.calibration};
  const logisticMetrics=probabilityMetrics(logistic,calRows),boostedMetrics=probabilityMetrics(boosted,calRows),constantMetrics=probabilityMetrics(constant,calRows);
  const complexBest=boostedMetrics.logLoss+0.005<logisticMetrics.logLoss
    ?{name:'boosted-stumps',model:boosted,metrics:boostedMetrics}
    :{name:'logistic',model:logistic,metrics:logisticMetrics};
  const preferConstant=constantMetrics.logLoss<=complexBest.metrics.logLoss+0.003;
  const selected=preferConstant?'constant':complexBest.name;
  const model=preferConstant?constant:complexBest.model;
  return {model,comparison:{
    selected,logistic:logisticMetrics,boosted:boostedMetrics,constant:constantMetrics,
    calibration:{logistic:logisticCal.comparison,boosted:boostedCal.comparison,constant:constantCal.comparison},
    minimumBoostedImprovement:.005,constantSimplicityTolerance:.003
  }};
}

function modelFeatureIndices(model,maxFeatures=10,featureCount=0){
  if(model?.kind==='score-gate')return modelFeatureIndices(model.base,maxFeatures,featureCount);
  const scores=new Map();
  if(model?.kind==='boosted-stumps'){
    for(const stump of model.stumps||[]){
      const feature=Number(stump.feature);
      if(!Number.isInteger(feature)||feature<0)continue;
      const importance=Math.max(1e-9,Number(stump.gain||0)+Math.abs(Number(stump.left||0)-Number(stump.right||0)));
      scores.set(feature,(scores.get(feature)||0)+importance);
    }
  }else if(Array.isArray(model?.weights)){
    for(let i=1;i<model.weights.length;i++)scores.set(i-1,Math.abs(Number(model.weights[i]||0)));
  }
  const ranked=[...scores.entries()].filter(([,score])=>Number.isFinite(score)&&score>0).sort((x,y)=>y[1]-x[1]).map(([feature])=>feature);
  const fallback=Array.from({length:Math.max(0,Number(featureCount)||0)},(_,i)=>i);
  return [...new Set([...ranked,...fallback])].slice(0,Math.max(1,Number(maxFeatures)||10));
}
function median(values){
  if(!values.length)return 0;
  const sorted=[...values].sort((x,y)=>x-y),mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}
function fitDistributionGate(rows,{features=null,model=null,maxFeatures=10,quantile=.90}={}){
  if(!rows?.length)return null;
  const indices=(Array.isArray(features)&&features.length?features:modelFeatureIndices(model,maxFeatures,rows[0].z.length))
    .filter(i=>Number.isInteger(i)&&i>=0&&i<rows[0].z.length);
  if(!indices.length)return null;
  const center=indices.map(i=>median(rows.map(row=>Number(row.z[i]||0))));
  const scale=indices.map((i,j)=>{
    const mad=median(rows.map(row=>Math.abs(Number(row.z[i]||0)-center[j])));
    return Math.max(.05,1.4826*mad);
  });
  const distance=z=>Math.sqrt(indices.reduce((sum,feature,j)=>sum+((Number(z[feature]||0)-center[j])/scale[j])**2,0)/indices.length);
  const distances=rows.map(row=>distance(row.z)).sort((x,y)=>x-y);
  const q=Math.max(.70,Math.min(.98,Number(quantile)||.90));
  const threshold=distances[Math.min(distances.length-1,Math.floor((distances.length-1)*q))];
  return {type:'robust-important-features',features:indices,center,scale,threshold,quantile:q,calibrationSamples:rows.length};
}
function distributionDistance(gate,z){
  if(!gate)return Infinity;
  if(Array.isArray(gate.features)&&Array.isArray(gate.center)){
    let sum=0;
    for(let j=0;j<gate.features.length;j++){
      const feature=gate.features[j],scale=Math.max(.05,Number(gate.scale?.[j]||1));
      sum+=((Number(z[feature]||0)-Number(gate.center[j]||0))/scale)**2;
    }
    return Math.sqrt(sum/Math.max(1,gate.features.length));
  }
  let sum=0;
  for(let j=0;j<gate.dims;j++)sum+=((Number(z[j]||0)-gate.mean[j])/gate.scale[j])**2;
  return Math.sqrt(sum/gate.dims);
}
function inDistribution(gate,z){return !!gate&&distributionDistance(gate,z)<=gate.threshold;}
function fitSideDistributionGates(rows,options={}){
  const out={};
  for(const side of ['LONG','SHORT']){
    const part=rows.filter(x=>x.side===side);
    if(part.length>=20){
      const model=options.model?.kind==='side-composite'?(options.model.sideModels?.[side]||options.model.base):options.model;
      out[side]=fitDistributionGate(part,{...options,model});
    }
  }
  return out;
}

function rangeReversionScore(row,side){
  const sign=side==='LONG'?1:-1;
  const rsiBias=Number(row.x?.[3]||0);
  const momentum=Number(row.x?.[2]||0);
  const bbBias=Number(row.x?.[11]||0);
  const raw=-.45*rsiBias-.35*bbBias-.20*Math.tanh(momentum);
  return sign*raw;
}
function eligible(row,side,costBps,family='trend'){
  const sign=side==='LONG'?1:-1;
  const effectiveCostBps=Number(row.costBps??costBps??0);
  if(Number(row.atr||0)/Math.max(Number(row.price||0),1e-12)*10000<effectiveCostBps*2)return false;
  if(row.context?.newsAvailable&&((side==='LONG'&&Number(row.context.newsSentiment||0)<-.25)||(side==='SHORT'&&Number(row.context.newsSentiment||0)>.25)))return false;
  if(row.context?.macroAvailable&&((side==='LONG'&&Number(row.context.macroBias||0)<-.35)||(side==='SHORT'&&Number(row.context.macroBias||0)>.35)))return false;
  if(family==='range'){
    if(row.regime!=='range')return false;
    if(rangeReversionScore(row,side)<.25)return false;
    if(side==='LONG'&&Number(row.priceAction?.bias||0)<-.70)return false;
    if(side==='SHORT'&&Number(row.priceAction?.bias||0)>.70)return false;
    return true;
  }
  if(row.regime!=='trend'||sign*Number(row.trend||0)<=0)return false;
  if(side==='LONG'&&Number(row.priceAction?.bias||0)<-.34)return false;
  if(side==='SHORT'&&Number(row.priceAction?.bias||0)>.34)return false;
  const fundamentalBias=.6*Number(row.context?.macroBias||0)+.4*Number(row.context?.newsSentiment||0);
  const confluence=sign*(.58*Number(row.technicalBias||0)+.22*Number(row.priceAction?.bias||0)+.20*fundamentalBias);
  return confluence>=.10;
}

function outcome(row,symbol,side,costBps,planOptions={}){
  const sign=side==='LONG'?1:-1;
  const pseudo={symbol,price:row.price,leanDirection:side,candidateDirection:side,features:row,priceAction:row.priceAction};
  const plan=buildTradePlan(pseudo,{side,...planOptions}),future=row.futureBars||[];
  const effectiveCostBps=Math.max(0,Number(row.costBps??costBps??0));
  const financingBpsPerDay=Math.max(0,Number(row.financingBpsPerDay||0));
  let trigger=-1;
  for(let i=0;i<Math.min(plan.entryExpiryBars,future.length);i++){
    if(side==='LONG'?future[i].high>=plan.entry:future[i].low<=plan.entry){trigger=i;break;}
  }
  if(trigger<0)return {triggered:false,settled:false,plan};
  const active=future.slice(trigger,trigger+plan.holdBars);
  let exit=null,result=null,exitIndex=-1;
  for(let i=0;i<active.length;i++){
    const bar=active[i];
    const stopHit=side==='LONG'?bar.low<=plan.stop:bar.high>=plan.stop;
    const targetHit=side==='LONG'?bar.high>=plan.target:bar.low<=plan.target;
    if(stopHit&&targetHit){exit=plan.stop;result='SL';exitIndex=i;break;}
    if(stopHit){exit=plan.stop;result='SL';exitIndex=i;break;}
    if(targetHit){exit=plan.target;result='TP';exitIndex=i;break;}
  }
  if(!result&&active.length>=plan.holdBars){
    exit=active.at(-1).close;exitIndex=active.length-1;
    const barMs=Math.max(0,Number(row.barMs||0));
    const elapsedMs=barMs&&active[0]&&active[exitIndex]?Math.max(barMs,Number(active[exitIndex].ts)-Number(active[0].ts)+barMs):0;
    const totalCostBps=effectiveCostBps+financingBpsPerDay*(elapsedMs/86400000);
    const net=sign*(exit/plan.entry-1)-totalCostBps/10000;
    result=net>0?'TIMEOUT_WIN':'TIMEOUT_LOSS';
  }
  if(!result)return {triggered:true,settled:false,plan};
  const barMs=Math.max(0,Number(row.barMs||0));
  const elapsedMs=barMs&&active[0]&&active[exitIndex]?Math.max(barMs,Number(active[exitIndex].ts)-Number(active[0].ts)+barMs):0;
  const holdingDays=elapsedMs/86400000;
  const totalCostBps=effectiveCostBps+financingBpsPerDay*holdingDays;
  const stopFrac=Math.abs(plan.entry-plan.stop)/Math.max(plan.entry,1e-12);
  const realizedR=sign*(exit-plan.entry)/Math.max(Math.abs(plan.entry-plan.stop),1e-12)-(totalCostBps/10000)/Math.max(stopFrac,1e-12);
  const y=(result==='TP'||result==='TIMEOUT_WIN')?1:0;
  return {triggered:true,settled:true,plan,outcome:result,exit,y,realizedR,effectiveCostBps,totalCostBps,holdingDays};
}
function examples(rows,symbol,costBps,planOptions={}){
  const out=[];
  for(const row of rows){
    for(const side of ['LONG','SHORT']){
      const family=planOptions.strategyFamily||'trend';
      if(!eligible(row,side,costBps,family))continue;
      const result=outcome(row,symbol,side,costBps,planOptions);
      if(!result.triggered||!result.settled)continue;
      const regimeKey=row.regime==='trend'?(Math.abs(Number(row.trend||0))>=1.5?'strong-trend':'trend'):String(row.regime||'unknown');
      out.push({z:vector(row,side),directionalX:row.x,y:result.y,realizedR:result.realizedR,side,at:row.at,outcome:result.outcome,regimeKey,effectiveCostBps:result.effectiveCostBps,totalCostBps:result.totalCostBps,holdingDays:result.holdingDays});
    }
  }
  return out;
}
const PLAN_PROFILES=[
  {name:'range-tight-0.7r',strategyFamily:'range',entryBufferAtr:.05,stopAtr:1.0,targetR:.7,entryExpiryBars:3,holdBars:5},
  {name:'range-base-0.8r',strategyFamily:'range',entryBufferAtr:.08,stopAtr:1.2,targetR:.8,entryExpiryBars:3,holdBars:6},
  {name:'range-wide-0.8r',strategyFamily:'range',entryBufferAtr:.12,stopAtr:1.4,targetR:.8,entryExpiryBars:3,holdBars:6},
  {name:'range-patient-0.9r',strategyFamily:'range',entryBufferAtr:.08,stopAtr:1.4,targetR:.9,entryExpiryBars:3,holdBars:8},
  {name:'tight-0.8r',entryBufferAtr:.08,stopAtr:1.0,targetR:.8,entryExpiryBars:4,holdBars:6},
  {name:'base-0.8r',entryBufferAtr:.12,stopAtr:1.2,targetR:.8,entryExpiryBars:4,holdBars:6},
  {name:'wide-0.8r',entryBufferAtr:.18,stopAtr:1.4,targetR:.8,entryExpiryBars:4,holdBars:6},
  {name:'base-0.9r',entryBufferAtr:.12,stopAtr:1.2,targetR:.9,entryExpiryBars:4,holdBars:6},
  {name:'wide-0.9r',entryBufferAtr:.18,stopAtr:1.4,targetR:.9,entryExpiryBars:4,holdBars:6},
  {name:'tight-1r',entryBufferAtr:.08,stopAtr:1.0,targetR:1.0,entryExpiryBars:4,holdBars:6},
  {name:'base-1r',entryBufferAtr:.12,stopAtr:1.2,targetR:1.0,entryExpiryBars:4,holdBars:6},
  {name:'wide-1r',entryBufferAtr:.18,stopAtr:1.4,targetR:1.0,entryExpiryBars:4,holdBars:6},
  {name:'tight-1.25r',entryBufferAtr:.08,stopAtr:1.0,targetR:1.25,entryExpiryBars:4,holdBars:6},
  {name:'base-1.25r',entryBufferAtr:.12,stopAtr:1.2,targetR:1.25,entryExpiryBars:4,holdBars:6},
  {name:'wide-1.25r',entryBufferAtr:.18,stopAtr:1.4,targetR:1.25,entryExpiryBars:4,holdBars:6},
  {name:'tight-1.5r',entryBufferAtr:.08,stopAtr:1.0,targetR:1.5,entryExpiryBars:4,holdBars:6},
  {name:'base-1.5r',entryBufferAtr:.12,stopAtr:1.2,targetR:1.5,entryExpiryBars:4,holdBars:6},
  {name:'wide-1.5r',entryBufferAtr:.18,stopAtr:1.4,targetR:1.5,entryExpiryBars:4,holdBars:6},
  {name:'patient-1r',entryBufferAtr:.12,stopAtr:1.4,targetR:1.0,entryExpiryBars:4,holdBars:8},
  {name:'patient-1.25r',entryBufferAtr:.12,stopAtr:1.4,targetR:1.25,entryExpiryBars:4,holdBars:8},
  {name:'patient-1.5r',entryBufferAtr:.12,stopAtr:1.4,targetR:1.5,entryExpiryBars:4,holdBars:8}
];
function wilsonLower(wins,n,z=1.96){
  if(!n)return 0;
  const p=wins/n,z2=z*z,den=1+z2/n;
  return (p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/den;
}
function rollingTotal(values,size){
  if(values.length<size)return null;
  let sum=values.slice(0,size).reduce((a,b)=>a+b,0),worst=sum;
  for(let i=size;i<values.length;i++){sum+=values[i]-values[i-size];if(sum<worst)worst=sum;}
  return worst;
}
function summarizeExamples(rows){
  const ordered=[...(rows||[])].sort((a,b)=>(a.at||0)-(b.at||0));
  const n=ordered.length,wins=ordered.filter(r=>r.y===1).length;
  const rs=ordered.map(r=>Number(r.realizedR)||0);
  const averageR=n?rs.reduce((s,v)=>s+v,0)/n:null;
  const variance=n>1?rs.reduce((s,v)=>s+(v-averageR)**2,0)/(n-1):0;
  const standardErrorR=n?Math.sqrt(variance/n):null;
  const expectancyLower95=n?averageR-1.96*standardErrorR:null;
  const positive=rs.filter(v=>v>0),negative=rs.filter(v=>v<0);
  const averageWinR=positive.length?positive.reduce((s,v)=>s+v,0)/positive.length:null;
  const averageLossR=negative.length?Math.abs(negative.reduce((s,v)=>s+v,0)/negative.length):null;
  const gainR=rs.reduce((s,v)=>s+Math.max(0,v),0),lossR=rs.reduce((s,v)=>s+Math.max(0,-v),0);
  let equity=0,peak=0,maxDrawdownR=0;
  for(const value of rs){equity+=value;peak=Math.max(peak,equity);maxDrawdownR=Math.max(maxDrawdownR,peak-equity);}
  return {
    samples:n,wins,accuracy:n?wins/n:null,wilsonLower:wilsonLower(wins,n),
    averageR,expectancyR:averageR,expectancyLower95,standardErrorR,averageWinR,averageLossR,
    profitFactorR:lossR?gainR/lossR:null,maxDrawdownR,
    worstRolling20R:rollingTotal(rs,20),worstRolling50R:rollingTotal(rs,50)
  };
}
function choosePlan(candidates,minSamples=40){
  const viable=(candidates||[]).filter(x=>x.stats.samples>=minSamples&&Number.isFinite(x.stats.averageR)&&x.stats.averageR>0&&(x.stats.profitFactorR===null||x.stats.profitFactorR>1));
  if(!viable.length)return null;
  viable.sort((a,b)=>((b.stats.expectancyLower95??-Infinity)-(a.stats.expectancyLower95??-Infinity))||((b.stats.averageR||0)-(a.stats.averageR||0))||((b.stats.profitFactorR||0)-(a.stats.profitFactorR||0))||(b.stats.samples-a.stats.samples));
  return viable[0];
}

function bestSideSelections(model,rows,threshold){
  const byAt=new Map();
  for(const row of rows||[]){
    const p=predict(model,row.z);
    const current=byAt.get(row.at);
    if(!current||p>current.p)byAt.set(row.at,{...row,p});
  }
  return [...byAt.values()].filter(row=>row.p>=threshold);
}
function statsAt(model,rows,threshold){
  const chosen=bestSideSelections(model,rows,threshold),stats=summarizeExamples(chosen);
  return {
    threshold,selected:stats.samples,selectedAccuracy:stats.accuracy,selectedWins:stats.wins,
    averageR:stats.averageR,expectancyR:stats.expectancyR,expectancyLower95:stats.expectancyLower95,standardErrorR:stats.standardErrorR,
    averageWinR:stats.averageWinR,averageLossR:stats.averageLossR,profitFactorR:stats.profitFactorR,maxDrawdownR:stats.maxDrawdownR,
    worstRolling20R:stats.worstRolling20R,worstRolling50R:stats.worstRolling50R
  };
}
function quantile(values,q){
  if(!values.length)return null;
  const a=[...values].sort((x,y)=>x-y),p=(a.length-1)*q,lo=Math.floor(p),hi=Math.ceil(p);
  return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(p-lo);
}
function thresholdSweep(model,rows){
  return [.40,.45,.50,.55,.60,.65,.70,.75,.80].map(t=>statsAt(model,rows,t));
}
function evaluate(model,rows,threshold=.7){
  if(!rows.length)return {samples:0,baseRate:null,accuracy:null,logLoss:null,brier:null,baselineLoss:null,selected:0,selectedAccuracy:null,averageR:null,profitFactorR:null,sweep:[]};
  const base=Math.max(.001,Math.min(.999,rows.reduce((s,r)=>s+r.y,0)/rows.length));
  let correct=0,ll=0,brier=0,baselineLoss=0;
  const probabilities=[];
  for(const r of rows){
    const p=predict(model,r.z);probabilities.push(p);
    correct+=(p>=.5)===(r.y===1);
    ll-=r.y*Math.log(p+1e-9)+(1-r.y)*Math.log(1-p+1e-9);
    brier+=(p-r.y)**2;
    baselineLoss-=r.y*Math.log(base)+(1-r.y)*Math.log(1-base);
  }
  const selected=statsAt(model,rows,threshold);
  return {
    samples:rows.length,baseRate:base,accuracy:correct/rows.length,logLoss:ll/rows.length,brier:brier/rows.length,baselineLoss:baselineLoss/rows.length,
    ...selected,prediction:{min:Math.min(...probabilities),p50:quantile(probabilities,.5),p75:quantile(probabilities,.75),p90:quantile(probabilities,.9),p95:quantile(probabilities,.95),max:Math.max(...probabilities)},
    sweep:thresholdSweep(model,rows)
  };
}
function recommendThreshold(model,rows,minSelected=30){
  const eligible=thresholdSweep(model,rows).filter(x=>x.selected>=minSelected&&Number.isFinite(x.averageR)&&x.averageR>0&&(x.profitFactorR===null||x.profitFactorR>1));
  if(!eligible.length)return null;
  eligible.sort((a,b)=>((b.expectancyLower95??-Infinity)-(a.expectancyLower95??-Infinity))||((b.averageR??-Infinity)-(a.averageR??-Infinity))||((b.profitFactorR||0)-(a.profitFactorR||0))||((b.selectedAccuracy||0)-(a.selectedAccuracy||0))||(b.selected-a.selected));
  return eligible[0].threshold;
}
function train(trainRows,calRows,testRows,symbol,costBps,threshold=.7){
  const trainExamples=examples(trainRows,symbol,costBps),calExamples=examples(calRows,symbol,costBps),testExamples=examples(testRows,symbol,costBps);
  if(trainExamples.length<100||calExamples.length<30||testExamples.length<30){
    return {model:null,report:{status:'insufficient-triggered-setups',trainSamples:trainExamples.length,calibrationSamples:calExamples.length,testSamples:testExamples.length}};
  }
  const competition=fitCompetitive(trainExamples,calExamples),model={...competition.model,meaning:'P(success | confirmation entry triggered)'};
  const calibrationRecommendedThreshold=recommendThreshold(model,calExamples,Math.max(20,Math.floor(calExamples.length*.05)));
  const report={status:'trained',modelCompetition:competition.comparison,trainSamples:trainExamples.length,calibrationSamples:calExamples.length,testSamples:testExamples.length,...evaluate(model,testExamples,threshold),calibrationRecommendedThreshold,recommendedTest:calibrationRecommendedThreshold===null?null:statsAt(model,testExamples,calibrationRecommendedThreshold)};
  return {model,report};
}
module.exports={PLAN_PROFILES,vector,fit,calibrate,rawScore,calibrateModel,applyCalibration,fitIsotonicCalibration,fitBestCalibration,resolvePredictModel,predict,predictScoreGate,fitScoreGate,fitBoosted,probabilityMetrics,fitCompetitive,modelFeatureIndices,fitDistributionGate,fitSideDistributionGates,distributionDistance,inDistribution,rangeReversionScore,eligible,outcome,examples,wilsonLower,summarizeExamples,choosePlan,bestSideSelections,evaluate,statsAt,thresholdSweep,recommendThreshold,train};
