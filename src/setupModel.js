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
const predict=(model,z)=>sigmoid((model.calibration?.a??1)*rawScore(model,z)+(model.calibration?.b??0));
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
  const logisticBase={kind:'logistic',weights:fit(trainRows)};
  const logistic={...logisticBase,calibration:calibrateModel(logisticBase,calRows)};
  const boostedBase=fitBoosted(trainRows),boosted={...boostedBase,calibration:calibrateModel(boostedBase,calRows)};
  const logisticMetrics=probabilityMetrics(logistic,calRows),boostedMetrics=probabilityMetrics(boosted,calRows);
  const selected=boostedMetrics.logLoss+0.005<logisticMetrics.logLoss?'boosted-stumps':'logistic';
  return {model:selected==='boosted-stumps'?boosted:logistic,comparison:{selected,logistic:logisticMetrics,boosted:boostedMetrics,minimumBoostedImprovement:.005}};
}

function fitDistributionGate(rows,{dims=20,quantile=.80}={}){
  if(!rows?.length)return null;
  const n=Math.min(dims,rows[0].z.length),mean=Array(n).fill(0),scale=Array(n).fill(0);
  for(const row of rows)for(let j=0;j<n;j++)mean[j]+=Number(row.z[j]||0)/rows.length;
  for(const row of rows)for(let j=0;j<n;j++)scale[j]+=(Number(row.z[j]||0)-mean[j])**2/rows.length;
  for(let j=0;j<n;j++)scale[j]=Math.max(.05,Math.sqrt(scale[j]));
  const distance=z=>Math.sqrt(mean.reduce((sum,m,j)=>sum+((Number(z[j]||0)-m)/scale[j])**2,0)/n);
  const distances=rows.map(row=>distance(row.z)).sort((a,b)=>a-b);
  const q=Math.max(0.5,Math.min(.98,Number(quantile)||.80));
  const threshold=distances[Math.min(distances.length-1,Math.floor((distances.length-1)*q))];
  return {dims:n,mean,scale,threshold,quantile:q};
}
function distributionDistance(gate,z){
  if(!gate)return 0;
  let sum=0;
  for(let j=0;j<gate.dims;j++)sum+=((Number(z[j]||0)-gate.mean[j])/gate.scale[j])**2;
  return Math.sqrt(sum/gate.dims);
}
function inDistribution(gate,z){return !gate||distributionDistance(gate,z)<=gate.threshold;}
function fitSideDistributionGates(rows,options){
  const out={};
  for(const side of ['LONG','SHORT']){
    const part=rows.filter(x=>x.side===side);
    if(part.length>=20)out[side]=fitDistributionGate(part,options);
  }
  return out;
}

function eligible(row,side,costBps){
  const sign=side==='LONG'?1:-1;
  if(row.regime!=='trend'||sign*Number(row.trend||0)<=0)return false;
  if(side==='LONG'&&Number(row.priceAction?.bias||0)<-.34)return false;
  if(side==='SHORT'&&Number(row.priceAction?.bias||0)>.34)return false;
  if(Number(row.atr||0)/Math.max(Number(row.price||0),1e-12)*10000<costBps*2)return false;
  if(row.context?.newsAvailable&&((side==='LONG'&&Number(row.context.newsSentiment||0)<-.25)||(side==='SHORT'&&Number(row.context.newsSentiment||0)>.25)))return false;
  if(row.context?.macroAvailable&&((side==='LONG'&&Number(row.context.macroBias||0)<-.35)||(side==='SHORT'&&Number(row.context.macroBias||0)>.35)))return false;
  const fundamentalBias=.6*Number(row.context?.macroBias||0)+.4*Number(row.context?.newsSentiment||0);
  const confluence=sign*(.58*Number(row.technicalBias||0)+.22*Number(row.priceAction?.bias||0)+.20*fundamentalBias);
  return confluence>=.10;
}

