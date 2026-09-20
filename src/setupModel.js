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
const predict=(model,z)=>sigmoid(model.calibration.a*dot(model.weights,z)+model.calibration.b);

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

function outcome(row,symbol,side,costBps){
  const sign=side==='LONG'?1:-1;
  const pseudo={symbol,price:row.price,leanDirection:side,candidateDirection:side,features:row,priceAction:row.priceAction};
  const plan=buildTradePlan(pseudo,{side}),future=row.futureBars||[];
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
function examples(rows,symbol,costBps){
  const out=[];
  for(const row of rows){
    for(const side of ['LONG','SHORT']){
      if(!eligible(row,side,costBps))continue;
      const result=outcome(row,symbol,side,costBps);
      if(!result.triggered||!result.settled)continue;
      out.push({z:vector(row,side),y:result.y,realizedR:result.realizedR,side,at:row.at,outcome:result.outcome});
    }
  }
  return out;
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
  const weights=fit(trainExamples),calibration=calibrate(weights,calExamples),model={weights,calibration,meaning:'P(success | confirmation entry triggered)'};
  const calibrationRecommendedThreshold=recommendThreshold(model,calExamples,Math.max(20,Math.floor(calExamples.length*.05)));
  const report={status:'trained',trainSamples:trainExamples.length,calibrationSamples:calExamples.length,testSamples:testExamples.length,...evaluate(model,testExamples,threshold),calibrationRecommendedThreshold,recommendedTest:calibrationRecommendedThreshold===null?null:statsAt(model,testExamples,calibrationRecommendedThreshold)};
  return {model,report};
}
module.exports={vector,fit,calibrate,predict,eligible,outcome,examples,evaluate,statsAt,thresholdSweep,recommendThreshold,train};
