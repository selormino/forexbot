function safeDiv(a,b){return Math.abs(b)>1e-12?a/b:0;}
function last(a,n=1){return a[a.length-n];}
function clamp(v,min=-1,max=1){return Math.max(min,Math.min(max,v));}
function mean(a){return a.length?a.reduce((s,v)=>s+v,0)/a.length:0;}

function swingPoints(c){
  const highs=[],lows=[];
  for(let i=2;i<c.length-2;i++){
    if(c[i].high>c[i-1].high&&c[i].high>c[i-2].high&&c[i].high>=c[i+1].high&&c[i].high>=c[i+2].high)highs.push({i,price:c[i].high});
    if(c[i].low<c[i-1].low&&c[i].low<c[i-2].low&&c[i].low<=c[i+1].low&&c[i].low<=c[i+2].low)lows.push({i,price:c[i].low});
  }
  return {highs,lows};
}
function segmentExtreme(c,a,b,key,mode='min'){
  const lo=Math.max(0,Math.min(a,b)),hi=Math.min(c.length-1,Math.max(a,b));
  if(hi<lo)return null;
  const rows=c.slice(lo,hi+1);
  const fn=mode==='max'?Math.max:Math.min;
  const value=fn(...rows.map(x=>x[key]));
  const offset=rows.findIndex(x=>x[key]===value);
  return {i:lo+offset,price:value};
}
function makePattern(type,label,bias,confidence,confirmed,points,description){
  return {type,label,bias,confidence:clamp(confidence,0,1),confirmed:!!confirmed,points:points.filter(Boolean),description};
}
function detectClassicalPatterns(rows,atr){
  const c=rows.slice(-60);
  if(c.length<25)return [];
  const atrSafe=Math.max(Number(atr)||0,mean(c.slice(-14).map(x=>x.high-x.low)),1e-12);
  const x=last(c),{highs,lows}=swingPoints(c),patterns=[];
  const hi=highs.slice(-4),lo=lows.slice(-4);

  if(hi.length>=2){
    const a=hi.at(-2),b=hi.at(-1),sep=b.i-a.i,similar=Math.abs(a.price-b.price)/atrSafe;
    if(sep>=4&&similar<=.65){
      const neck=segmentExtreme(c,a.i,b.i,'low','min');
      const confirmed=!!neck&&x.close<neck.price-.05*atrSafe;
      const confidence=.56+.20*(1-similar/.65)+.12*Math.min(1,sep/14)+(confirmed ? .10 : 0);
      patterns.push(makePattern('double-top','Double Top',-1,confidence,confirmed,[{...a,role:'Top 1'},neck&&{...neck,role:'Neckline'},{...b,role:'Top 2'}],'Two comparable swing highs with an intervening neckline; bearish confirmation comes from a neckline break.'));
    }
  }
  if(lo.length>=2){
    const a=lo.at(-2),b=lo.at(-1),sep=b.i-a.i,similar=Math.abs(a.price-b.price)/atrSafe;
    if(sep>=4&&similar<=.65){
      const neck=segmentExtreme(c,a.i,b.i,'high','max');
      const confirmed=!!neck&&x.close>neck.price+.05*atrSafe;
      const confidence=.56+.20*(1-similar/.65)+.12*Math.min(1,sep/14)+(confirmed ? .10 : 0);
      patterns.push(makePattern('double-bottom','Double Bottom',1,confidence,confirmed,[{...a,role:'Bottom 1'},neck&&{...neck,role:'Neckline'},{...b,role:'Bottom 2'}],'Two comparable swing lows with an intervening neckline; bullish confirmation comes from a neckline break.'));
    }
  }

  if(hi.length>=3){
    const [a,h,b]=hi.slice(-3),shoulderDiff=Math.abs(a.price-b.price)/atrSafe;
    const prominence=(h.price-Math.max(a.price,b.price))/atrSafe;
    if(h.i-a.i>=3&&b.i-h.i>=3&&shoulderDiff<=.75&&prominence>=.25){
      const n1=segmentExtreme(c,a.i,h.i,'low','min'),n2=segmentExtreme(c,h.i,b.i,'low','min');
      const neckline=n1&&n2?(n1.price+n2.price)/2:null,confirmed=neckline!==null&&x.close<neckline-.05*atrSafe;
      const confidence=.60+.16*(1-shoulderDiff/.75)+.14*Math.min(1,prominence)+(confirmed ? .08 : 0);
      patterns.push(makePattern('head-and-shoulders','Head & Shoulders',-1,confidence,confirmed,[{...a,role:'Left shoulder'},{...h,role:'Head'},{...b,role:'Right shoulder'},n2&&{...n2,role:'Neckline'}],'Three-peak reversal structure with a dominant center peak and similar shoulders.'));
    }
  }
  if(lo.length>=3){
    const [a,h,b]=lo.slice(-3),shoulderDiff=Math.abs(a.price-b.price)/atrSafe;
    const prominence=(Math.min(a.price,b.price)-h.price)/atrSafe;
    if(h.i-a.i>=3&&b.i-h.i>=3&&shoulderDiff<=.75&&prominence>=.25){
      const n1=segmentExtreme(c,a.i,h.i,'high','max'),n2=segmentExtreme(c,h.i,b.i,'high','max');
      const neckline=n1&&n2?(n1.price+n2.price)/2:null,confirmed=neckline!==null&&x.close>neckline+.05*atrSafe;
      const confidence=.60+.16*(1-shoulderDiff/.75)+.14*Math.min(1,prominence)+(confirmed ? .08 : 0);
      patterns.push(makePattern('inverse-head-and-shoulders','Inverse Head & Shoulders',1,confidence,confirmed,[{...a,role:'Left shoulder'},{...h,role:'Head'},{...b,role:'Right shoulder'},n2&&{...n2,role:'Neckline'}],'Three-trough reversal structure with a dominant center trough and similar shoulders.'));
    }
  }

  if(hi.length>=3){
    const recent=hi.slice(-3),spread=(Math.max(...recent.map(x=>x.price))-Math.min(...recent.map(x=>x.price)))/atrSafe;
    if(spread<=.55&&recent[2].i-recent[0].i>=8){
      const floor=segmentExtreme(c,recent[0].i,recent[2].i,'low','min'),confirmed=!!floor&&x.close<floor.price-.05*atrSafe;
      patterns.push(makePattern('triple-top','Triple Top',-1,.60+.20*(1-spread/.55)+(confirmed ? .10 : 0),confirmed,[...recent.map((p,i)=>({...p,role:`Top ${i+1}`})),floor&&{...floor,role:'Support'}],'Three comparable swing highs forming a repeated resistance zone.'));
    }
  }
  if(lo.length>=3){
    const recent=lo.slice(-3),spread=(Math.max(...recent.map(x=>x.price))-Math.min(...recent.map(x=>x.price)))/atrSafe;
    if(spread<=.55&&recent[2].i-recent[0].i>=8){
      const ceiling=segmentExtreme(c,recent[0].i,recent[2].i,'high','max'),confirmed=!!ceiling&&x.close>ceiling.price+.05*atrSafe;
      patterns.push(makePattern('triple-bottom','Triple Bottom',1,.60+.20*(1-spread/.55)+(confirmed ? .10 : 0),confirmed,[...recent.map((p,i)=>({...p,role:`Bottom ${i+1}`})),ceiling&&{...ceiling,role:'Resistance'}],'Three comparable swing lows forming a repeated support zone.'));
    }
  }

  const rh=highs.filter(p=>p.i>=c.length-26),rl=lows.filter(p=>p.i>=c.length-26);
  if(rh.length>=2&&rl.length>=2){
    const h0=rh[0],h1=rh.at(-1),l0=rl[0],l1=rl.at(-1);
    const hMove=(h1.price-h0.price)/atrSafe,lMove=(l1.price-l0.price)/atrSafe;
    const hSpread=(Math.max(...rh.map(p=>p.price))-Math.min(...rh.map(p=>p.price)))/atrSafe;
    const lSpread=(Math.max(...rl.map(p=>p.price))-Math.min(...rl.map(p=>p.price)))/atrSafe;
    const span=Math.max(h1.i-h0.i,l1.i-l0.i,1);

    if(hSpread<=.75&&lMove>=.45){
      const confirmed=x.close>Math.max(...rh.map(p=>p.price))+.03*atrSafe;
      patterns.push(makePattern('ascending-triangle','Ascending Triangle',1,.62+.12*Math.min(1,lMove)+(confirmed ? .12 : 0),confirmed,[{...h0,role:'Resistance'},{...h1,role:'Resistance'},{...l0,role:'Rising support'},{...l1,role:'Rising support'}],'Flat resistance with rising swing lows creates bullish compression.'));
    }else if(lSpread<=.75&&hMove<=-.45){
      const confirmed=x.close<Math.min(...rl.map(p=>p.price))-.03*atrSafe;
      patterns.push(makePattern('descending-triangle','Descending Triangle',-1,.62+.12*Math.min(1,-hMove)+(confirmed ? .12 : 0),confirmed,[{...l0,role:'Support'},{...l1,role:'Support'},{...h0,role:'Falling resistance'},{...h1,role:'Falling resistance'}],'Flat support with falling swing highs creates bearish compression.'));
    }else if(hMove<=-.40&&lMove>=.40){
      const upperNow=h1.price,lowerNow=l1.price,mid=(upperNow+lowerNow)/2;
      const bias=x.close>=mid?1:-1,breakout=bias===1?x.close>upperNow+.03*atrSafe:x.close<lowerNow-.03*atrSafe;
      patterns.push(makePattern('symmetrical-triangle','Symmetrical Triangle',bias,.58+.10*Math.min(1,(Math.abs(hMove)+Math.abs(lMove))/2)+(breakout ? .12 : 0),breakout,[{...h0,role:'Upper trendline'},{...h1,role:'Upper trendline'},{...l0,role:'Lower trendline'},{...l1,role:'Lower trendline'}],'Falling highs and rising lows indicate price compression awaiting directional resolution.'));
    }else{
      const parallel=Math.abs(hMove-lMove)<=.45;
      if(hMove>.35&&lMove>.35){
        if(lMove>hMove+.18)patterns.push(makePattern('rising-wedge','Rising Wedge',-1,.58+.08*Math.min(1,(lMove-hMove)*2),false,[{...h0,role:'Upper'},{...h1,role:'Upper'},{...l0,role:'Lower'},{...l1,role:'Lower'}],'Both boundaries rise while support rises faster, creating bearish convergence.'));
        else if(parallel)patterns.push(makePattern('ascending-channel','Ascending Channel',1,.55+.08*Math.min(1,(hMove+lMove)/2),false,[{...h0,role:'Upper channel'},{...h1,role:'Upper channel'},{...l0,role:'Lower channel'},{...l1,role:'Lower channel'}],'Swing highs and lows rise in roughly parallel fashion.'));
      }else if(hMove<-.35&&lMove<-.35){
        if(hMove<lMove-.18)patterns.push(makePattern('falling-wedge','Falling Wedge',1,.58+.08*Math.min(1,(lMove-hMove)*2),false,[{...h0,role:'Upper'},{...h1,role:'Upper'},{...l0,role:'Lower'},{...l1,role:'Lower'}],'Both boundaries fall while resistance falls faster, creating bullish convergence.'));
        else if(parallel)patterns.push(makePattern('descending-channel','Descending Channel',-1,.55+.08*Math.min(1,(-hMove-lMove)/2),false,[{...h0,role:'Upper channel'},{...h1,role:'Upper channel'},{...l0,role:'Lower channel'},{...l1,role:'Lower channel'}],'Swing highs and lows fall in roughly parallel fashion.'));
      }
    }
    void span;
  }

  if(c.length>=20){
    const impulseStart=c.length-20,flagStart=c.length-8;
    const impulse=(c[flagStart].close-c[impulseStart].close)/atrSafe;
    const pullback=(x.close-c[flagStart].close)/atrSafe;
    if(impulse>=2&&pullback<0&&Math.abs(pullback)<=Math.abs(impulse)*.60){
      patterns.push(makePattern('bull-flag','Bull Flag',1,.60+.10*Math.min(1,impulse/4),x.close>Math.max(...c.slice(flagStart,-1).map(r=>r.high)),[{i:impulseStart,price:c[impulseStart].close,role:'Impulse start'},{i:flagStart,price:c[flagStart].close,role:'Flag start'},{i:c.length-1,price:x.close,role:'Current'}],'Strong bullish impulse followed by a controlled counter-trend pullback.'));
    }else if(impulse<=-2&&pullback>0&&Math.abs(pullback)<=Math.abs(impulse)*.60){
      patterns.push(makePattern('bear-flag','Bear Flag',-1,.60+.10*Math.min(1,-impulse/4),x.close<Math.min(...c.slice(flagStart,-1).map(r=>r.low)),[{i:impulseStart,price:c[impulseStart].close,role:'Impulse start'},{i:flagStart,price:c[flagStart].close,role:'Flag start'},{i:c.length-1,price:x.close,role:'Current'}],'Strong bearish impulse followed by a controlled counter-trend bounce.'));
    }
  }

  return patterns.sort((a,b)=>(b.confirmed-a.confirmed)||(b.confidence-a.confidence)).slice(0,6);
}

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
  const {highs:swingHighs,lows:swingLows}=swingPoints(c);
  const h1=last(swingHighs),h2=last(swingHighs,2),l1=last(swingLows),l2=last(swingLows,2);
  const higherHigh=!!(h1&&h2&&h1.price>h2.price),lowerHigh=!!(h1&&h2&&h1.price<h2.price);
  const higherLow=!!(l1&&l2&&l1.price>l2.price),lowerLow=!!(l1&&l2&&l1.price<l2.price);
  const structure=higherHigh&&higherLow?'bullish':lowerHigh&&lowerLow?'bearish':'mixed';
  const recentHigh=Math.max(...prior50.slice(-30).map(r=>r.high)),recentLow=Math.min(...prior50.slice(-30).map(r=>r.low));
  const atrSafe=Math.max(Number(atr)||0,range,1e-12);
  const resistanceDistance=(recentHigh-x.close)/atrSafe,supportDistance=(x.close-recentLow)/atrSafe;
  const compression=safeDiv(Math.max(...c.slice(-8).map(r=>r.high))-Math.min(...c.slice(-8).map(r=>r.low)),atrSafe);
  let baseBias=0;
  if(bullishEngulfing||bullishPin)baseBias+=1;
  if(bearishEngulfing||bearishPin)baseBias-=1;
  if(breakoutUp)baseBias+=1;if(breakoutDown)baseBias-=1;
  if(structure==='bullish')baseBias+=1;if(structure==='bearish')baseBias-=1;
  baseBias=clamp(baseBias/3);

  const classicalPatterns=detectClassicalPatterns(c,atrSafe);
  const weighted=classicalPatterns.reduce((s,p)=>s+p.bias*p.confidence*(p.confirmed?1.15:1),0);
  const weight=classicalPatterns.reduce((s,p)=>s+p.confidence*(p.confirmed?1.15:1),0);
  const patternBias=weight?clamp(weighted/weight):0;
  const patternConfidence=classicalPatterns.length?Math.max(...classicalPatterns.map(p=>p.confidence)):0;
  const bias=clamp(.65*baseBias+.35*patternBias);

  const patterns=[];
  if(bullishEngulfing)patterns.push('bullish engulfing');
  if(bearishEngulfing)patterns.push('bearish engulfing');
  if(bullishPin)patterns.push('bullish pin bar');
  if(bearishPin)patterns.push('bearish pin bar');
  if(insideBar)patterns.push('inside bar');
  if(outsideBar)patterns.push('outside bar');
  if(breakoutUp)patterns.push('20-bar upside breakout');
  if(breakoutDown)patterns.push('20-bar downside breakout');
  for(const ptn of classicalPatterns)patterns.push(ptn.label.toLowerCase());

  return {
    structure,patterns,bias,baseBias,patternBias,patternConfidence,classicalPatterns,
    bodyPct:body/range,upperWickPct:upper/range,lowerWickPct:lower/range,
    breakoutUp,breakoutDown,insideBar,outsideBar,
    supportPrice:recentLow,resistancePrice:recentHigh,swingSupportPrice:l1?.price??recentLow,swingResistancePrice:h1?.price??recentHigh,supportDistance,resistanceDistance,compression,
    swingHighs:swingHighs.slice(-6),swingLows:swingLows.slice(-6),
    vector:[body/range,upper/range,lower/range,bullish?1:bearish?-1:0,bullishEngulfing?1:0,bearishEngulfing?1:0,bullishPin?1:0,bearishPin?1:0,insideBar?1:0,outsideBar?1:0,breakoutUp?1:0,breakoutDown?1:0,higherHigh?1:0,lowerHigh?1:0,higherLow?1:0,lowerLow?1:0,Math.tanh(supportDistance/3),Math.tanh(resistanceDistance/3),Math.tanh(compression-3),bias]
  };
}
module.exports={analyzePriceAction,detectClassicalPatterns};
