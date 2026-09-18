function safeDiv(a,b){return Math.abs(b)>1e-12?a/b:0;}
function last(a,n=1){return a[a.length-n];}
function analyzePriceAction(rows,atr){
  const c=rows.slice(-60);
  if(c.length<25) throw new Error('Need at least 25 candles for price action');
  const x=last(c),p=last(c,2);
  const range=Math.max(x.high-x.low,1e-12),body=Math.abs(x.close-x.open);
  const upper=x.high-Math.max(x.open,x.close),lower=Math.min(x.open,x.close)-x.low;
  const bullish=x.close>x.open,bearish=x.close<x.open;
  const prevBull=p.close>p.open,prevBear=p.close<p.open;
  const bullishEngulfing=bullish&&prevBear&&x.open<=p.close&&x.close>=p.open;
  const bearishEngulfing=bearish&&prevBull&&x.open>=p.close&&x.close<=p.open;
  const bullishPin=lower/range>=0.55&&body/range<=0.35&&x.close>=x.low+range*0.55;
  const bearishPin=upper/range>=0.55&&body/range<=0.35&&x.close<=x.low+range*0.45;
  const insideBar=x.high<p.high&&x.low>p.low;
  const outsideBar=x.high>p.high&&x.low<p.low;
  const prior20=c.slice(-21,-1),prior50=c.slice(0,-1);
  const high20=Math.max(...prior20.map(r=>r.high)),low20=Math.min(...prior20.map(r=>r.low));
  const breakoutUp=x.close>high20,breakoutDown=x.close<low20;
  const swingHighs=[],swingLows=[];
  for(let i=2;i<c.length-2;i++){
    if(c[i].high>c[i-1].high&&c[i].high>c[i-2].high&&c[i].high>=c[i+1].high&&c[i].high>=c[i+2].high)swingHighs.push({i,price:c[i].high});
    if(c[i].low<c[i-1].low&&c[i].low<c[i-2].low&&c[i].low<=c[i+1].low&&c[i].low<=c[i+2].low)swingLows.push({i,price:c[i].low});
  }
  const h1=last(swingHighs),h2=last(swingHighs,2),l1=last(swingLows),l2=last(swingLows,2);
  const higherHigh=!!(h1&&h2&&h1.price>h2.price),lowerHigh=!!(h1&&h2&&h1.price<h2.price);
  const higherLow=!!(l1&&l2&&l1.price>l2.price),lowerLow=!!(l1&&l2&&l1.price<l2.price);
  const structure=higherHigh&&higherLow?'bullish':lowerHigh&&lowerLow?'bearish':'mixed';
  const recentHigh=Math.max(...prior50.slice(-30).map(r=>r.high)),recentLow=Math.min(...prior50.slice(-30).map(r=>r.low));
  const atrSafe=Math.max(Number(atr)||0,range,1e-12);
  const resistanceDistance=(recentHigh-x.close)/atrSafe,supportDistance=(x.close-recentLow)/atrSafe;
  const compression=safeDiv(Math.max(...c.slice(-8).map(r=>r.high))-Math.min(...c.slice(-8).map(r=>r.low)),atrSafe);
  let bias=0;
  if(bullishEngulfing||bullishPin)bias+=1;
  if(bearishEngulfing||bearishPin)bias-=1;
  if(breakoutUp)bias+=1;if(breakoutDown)bias-=1;
  if(structure==='bullish')bias+=1;if(structure==='bearish')bias-=1;
  bias=Math.max(-3,Math.min(3,bias))/3;
  const patterns=[];
  if(bullishEngulfing)patterns.push('bullish engulfing');
  if(bearishEngulfing)patterns.push('bearish engulfing');
  if(bullishPin)patterns.push('bullish pin bar');
  if(bearishPin)patterns.push('bearish pin bar');
  if(insideBar)patterns.push('inside bar');
  if(outsideBar)patterns.push('outside bar');
  if(breakoutUp)patterns.push('20-bar upside breakout');
  if(breakoutDown)patterns.push('20-bar downside breakout');
  return {
    structure,patterns,bias,
    bodyPct:body/range,upperWickPct:upper/range,lowerWickPct:lower/range,
    breakoutUp,breakoutDown,insideBar,outsideBar,
    supportDistance,resistanceDistance,compression,
    vector:[body/range,upper/range,lower/range,bullish?1:bearish?-1:0,bullishEngulfing?1:0,bearishEngulfing?1:0,bullishPin?1:0,bearishPin?1:0,insideBar?1:0,outsideBar?1:0,breakoutUp?1:0,breakoutDown?1:0,higherHigh?1:0,lowerHigh?1:0,higherLow?1:0,lowerLow?1:0,Math.tanh(supportDistance/3),Math.tanh(resistanceDistance/3),Math.tanh(compression-3),bias]
  };
}
module.exports={analyzePriceAction};
