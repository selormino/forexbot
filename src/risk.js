function planTrade(signal,{riskPct=0.5,equity=10000,maxDailyLossPct=2,maxPositionUnits=100000}={}){
  const f=signal.features||{};const entry=Number(f.price||signal.price);const atr=Math.max(Number(f.atr||0),entry*0.001);const side=signal.direction;
  if(![equity,riskPct,maxPositionUnits].every(Number.isFinite)||equity<=0||riskPct<=0||riskPct>1||maxPositionUnits<=0)return {allowed:false,reason:'Invalid risk parameters'};
  const minProbability=Math.max(.5,Math.min(.95,Number(signal.minProbability??process.env.SIGNAL_MIN_PROBABILITY??.70)));const setupProbability=Number(signal.setupProbability??signal.probability);
  if(!['LONG','SHORT'].includes(side)||(signal.filters||[]).length||!Number.isFinite(setupProbability)||setupProbability<minProbability)return {allowed:false,reason:'Research trade filters or setup-success probability did not pass'};
  const stopDistance=atr*1.5,targetDistance=atr*2.25;const stop=side==='LONG'?entry-stopDistance:entry+stopDistance;const target=side==='LONG'?entry+targetDistance:entry-targetDistance;
  const riskCash=equity*(riskPct/100);const units=Math.min(maxPositionUnits,Math.max(0,Math.floor(riskCash/stopDistance)));
  return {allowed:units>0,side,entry,stop,target,units,riskCash,riskReward:targetDistance/stopDistance,maxDailyLossPct};
}
module.exports={planTrade};
