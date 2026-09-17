function planTrade(signal,{riskPct=0.5,equity=10000,maxDailyLossPct=2,maxPositionUnits=100000}={}){
  const f=signal.features||{};const entry=Number(f.price||signal.price);const atr=Math.max(Number(f.atr||0),entry*0.001);const side=signal.direction;
  if(!['LONG','SHORT'].includes(side)||signal.probability<0.56)return {allowed:false,reason:'Signal below trade threshold'};
  const stopDistance=atr*1.5,targetDistance=atr*2.25;const stop=side==='LONG'?entry-stopDistance:entry+stopDistance;const target=side==='LONG'?entry+targetDistance:entry-targetDistance;
  const riskCash=equity*(riskPct/100);const units=Math.min(maxPositionUnits,Math.max(0,Math.floor(riskCash/stopDistance)));
  return {allowed:units>0,side,entry,stop,target,units,riskCash,riskReward:targetDistance/stopDistance,maxDailyLossPct};
}
module.exports={planTrade};
