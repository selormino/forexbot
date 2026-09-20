// Versioned research engine. Legacy models never participate in v2 predictions.
const db=require('./db');
const ti=require('technicalindicators');
const {analyzePriceAction}=require('./priceAction');
const {buildTradePlan}=require('./tradePlan');
const {signalMinProbability}=require('./settings');
const {pointInTimeContext}=require('./macro');
const {createHash}=require('crypto');
const setupModel=require('./setupModel');
const VERSION='technical-fundamental-v9-eligible-setup';
const MIN_PROB=()=>signalMinProbability();
db.exec(`CREATE TABLE IF NOT EXISTS context_snapshots(kind TEXT,symbol TEXT,known_at INTEGER,payload TEXT,PRIMARY KEY(kind,symbol,known_at));
CREATE TABLE IF NOT EXISTS news_history(id TEXT PRIMARY KEY,symbol TEXT,published_at INTEGER,known_at INTEGER,headline TEXT,score REAL,provider TEXT);
CREATE TABLE IF NOT EXISTS research_models(id INTEGER PRIMARY KEY,created_at INTEGER,symbol TEXT,timeframe TEXT,version TEXT,model TEXT,report TEXT,approved INTEGER);
CREATE INDEX IF NOT EXISTS context_lookup ON context_snapshots(kind,symbol,known_at);
CREATE INDEX IF NOT EXISTS news_lookup ON news_history(symbol,known_at);`);
const ms=tf=>({'1h':3600000,'4h':14400000}[tf]||0);
const sigmoid=z=>1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));
const dot=(w,x)=>w[0]+x.reduce((s,v,i)=>s+w[i+1]*v,0);
function snapshot(kind,symbol,payload,now=Date.now()){db.prepare('INSERT OR REPLACE INTO context_snapshots VALUES(?,?,?,?)').run(kind,symbol,now,JSON.stringify(payload));}
function captureMacro(now=Date.now()){
  const values={};
  for(const id of ['FEDFUNDS','CPIAUCSL','UNRATE','GDPC1','DGS10']){
    const rows=db.prepare('SELECT value FROM macro_observations WHERE series_id=? ORDER BY observation_date DESC LIMIT 14').all(id);
    if(rows.length)values[id]={level:rows[0].value,change:rows.length>1?rows[0].value/rows[1].value-1:0};
  }
  if(Object.keys(values).length)snapshot('macro','USD',values,now);
}
function recordNews(symbol,articles,now=Date.now()){
  const ins=db.prepare('INSERT OR IGNORE INTO news_history VALUES(?,?,?,?,?,?,?)');
  for(const n of articles){if(!n.headline||!Number.isFinite(n.time)||n.time>now)continue;
    const id=createHash('sha256').update(symbol+'|'+(n.url||n.headline)).digest('hex');
    ins.run(id,symbol,n.time,now,n.headline,Math.max(-1,Math.min(1,Number(n.sentiment)||0)),n.provider||'unknown');}
}
function context(symbol,at){
  const vintageMacro=pointInTimeContext(at);
  const row=db.prepare("SELECT * FROM context_snapshots WHERE kind='macro' AND symbol='USD' AND known_at<=? ORDER BY known_at DESC LIMIT 1").get(at);
  const snapshotMacro=row&&at-row.known_at<7*864e5?JSON.parse(row.payload):{};
  const macro=Object.keys(vintageMacro).length>=5?vintageMacro:snapshotMacro;
  const macroSource=Object.keys(vintageMacro).length>=5?'ALFRED_POINT_IN_TIME':Object.keys(snapshotMacro).length?'LIVE_SNAPSHOT':'NONE';
  const news=db.prepare('SELECT score,headline,provider,published_at FROM news_history WHERE symbol=? AND known_at<=? AND known_at>=? AND published_at>=? ORDER BY known_at DESC LIMIT 20').all(symbol,at,at-864e5,at-864e5);
  const orientation=symbol.startsWith('USD')?1:-1;
  const newsSentiment=news.length?news.reduce((s,n)=>s+n.score,0)/news.length:0;
  const rateBias=((macro.DGS10?.change||0)*2+(macro.FEDFUNDS?.change||0))*orientation;
  const growthBias=((macro.GDPC1?.change||0)-(macro.UNRATE?.change||0))*orientation;
  const inflationBias=(macro.CPIAUCSL?.change||0)*orientation;
  const macroBias=Math.tanh((rateBias+growthBias+inflationBias)*50);
  return {macroAvailable:Object.keys(macro).length===5,macroSource,newsAvailable:news.length>0,newsSentiment,newsCount:news.length,newsHeadlines:news.slice(0,5).map(n=>({headline:n.headline,provider:n.provider,time:n.published_at,score:n.score})),macroBias,macro,
    x:[
    ...['FEDFUNDS','CPIAUCSL','UNRATE','GDPC1','DGS10'].map(id=>Math.tanh((macro[id]?.change||0)*100)*orientation),
    macro.FEDFUNDS?Math.tanh(macro.FEDFUNDS.level/10)*orientation:0,
    newsSentiment,Math.min(news.length/20,1),Object.keys(macro).length/5]};
}
function features(rows,symbol,at){
  const c=rows.slice(-120),close=c.map(r=>r.close),high=c.map(r=>r.high),low=c.map(r=>r.low);
  if(c.length<60)throw new Error('Need 60 closed candles');
  const price=close.at(-1),emaSeries=p=>ti.EMA.calculate({period:p,values:close}),ema20s=emaSeries(20),ema50s=emaSeries(50);
  const atr=ti.ATR.calculate({period:14,high,low,close}).at(-1);
  const rsi=ti.RSI.calculate({period:14,values:close}).at(-1);
  const macd=ti.MACD.calculate({values:close,fastPeriod:12,slowPeriod:26,signalPeriod:9,SimpleMAOscillator:false,SimpleMASignal:false}).at(-1)||{MACD:0,signal:0,histogram:0};
  const bb=ti.BollingerBands.calculate({period:20,stdDev:2,values:close}).at(-1)||{upper:price,middle:price,lower:price};
  const adx=ti.ADX.calculate({period:14,close,high,low}).at(-1)||{adx:0,pdi:0,mdi:0};
  const ema20=ema20s.at(-1),ema50=ema50s.at(-1),trend=(ema20-ema50)/Math.max(atr,1e-9);
  const emaSlope=(ema20-(ema20s.at(-6)??ema20))/Math.max(atr,1e-9);
  const momentum5=(price-close.at(-6))/Math.max(atr,1e-9);
  const adxDirection=(Number(adx.pdi||0)-Number(adx.mdi||0))/Math.max(Number(adx.pdi||0)+Number(adx.mdi||0),1e-9);
  const changes=close.slice(1).map((v,i)=>Math.log(v/close[i]));
  const vol=a=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
  const ratio=vol(changes.slice(-14))/Math.max(vol(changes),1e-9);
  const regime=ratio>1.8?'volatile':Math.abs(trend)>.8?'trend':'range';
  const ctx=context(symbol,at);
  const priceAction=analyzePriceAction(c,atr);
  const macdNorm=(Number(macd.MACD||0)-Number(macd.signal||0))/Math.max(atr,1e-9);
  const bbWidth=(bb.upper-bb.lower)/Math.max(price,1e-9),bbPosition=(price-bb.lower)/Math.max(bb.upper-bb.lower,1e-9);
  const rsiBias=Math.max(-1,Math.min(1,(rsi-50)/25));
  const technicalBias=Math.max(-1,Math.min(1,.34*Math.tanh(trend)+.18*Math.tanh(emaSlope)+.18*Math.tanh(macdNorm)+.12*adxDirection+.10*Math.tanh(momentum5)+.08*rsiBias));
  return {price,atr,rsi,trend,ema20,ema50,emaSlope,momentum5,adx:{value:Number(adx.adx||0),pdi:Number(adx.pdi||0),mdi:Number(adx.mdi||0),direction:adxDirection},technicalBias,regime,macd:{value:macd.MACD||0,signal:macd.signal||0,histogram:macd.histogram||0},bollinger:{...bb,width:bbWidth,position:bbPosition},priceAction,context:ctx,x:[Math.tanh(trend),Math.tanh(emaSlope),Math.tanh(momentum5),rsiBias,Math.tanh(atr/price*100),Math.tanh(ratio-1),regime==='trend'?1:0,regime==='volatile'?1:0,Math.tanh(macdNorm),adxDirection,Math.tanh(Number(adx.adx||0)/25-1),Math.tanh((bbPosition-.5)*2),Math.tanh(bbWidth*100),technicalBias,...priceAction.vector,...ctx.x]};
}
function costs(symbol){
  // Round-trip estimates in basis points, not measured broker quotes.
  const defaults={EURUSD:2,GBPUSD:3,USDJPY:3,AUDUSD:3,USDCAD:3,XAUUSD:5,XAGUSD:12,WTI:10,BTCUSD:12,ETHUSD:14,SOLUSD:18,XRPUSD:20,LTCUSD:18};
  const spread=Number(process.env['SPREAD_BPS_'+symbol]??defaults[symbol]??5);
  const slippage=Number(process.env.SLIPPAGE_BPS??1),commission=Number(process.env.COMMISSION_BPS??.5);
  if(![spread,slippage,commission].every(v=>Number.isFinite(v)&&v>=0))throw new Error('Invalid transaction costs');
  return {spread,slippage,commission,total:spread+2*slippage+2*commission};
}
function dataset(symbol,tf){
  if(!ms(tf))throw new Error('Timeframe must be 1h or 4h');
  const rows=db.prepare('SELECT * FROM candles WHERE symbol=? AND timeframe=? AND ts+?<=? ORDER BY ts').all(symbol,tf,ms(tf),Date.now());
  const out=[],horizon=4,lookahead=10;
  for(let i=59;i+lookahead<rows.length;i++){
    const at=rows[i].ts+ms(tf),f=features(rows.slice(Math.max(0,i-119),i+1),symbol,at);
    // Enter next open, exit horizon close. Reject gaps/provider mixing inside outcome window.
    const segment=rows.slice(i,i+lookahead+1);
    if(segment.some((r,j)=>r.provider!==rows[i].provider||(j&&r.ts-segment[j-1].ts!==ms(tf))))continue;
    const ret=rows[i+horizon].close/rows[i+1].open-1;
    out.push({...f,at,end:rows[i+horizon].ts+ms(tf),setupEnd:rows[i+lookahead].ts+ms(tf),ret,y:ret>0?1:0,futureBars:rows.slice(i+1,i+lookahead+1).map(r=>({ts:r.ts,open:r.open,high:r.high,low:r.low,close:r.close}))});
  }
  return out;
}
function fit(rows){
  if(rows.length<100)throw new Error('Insufficient training samples');
  const w=Array(rows[0].x.length+1).fill(0);
  for(let epoch=0;epoch<120;epoch++){
    const g=Array(w.length).fill(0);
    for(const r of rows){const err=sigmoid(dot(w,r.x))-r.y;g[0]+=err;r.x.forEach((v,i)=>g[i+1]+=err*v);}
    w.forEach((v,i)=>w[i]-=.15*(g[i]/rows.length+(i?.001*v:0)));
  }return w;
}
function calibrate(w,rows){
  let a=1,b=0;
  for(let k=0;k<250;k++){let da=0,dbias=0;for(const r of rows){const z=dot(w,r.x),e=sigmoid(a*z+b)-r.y;da+=e*z;dbias+=e;}a-=.05*(da/rows.length+.01*(a-1));b-=.05*dbias/rows.length;}
  return {a,b};
}
const predict=(m,x)=>sigmoid(m.calibration.a*dot(m.weights,x)+m.calibration.b);
function evaluate(m,rows,costBps){
  let correct=0,ll=0,brier=0,net=0,gains=0,losses=0,equity=1,peak=1,drawdown=0,trades=0,lastExit=0;
  const bins=Array.from({length:10},()=>({samples:0,predicted:0,observed:0}));
  for(const r of rows){const p=predict(m,r.x);correct+=(p>=.5)===(r.y===1);ll-=r.y*Math.log(p+1e-9)+(1-r.y)*Math.log(1-p+1e-9);brier+=(p-r.y)**2;
    const b=bins[Math.min(9,Math.floor(p*10))];b.samples++;b.predicted+=p;b.observed+=r.y;
    const threshold=MIN_PROB(); const side=p>=threshold?1:p<=1-threshold?-1:0;
    if(!side||r.regime!=='trend'||side*r.trend<=0||r.at<lastExit||r.atr/r.price*10000<costBps*2)continue;
    const pnl=side*r.ret-costBps/10000;trades++;net+=pnl;gains+=Math.max(0,pnl);losses+=Math.max(0,-pnl);equity*=1+pnl;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,1-equity/peak);lastExit=r.end;
  }
  return {samples:rows.length,accuracy:correct/rows.length,logLoss:ll/rows.length,brier:brier/rows.length,trades,netReturn:equity-1,expectancy:trades?net/trades:0,profitFactor:losses?gains/losses:null,maxDrawdown:drawdown,costBps,bins:bins.map(b=>({...b,predicted:b.samples?b.predicted/b.samples:null,observed:b.samples?b.observed/b.samples:null})),assumption:'Unlevered fixed-horizon, non-overlapping trades; excludes financing and intrabar stops'};
}
function evaluateTradePlans(m,rows,symbol,costBps,threshold=MIN_PROB()){
  threshold=Math.max(.5,Math.min(.95,Number(threshold)||MIN_PROB()));let candidates=0,triggered=0,expired=0,wins=0,losses=0,tp=0,sl=0,timeout=0,sumR=0,gainR=0,lossR=0;
  for(const r of rows){
    const p=predict(m,r.x),directionalProbability=Math.max(p,1-p);if(directionalProbability<threshold)continue;
    const side=p>=.5?'LONG':'SHORT',sgn=side==='LONG'?1:-1;
    if(r.regime!=='trend'||sgn*r.trend<=0)continue;
    if(side==='LONG'&&r.priceAction.bias<-.34)continue;if(side==='SHORT'&&r.priceAction.bias>.34)continue;
    if(r.atr/r.price*10000<costBps*2)continue;
    if(r.context?.newsAvailable&&((side==='LONG'&&r.context.newsSentiment<-.25)||(side==='SHORT'&&r.context.newsSentiment>.25)))continue;
    if(r.context?.macroAvailable&&((side==='LONG'&&r.context.macroBias<-.35)||(side==='SHORT'&&r.context.macroBias>.35)))continue;
    const fundamentalBias=.6*Number(r.context?.macroBias||0)+.4*Number(r.context?.newsSentiment||0);
    const confluence=sgn*(.58*Number(r.technicalBias||0)+.22*Number(r.priceAction?.bias||0)+.20*fundamentalBias);
    if(confluence<.10)continue;
    candidates++;
    const pseudo={symbol,price:r.price,leanDirection:side,candidateDirection:side,directionalProbability,features:r,priceAction:r.priceAction};
    const plan=buildTradePlan(pseudo,{side}),future=r.futureBars||[];let trigger=-1;
    for(let i=0;i<Math.min(plan.entryExpiryBars,future.length);i++){if(side==='LONG'?future[i].high>=plan.entry:future[i].low<=plan.entry){trigger=i;break;}}
    if(trigger<0){expired++;continue;}triggered++;
    const active=future.slice(trigger,trigger+plan.holdBars);let exit=null,outcome=null;
    for(const b of active){
      const stopHit=side==='LONG'?b.low<=plan.stop:b.high>=plan.stop,targetHit=side==='LONG'?b.high>=plan.target:b.low<=plan.target;
      if(stopHit&&targetHit){exit=plan.stop;outcome='SL';break;}
      if(stopHit){exit=plan.stop;outcome='SL';break;}
      if(targetHit){exit=plan.target;outcome='TP';break;}
    }
    if(!outcome&&active.length>=plan.holdBars){exit=active.at(-1).close;const net=sgn*(exit/plan.entry-1)-costBps/10000;outcome=net>0?'TIMEOUT_WIN':'TIMEOUT_LOSS';}
    if(!outcome)continue;
    const rr=sgn*(exit-plan.entry)/Math.max(Math.abs(plan.entry-plan.stop),1e-12)-costBps/10000/(Math.abs(plan.entry-plan.stop)/plan.entry);
    sumR+=rr;if(rr>0)gainR+=rr;else lossR+=-rr;
    const success=outcome==='TP'||outcome==='TIMEOUT_WIN';wins+=success?1:0;losses+=success?0:1;
    tp+=outcome==='TP'?1:0;sl+=outcome==='SL'?1:0;timeout+=outcome.startsWith('TIMEOUT')?1:0;
  }
  return {candidates,triggered,expired,wins,losses,tp,sl,timeout,accuracy:triggered?wins/triggered:null,averageR:triggered?sumR/triggered:null,profitFactorR:lossR?gainR/lossR:null,
    assumption:'Entry must trigger within four bars; then ATR stop/target is monitored for six bars. If SL and TP both occur in one candle, SL is assumed first (conservative). Estimated costs are deducted from R.'};
}
function thresholdDiagnostics(m,rows,symbol,costBps){
  return [...new Set([.55,.60,.65,.70,.75,.80,MIN_PROB()].map(x=>Number(x.toFixed(2))))].sort((a,b)=>a-b).map(threshold=>{
    const directional=rows.filter(r=>Math.max(predict(m,r.x),1-predict(m,r.x))>=threshold);
    const correct=directional.filter(r=>(predict(m,r.x)>=.5)===(r.y===1)).length;
    const setup=evaluateTradePlans(m,rows,symbol,costBps,threshold);
    return {threshold,directionalSamples:directional.length,directionalAccuracy:directional.length?correct/directional.length:null,setup};
  });
}
function split(rows){
  const calStart=Math.floor(rows.length*.6),testStart=Math.floor(rows.length*.8);
  return {train:rows.slice(0,calStart).filter(r=>(r.setupEnd||r.end)<rows[calStart].at),cal:rows.slice(calStart,testStart).filter(r=>(r.setupEnd||r.end)<rows[testStart].at),test:rows.slice(testStart)};
}
function trainSeries(symbol,tf){
  const rows=dataset(symbol,tf);if(rows.length<500)return {symbol,timeframe:tf,status:'insufficient-data',samples:rows.length};
  const {train,cal,test}=split(rows),weights=fit(train),calibration=calibrate(weights,cal);
  const cost=costs(symbol),threshold=MIN_PROB();
  const setupTraining=setupModel.train(train,cal,test,symbol,cost.total,threshold);
  const m={version:VERSION,weights,calibration,horizon:4,setup:setupTraining.model};
  const metrics=evaluate(m,test,cost.total),setupBacktest=evaluateTradePlans(m,test,symbol,cost.total),thresholdSweep=thresholdDiagnostics(m,test,symbol,cost.total);
  const base=train.reduce((s,r)=>s+r.y,0)/train.length;
  const baselineLoss=-test.reduce((s,r)=>s+r.y*Math.log(base+1e-9)+(1-r.y)*Math.log(1-base+1e-9),0)/test.length;
  const contextSamples=train.filter(r=>r.context.macroAvailable&&r.context.newsAvailable).length;
  const macroContextSamples=train.filter(r=>r.context.macroAvailable).length;
  const newsContextSamples=train.filter(r=>r.context.newsAvailable).length;
  const fundamentalCoverage=train.length?macroContextSamples/train.length:0;
  const newsCoverage=train.length?newsContextSamples/train.length:0;
  const directionalFloor=Math.max(.5,Math.min(.9,Number(process.env.DIRECTIONAL_MIN_PROBABILITY||.55)));
  const qualified=test.filter(r=>Math.max(predict(m,r.x),1-predict(m,r.x))>=directionalFloor);
  const qualifiedCorrect=qualified.filter(r=>(predict(m,r.x)>=.5)===(r.y===1)).length;
  const qualifiedAccuracy=qualified.length?qualifiedCorrect/qualified.length:null;
  const folds=[];
  for(const fraction of [.6,.8,1]){
    const window=rows.slice(0,Math.floor(rows.length*fraction));
    const parts=split(window),w=fit(parts.train),calibrationFold=calibrate(w,parts.cal);
    const foldModel={weights:w,calibration:calibrationFold};
    const setupFold=setupModel.train(parts.train,parts.cal,parts.test,symbol,cost.total,threshold).report;
    folds.push({...evaluate(foldModel,parts.test,cost.total),setup:evaluateTradePlans(foldModel,parts.test,symbol,cost.total),setupProbability:setupFold});
  }
  const setupReport=setupTraining.report,target=Number(process.env.SIGNAL_TARGET_ACCURACY||.70);
  const setupApproved=setupReport.status==='trained'&&setupReport.selected>=30&&setupReport.selectedAccuracy>=target&&(setupReport.averageR||0)>0&&setupReport.logLoss<setupReport.baselineLoss;
  const foldStable=folds.every(f=>f.logLoss<0.78&&(f.setupProbability.status!=='trained'||f.setupProbability.selected<10||((f.setupProbability.averageR||0)>0&&f.setupProbability.logLoss<f.setupProbability.baselineLoss)));
  const approved=setupApproved&&metrics.logLoss<baselineLoss&&foldStable;
  const report={symbol,timeframe:tf,samples:rows.length,trainSamples:train.length,calibrationSamples:cal.length,contextSamples,macroContextSamples,newsContextSamples,fundamentalCoverage,newsCoverage,baselineLoss,metrics,setupBacktest,setupProbability:setupReport,thresholdSweep,folds,qualifiedSignals:qualified.length,qualifiedAccuracy,directionalMinProbability:directionalFloor,minProbability:threshold,approved,approvalRule:'Setup-success model must have at least 30 out-of-sample selections at the configured threshold, meet the accuracy target, produce positive average R, beat baseline log loss, and remain stable across chronological folds',split:'60/20/20 chronological, purged through full setup outcome window; expanding-window folds',createdAt:Date.now()};
  db.prepare('INSERT INTO research_models(created_at,symbol,timeframe,version,model,report,approved) VALUES(?,?,?,?,?,?,?)').run(Date.now(),symbol,tf,VERSION,JSON.stringify(m),JSON.stringify(report),+approved);
  return report;
}
function latest(symbol,tf){const r=db.prepare('SELECT * FROM research_models WHERE symbol=? AND timeframe=? AND version=? ORDER BY id DESC LIMIT 1').get(symbol,tf,VERSION);return r?{...r,model:JSON.parse(r.model),report:JSON.parse(r.report)}:null;}
function numericValue(v){
  if(v===null||v===undefined)return null;
  const n=Number(String(v).replace(/[%,$]/g,'').trim());return Number.isFinite(n)?n:null;
}
function symbolCurrencies(symbol){
  const map={EURUSD:['EUR','USD'],GBPUSD:['GBP','USD'],USDJPY:['USD','JPY'],AUDUSD:['AUD','USD'],USDCAD:['USD','CAD'],XAUUSD:['XAU','USD'],XAGUSD:['XAG','USD'],WTI:['WTI','USD'],BTCUSD:['BTC','USD'],ETHUSD:['ETH','USD'],SOLUSD:['SOL','USD'],XRPUSD:['XRP','USD'],LTCUSD:['LTC','USD']};
  return map[symbol]||[symbol.slice(0,3),symbol.slice(3,6)];
}
function eventFundamentalBias(events,symbol,now){
  if(!Array.isArray(events))return {bias:0,surprises:[]};
  const [base,quote]=symbolCurrencies(symbol),rows=[];
  for(const e of events){
    const t=new Date(e.time).getTime();if(!Number.isFinite(t)||t<now-12*3600000||t>now)continue;
    const actual=numericValue(e.actual),forecast=numericValue(e.forecast??e.estimate);if(actual===null||forecast===null)continue;
    const cur=String(e.currency||e.country||'').toUpperCase();let orientation=cur===base?1:cur===quote?-1:0;if(!orientation)continue;
    const title=String(e.event||'').toLowerCase();
    const polarity=/unemployment|jobless|claims/.test(title)?-1:1;
    const impactName=String(e.impact||'medium').toLowerCase();const impact=impactName==='high'?1:impactName==='medium'?0.65:0.35;
    const scale=Math.max(Math.abs(forecast),Math.abs(actual),1),surprise=Math.tanh(((actual-forecast)/scale)*4)*polarity*orientation*impact;
    rows.push({event:e.event,currency:cur,actual,forecast,impact:e.impact,score:surprise,time:e.time});
  }
  const bias=rows.length?rows.reduce((s,r)=>s+r.score,0)/Math.sqrt(rows.length):0;
  return {bias:Math.max(-1,Math.min(1,bias)),surprises:rows.slice(-5)};
}
function confluenceFor(side,f,higherTimeframe,fundamentalBias){
  const sign=side==='LONG'?1:-1;
  const higher=higherTimeframe?Math.tanh(Number(higherTimeframe.trend||0)):0;
  const raw=.40*Number(f.technicalBias||0)+.20*Number(f.priceAction?.bias||0)+.15*higher+.25*Number(fundamentalBias||0);
  const aligned=Math.max(-1,Math.min(1,sign*raw));
  return {score:aligned,agreement:Math.round((aligned+1)*50),raw};
}
function signal(symbol,tf='1h',events=null){
  const now=Date.now(),step=ms(tf);if(!step)throw new Error('Invalid timeframe');
  const rows=db.prepare('SELECT * FROM candles WHERE symbol=? AND timeframe=? AND ts+?<=? ORDER BY ts DESC LIMIT 120').all(symbol,tf,step,now).reverse();
  const f=features(rows,symbol,now),m=latest(symbol,tf),p=m?predict(m.model,f.x):.5,cost=costs(symbol),reasons=[];
  const threshold=MIN_PROB(),directionalFloor=Math.max(.5,Math.min(.9,Number(process.env.DIRECTIONAL_MIN_PROBABILITY||.55))),lean=p>=.5?'LONG':'SHORT',directionalProbability=Math.max(p,1-p);
  const setupProbability=m?.model?.setup?setupModel.predict(m.model.setup,setupModel.vector(f,lean)):null;
  const candidate=directionalProbability>=directionalFloor&&setupProbability!==null&&setupProbability>=threshold?lean:'WAIT';
  if(!m?.approved)reasons.push('Model has not passed out-of-sample validation gates');
  if(now-(rows.at(-1).ts+step)>step*2)reasons.push('Stale closed candles');
  if(rows.some((r,i)=>r.provider==='demo'||(i&&r.ts-rows[i-1].ts!==step)))reasons.push('Candle gaps or synthetic data');
  if(rows.some(r=>r.provider==='yahoo'))reasons.push('Research-only fallback feed');
  if(!f.context.macroAvailable||!f.context.newsAvailable)reasons.push('Missing fresh macro/news confirmation');
  if(directionalProbability<directionalFloor)reasons.push(`Directional probability below ${Math.round(directionalFloor*100)}% direction floor`);
  if(setupProbability===null)reasons.push('Triggered setup-success model is unavailable');
  else if(setupProbability<threshold)reasons.push(`Setup success probability below ${Math.round(threshold*100)}% threshold`);
  if(f.regime!=='trend')reasons.push('Range or high-volatility regime');
  if((lean==='LONG'?1:-1)*f.trend<=0)reasons.push('Direction conflicts with trend');
  if(lean==='LONG'&&f.priceAction.bias<-.34)reasons.push('Price action is materially bearish');
  if(lean==='SHORT'&&f.priceAction.bias>.34)reasons.push('Price action is materially bullish');
  if(lean==='LONG'&&f.context.newsSentiment<-.25)reasons.push('Recent news sentiment conflicts with LONG bias');
  if(lean==='SHORT'&&f.context.newsSentiment>.25)reasons.push('Recent news sentiment conflicts with SHORT bias');
  if(lean==='LONG'&&f.context.macroBias<-.35)reasons.push('Macro backdrop conflicts with LONG bias');
  if(lean==='SHORT'&&f.context.macroBias>.35)reasons.push('Macro backdrop conflicts with SHORT bias');
  let higherTimeframe=null;
  if(tf==='1h'){
    try{
      const hRows=db.prepare('SELECT * FROM candles WHERE symbol=? AND timeframe=? AND ts+?<=? ORDER BY ts DESC LIMIT 120').all(symbol,'4h',ms('4h'),now).reverse();
      const hf=features(hRows,symbol,now);higherTimeframe={trend:hf.trend,regime:hf.regime,priceAction:hf.priceAction.structure};
      if((lean==='LONG'?1:-1)*hf.trend<0)reasons.push('4H trend conflicts with 1H directional lean');
    }catch{}
  }
  if(f.atr/f.price*10000<cost.total*2)reasons.push('Expected range too small relative to estimated costs');
  const eventFundamentals=eventFundamentalBias(events,symbol,now);
  const fundamentalBias=Math.max(-1,Math.min(1,.50*Number(f.context.macroBias||0)+.30*Number(f.context.newsSentiment||0)+.20*eventFundamentals.bias));
  const confluence=confluenceFor(lean,f,higherTimeframe,fundamentalBias);
  if(confluence.score<.12)reasons.push('Technical and fundamental evidence lacks directional confluence');
  const relevantEvents=Array.isArray(events)?events.filter(e=>{
    const t=new Date(e.time).getTime();return Number.isFinite(t)&&t>=now-3600000&&t<=now+24*3600000;
  }).sort((a,b)=>new Date(a.time)-new Date(b.time)).slice(0,5):[];
  if(!Array.isArray(events)||!events.length)reasons.push('Economic calendar unavailable');
  else if(relevantEvents.some(e=>String(e.impact).toLowerCase()==='high'&&Math.abs(new Date(e.time).getTime()-now)<=3600000))reasons.push('High-impact event within one hour');
  const paSummary=[f.priceAction.structure,...f.priceAction.patterns].filter(Boolean).join(', ');
  const technicalReasons=[
    `EMA trend score ${f.trend.toFixed(2)} ATR (${f.trend>0?'bullish':'bearish'})`,
    `RSI(14) ${f.rsi.toFixed(1)}`,
    `MACD histogram ${Number(f.macd.histogram||0).toFixed(5)}`,
    `ADX ${Number(f.adx.value||0).toFixed(1)} · +DI ${Number(f.adx.pdi||0).toFixed(1)} / -DI ${Number(f.adx.mdi||0).toFixed(1)}`,
    `EMA20 slope ${Number(f.emaSlope||0).toFixed(2)} ATR · 5-bar momentum ${Number(f.momentum5||0).toFixed(2)} ATR`,
    `Bollinger position ${(f.bollinger.position*100).toFixed(0)}% of band`,
    `Volatility regime: ${f.regime}`
  ];
  const confirmations=[];
  if((lean==='LONG'?1:-1)*f.trend>0)confirmations.push('Primary EMA trend aligns with direction');
  if((lean==='LONG'&&f.priceAction.bias>0)||(lean==='SHORT'&&f.priceAction.bias<0))confirmations.push('Price action bias confirms direction');
  if((lean==='LONG'&&f.context.newsSentiment>0)||(lean==='SHORT'&&f.context.newsSentiment<0))confirmations.push('Recent news sentiment confirms direction');
  if((lean==='LONG'&&f.context.macroBias>0)||(lean==='SHORT'&&f.context.macroBias<0))confirmations.push('Macro backdrop confirms direction');
  if((lean==='LONG'&&eventFundamentals.bias>0)||(lean==='SHORT'&&eventFundamentals.bias<0))confirmations.push('Recent economic surprise confirms direction');
  if(higherTimeframe&&(lean==='LONG'?1:-1)*higherTimeframe.trend>0)confirmations.push('4H trend confirms 1H direction');
  if(confluence.score>=.35)confirmations.push('Technical + fundamental confluence is strong');
  const risks=[...reasons];
  const explanation=reasons.length?reasons:[`All strict gates passed; price action: ${paSummary||'neutral'}`];
  const base={symbol,timeframe:tf,price:f.price,leanDirection:lean,candidateDirection:candidate,direction:reasons.length?'WAIT':candidate,probability:setupProbability??directionalProbability,setupProbability,directionalProbability,minProbability:threshold,directionalMinProbability:directionalFloor,
    probabilityMeaning:'Setup probability estimates P(success | confirmation entry triggers) for this entry/SL/TP structure; directional probability is reported separately',
    confidence:setupProbability??0,features:{...f,context:undefined,x:undefined},priceAction:f.priceAction,higherTimeframe,regime:f.regime,costs:cost,filters:reasons,explanation,
    analysis:{thesis:`${lean} directional lean at ${(directionalProbability*100).toFixed(1)}%; triggered setup success probability is ${setupProbability===null?'unavailable':(setupProbability*100).toFixed(1)+'%'}; evidence agreement is ${confluence.agreement}%.`,
      technical:technicalReasons,technicalBias:f.technicalBias,priceAction:{structure:f.priceAction.structure,patterns:f.priceAction.patterns,bias:f.priceAction.bias},
      news:{available:f.context.newsAvailable,count:f.context.newsCount,sentiment:f.context.newsSentiment,headlines:f.context.newsHeadlines},
      macro:{available:f.context.macroAvailable,bias:f.context.macroBias,series:f.context.macro},
      fundamentals:{bias:fundamentalBias,eventBias:eventFundamentals.bias,eventSurprises:eventFundamentals.surprises},
      confluence,
      calendar:relevantEvents.map(e=>({time:e.time,event:e.event,currency:e.currency||e.country,impact:e.impact,actual:e.actual,forecast:e.forecast??e.estimate,previous:e.previous})),
      confirmations,risks},
    eventRisk:reasons.some(r=>r.includes('event'))?1:0,generatedAt:now,sourceCandleTs:rows.at(-1).ts,horizonBars:m?.model?.horizon||4,modelId:m?.id||null,modelVersion:VERSION,modelApproved:!!m?.approved,execution:'gated'};
  return {...base,tradePlan:buildTradePlan(base,{side:lean})};
}
function status(){return db.prepare('SELECT symbol,timeframe,MAX(id) id FROM research_models WHERE version=? GROUP BY symbol,timeframe').all(VERSION).map(r=>latest(r.symbol,r.timeframe).report);}
module.exports={VERSION,ms,snapshot,captureMacro,recordNews,context,features,costs,dataset,fit,calibrate,predict,evaluate,evaluateTradePlans,thresholdDiagnostics,split,trainSeries,signal,status,setupModel};
