const PIPS={
  EURUSD:{size:.0001,label:'pips',decimals:1},GBPUSD:{size:.0001,label:'pips',decimals:1},
  USDJPY:{size:.01,label:'pips',decimals:1},AUDUSD:{size:.0001,label:'pips',decimals:1},
  USDCAD:{size:.0001,label:'pips',decimals:1},XAUUSD:{size:.01,label:'points',decimals:0},
  XAGUSD:{size:.001,label:'points',decimals:0},WTI:{size:.01,label:'ticks',decimals:0},
  BTCUSD:{size:1,label:'USD',decimals:2},ETHUSD:{size:1,label:'USD',decimals:2},SOLUSD:{size:1,label:'USD',decimals:2},XRPUSD:{size:1,label:'USD',decimals:3},LTCUSD:{size:1,label:'USD',decimals:2}
};
function spec(symbol){return PIPS[symbol]||{size:.0001,label:'pips',decimals:1};}
function distanceUnits(symbol,a,b){const s=spec(symbol);return Math.abs(Number(a)-Number(b))/s.size;}
function buildTradePlan(signal,{side,entryBufferAtr=.12,structureBufferAtr=.03,stopAtr=1.4,targetR=1.6,entryExpiryBars=4,holdBars=6}={}){
  const f=signal.features||{},price=Number(signal.price),atr=Math.max(Number(f.atr||0),price*.0005);
  const direction=side||signal.leanDirection||signal.candidateDirection;
  if(!['LONG','SHORT'].includes(direction))return null;
  const pa=signal.priceAction||{},buffer=atr*Math.max(0,Number(entryBufferAtr)||0),structureBuffer=atr*Math.max(0,Number(structureBufferAtr)||0);
  let entry=direction==='LONG'?price+buffer:price-buffer;
  const resistance=Number(pa.swingResistancePrice??pa.resistancePrice),support=Number(pa.swingSupportPrice??pa.supportPrice);
  if(direction==='LONG'){
    if(Number.isFinite(resistance)&&resistance>price)entry=Math.max(entry,resistance+structureBuffer);
    else if(pa.breakoutUp)entry=Math.max(entry,price+atr*.05);
  }else{
    if(Number.isFinite(support)&&support<price)entry=Math.min(entry,support-structureBuffer);
    else if(pa.breakoutDown)entry=Math.min(entry,price-atr*.05);
  }
  const stopDistance=atr*Math.max(.5,Number(stopAtr)||1.4),targetDistance=stopDistance*Math.max(1,Number(targetR)||1.6);
  const stop=direction==='LONG'?entry-stopDistance:entry+stopDistance;
  const target=direction==='LONG'?entry+targetDistance:entry-targetDistance;
  const tp1=direction==='LONG'?entry+stopDistance:entry-stopDistance;
  const s=spec(signal.symbol);
  return {
    side:direction,entry,entryType:'STOP_CONFIRMATION',stop,tp1,target,
    stopDistance,targetDistance,riskReward:targetDistance/stopDistance,
    stopPips:distanceUnits(signal.symbol,entry,stop),tp1Pips:distanceUnits(signal.symbol,entry,tp1),
    targetPips:distanceUnits(signal.symbol,entry,target),unitLabel:s.label,pipSize:s.size,
    entryExpiryBars:Math.max(1,Math.round(entryExpiryBars)),holdBars:Math.max(1,Math.round(holdBars)),
    rationale:'Structure-confirmed pending entry beyond nearby resistance/support; stop and targets are volatility-adjusted from ATR.'
  };
}
module.exports={spec,distanceUnits,buildTradePlan};
