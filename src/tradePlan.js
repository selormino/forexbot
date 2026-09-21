const PIPS={
  EURUSD:{size:.0001,label:'pips',decimals:1},GBPUSD:{size:.0001,label:'pips',decimals:1},
  USDJPY:{size:.01,label:'pips',decimals:1},AUDUSD:{size:.0001,label:'pips',decimals:1},
  USDCAD:{size:.0001,label:'pips',decimals:1},XAUUSD:{size:.01,label:'points',decimals:0},
  XAGUSD:{size:.001,label:'points',decimals:0},WTI:{size:.01,label:'ticks',decimals:0},
  BTCUSD:{size:1,label:'USD',decimals:2},ETHUSD:{size:1,label:'USD',decimals:2},SOLUSD:{size:1,label:'USD',decimals:2},XRPUSD:{size:1,label:'USD',decimals:3},LTCUSD:{size:1,label:'USD',decimals:2}
};
function spec(symbol){return PIPS[symbol]||{size:.0001,label:'pips',decimals:1};}
function distanceUnits(symbol,a,b){const s=spec(symbol);return Math.abs(Number(a)-Number(b))/s.size;}
function buildTradePlan(signal,{side,strategyFamily='trend',entryBufferAtr=.12,structureBufferAtr=.03,stopAtr=1.4,targetR=1.6,entryExpiryBars=4,holdBars=6}={}){
  const f=signal.features||{},price=Number(signal.price),atr=Math.max(Number(f.atr||0),price*.0005);
  const direction=side||signal.leanDirection||signal.candidateDirection;
  if(!['LONG','SHORT'].includes(direction))return null;
  const family=strategyFamily==='range'?'range':'trend';
  const pa=signal.priceAction||{},buffer=atr*Math.max(0,Number(entryBufferAtr)||0),structureBuffer=atr*Math.max(0,Number(structureBufferAtr)||0);
  let entry=direction==='LONG'?price+buffer:price-buffer;
  const resistance=Number(pa.swingResistancePrice??pa.resistancePrice),support=Number(pa.swingSupportPrice??pa.supportPrice);

  if(family==='trend'){
    if(direction==='LONG'){
      if(Number.isFinite(resistance)&&resistance>price)entry=Math.max(entry,resistance+structureBuffer);
      else if(pa.breakoutUp)entry=Math.max(entry,price+atr*.05);
    }else{
      if(Number.isFinite(support)&&support<price)entry=Math.min(entry,support-structureBuffer);
      else if(pa.breakoutDown)entry=Math.min(entry,price-atr*.05);
    }
  }

  const baseStopDistance=atr*Math.max(.5,Number(stopAtr)||1.4);
  let stop=direction==='LONG'?entry-baseStopDistance:entry+baseStopDistance;
  if(family==='range'){
    // Mean-reversion enters only after a small reversal away from the extreme,
    // then protects beyond nearby range structure when that level is available.
    if(direction==='LONG'&&Number.isFinite(support)&&support<entry)stop=Math.min(stop,support-structureBuffer);
    if(direction==='SHORT'&&Number.isFinite(resistance)&&resistance>entry)stop=Math.max(stop,resistance+structureBuffer);
  }
  const stopDistance=Math.abs(entry-stop);
  const targetDistance=stopDistance*Math.max(.5,Number(targetR)||1.6);
  const target=direction==='LONG'?entry+targetDistance:entry-targetDistance;
  const tp1Distance=Math.min(stopDistance,targetDistance);
  const tp1=direction==='LONG'?entry+tp1Distance:entry-tp1Distance;
  const s=spec(signal.symbol);
  return {
    side:direction,strategyFamily:family,entry,entryType:'STOP_CONFIRMATION',stop,tp1,target,
    stopDistance,targetDistance,riskReward:targetDistance/stopDistance,
    stopPips:distanceUnits(signal.symbol,entry,stop),tp1Pips:distanceUnits(signal.symbol,entry,tp1),
    targetPips:distanceUnits(signal.symbol,entry,target),unitLabel:s.label,pipSize:s.size,
    entryExpiryBars:Math.max(1,Math.round(entryExpiryBars)),holdBars:Math.max(1,Math.round(holdBars)),
    rationale:family==='range'
      ?'Mean-reversion confirmation entry after an extreme; stop is volatility/structure-aware and target is selected from pre-test range profiles.'
      :'Structure-confirmed pending entry beyond nearby resistance/support; stop and targets are volatility-adjusted from ATR.'
  };
}
module.exports={spec,distanceUnits,buildTradePlan};
