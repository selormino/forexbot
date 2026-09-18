function planTrade(signal,{riskPct=0.5,equity=10000,maxDailyLossPct=2,maxPositionUnits=100000}={}){
  const f=signal.features||{};const entry=Number(f.price||signal.price);const atr=Math.max(Number(f.atr||0),entry*0.001);const side=signal.direction;
  if(![equity,riskPct,maxPositionUnits].every(Number.isFinite)||equity<=0||riskPct<=0||riskPct>1||maxPositionUnits<=0)return {allowed:false,reason:'Invalid risk parameters'};
  const minProbability=Math.max(.5,Math.min(.95,Number(process.env.SIGNAL_MIN_PROBABILITY||.70)));const directionalProbability=Number(signal.directionalProbability??(side==='LONG'?signal.probability:1-signal.probability));
  if(!['LONG','SHORT'].includes(side)||(signal.filters||[]).length||directionalProbability<minProbability)return {allowed:false,reason:'Research trade filters or minimum probability did not pass'};
  const stopDistance=atr*1.5,targetDistance=atr*2.25;const stop=side==='LONG'?entry-stopDistance:entry+stopDistance;const target=side==='LONG'?entry+targetDistance:entry-targetDistance;
  const riskCash=equity*(riskPct/100);const units=Math.min(maxPositionUnits,Math.max(0,Math.floor(riskCash/stopDistance)));
  return {allowed:units>0,side,entry,stop,target,units,riskCash,riskReward:targetDistance/stopDistance,maxDailyLossPct};
}
module.exports={planTrade};