function outcome(row,symbol,side,costBps,planOptions={}){
  const sign=side==='LONG'?1:-1;
  const pseudo={symbol,price:row.price,leanDirection:side,candidateDirection:side,features:row,priceAction:row.priceAction};
  const plan=buildTradePlan(pseudo,{side,...planOptions}),future=row.futureBars||[];
  let trigger=-1;
  for(let i=0;i<Math.min(plan.entryExpiryBars,future.length);i++){
    if(side==='LONG'?future[i].high>=plan.entry:future[i].low<=plan.entry){trigger=i;break;}
  }
  if(trigger<0)return {triggered:false,settled:false,plan};
  const active=future.slice(trigger,trigger+plan.holdBars);
  let exit=null,result=null;
  for(const bar of active){
    const stopHit=side==='LONG'?bar.low<=plan.stop:bar.high>=plan.stop;
    const targetHit=side==='LONG'?bar.high>=plan.target:bar.low<=plan.target;
    if(stopHit&&targetHit){exit=plan.stop;result='SL';break;}
    if(stopHit){exit=plan.stop;result='SL';break;}
    if(targetHit){exit=plan.target;result='TP';break;}
  }
  if(!result&&active.length>=plan.holdBars){
    exit=active.at(-1).close;
    const net=sign*(exit/plan.entry-1)-costBps/10000;
    result=net>0?'TIMEOUT_WIN':'TIMEOUT_LOSS';
  }
  if(!result)return {triggered:true,settled:false,plan};
  const stopFrac=Math.abs(plan.entry-plan.stop)/Math.max(plan.entry,1e-12);
  const realizedR=sign*(exit-plan.entry)/Math.max(Math.abs(plan.entry-plan.stop),1e-12)-(costBps/10000)/Math.max(stopFrac,1e-12);
  const y=(result==='TP'||result==='TIMEOUT_WIN')?1:0;
  return {triggered:true,settled:true,plan,outcome:result,exit,y,realizedR};
}
function examples(rows,symbol,costBps,planOptions={}){
  const out=[];
  for(const row of rows){
    for(const side of ['LONG','SHORT']){
      if(!eligible(row,side,costBps))continue;
      const result=outcome(row,symbol,side,costBps,planOptions);
      if(!result.triggered||!result.settled)continue;
      out.push({z:vector(row,side),y:result.y,realizedR:result.realizedR,side,at:row.at,outcome:result.outcome});
    }
  }
  return out;
}
const PLAN_PROFILES=[
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
function summarizeExamples(rows){
  const n=rows.length,wins=rows.filter(r=>r.y===1).length;
  const averageR=n?rows.reduce((s,r)=>s+r.realizedR,0)/n:null;
  const gainR=rows.reduce((s,r)=>s+Math.max(0,r.realizedR),0),lossR=rows.reduce((s,r)=>s+Math.max(0,-r.realizedR),0);
  return {samples:n,wins,accuracy:n?wins/n:null,wilsonLower:wilsonLower(wins,n),averageR,profitFactorR:lossR?gainR/lossR:null};
}
function choosePlan(candidates,minSamples=40){
  const viable=(candidates||[]).filter(x=>x.stats.samples>=minSamples&&Number.isFinite(x.stats.averageR)&&x.stats.averageR>0&&(x.stats.profitFactorR===null||x.stats.profitFactorR>1));
  if(!viable.length)return null;
  viable.sort((a,b)=>(b.stats.wilsonLower-a.stats.wilsonLower)||((b.stats.averageR||0)-(a.stats.averageR||0))||(b.stats.samples-a.stats.samples));
  return viable[0];
}

function statsAt(model,rows,threshold){
  const chosen=rows.map(r=>({...r,p:predict(model,r.z)})).filter(r=>r.p>=threshold);
  const wins=chosen.filter(r=>r.y===1).length;
  const averageR=chosen.length?chosen.reduce((s,r)=>s+r.realizedR,0)/chosen.length:null;
  const gainR=chosen.reduce((s,r)=>s+Math.max(0,r.realizedR),0),lossR=chosen.reduce((s,r)=>s+Math.max(0,-r.realizedR),0);
  return {threshold,selected:chosen.length,selectedAccuracy:chosen.length?wins/chosen.length:null,selectedWins:wins,averageR,profitFactorR:lossR?gainR/lossR:null};
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
  const eligible=thresholdSweep(model,rows).filter(x=>x.selected>=minSelected&&Number.isFinite(x.averageR));
  if(!eligible.length)return null;
  eligible.sort((a,b)=>(b.averageR-a.averageR)||(b.selectedAccuracy-a.selectedAccuracy)||(b.selected-a.selected));
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
module.exports={PLAN_PROFILES,vector,fit,calibrate,rawScore,calibrateModel,predict,fitBoosted,probabilityMetrics,fitCompetitive,fitDistributionGate,fitSideDistributionGates,distributionDistance,inDistribution,eligible,outcome,examples,wilsonLower,summarizeExamples,choosePlan,evaluate,statsAt,thresholdSweep,recommendThreshold,train};
