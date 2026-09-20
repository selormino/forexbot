require('dotenv').config();
const path=require('path');const express=require('express');const cors=require('cors');const helmet=require('helmet');
const db=require('./db');const {SYMBOLS,candles,news,calendar,providerStatus}=require('./providers');const {makeSignal}=require('./analysis');const model=require('./model');const {planTrade}=require('./risk');
const research=require('./research');
const history=require('./history');const {syncMacro,syncPointInTimeMacro,macroStatus,vintageStatus}=require('./macro');
const execution=require('./execution');
const signalMonitor=require('./signalMonitor');
const brokerBridge=require('./brokerBridge');
const settings=require('./settings');
const app=express();app.use(helmet({contentSecurityPolicy:false}));app.use(cors());app.use(express.json({limit:'1mb'}));app.use(express.static(path.join(__dirname,'../public')));
const enabled=()=>process.env.TRADING_ENABLED==='true';
const admin=(req,res,next)=>{const configured=process.env.ADMIN_API_KEY;if(!configured)return res.status(503).json({error:'ADMIN_API_KEY is not configured'});const supplied=req.get('x-admin-token')||String(req.get('authorization')||'').replace(/^Bearer\s+/i,'');if(supplied!==configured)return res.status(401).json({error:'Invalid admin token'});next();};
app.use('/api', (req,res,next)=>{if(req.method==='POST')return admin(req,res,next);next();});
app.get('/api/settings',(req,res)=>res.json(settings.status()));
app.post('/api/settings/signal-threshold',(req,res)=>{try{const value=Number(req.body?.value);res.json({...settings.status(),signalMinProbability:settings.setSignalMinProbability(value),source:'database',updatedAt:Date.now()});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/research/status',(req,res)=>res.json({version:research.VERSION,models:research.status()}));
app.get('/api/research/edge',(req,res)=>{const models=research.status();res.json({version:research.VERSION,target:Number(process.env.SIGNAL_TARGET_ACCURACY||.70),series:models.map(m=>({symbol:m.symbol,timeframe:m.timeframe,approved:m.approved,samples:m.samples,setupBacktest:m.setupBacktest,thresholdSweep:m.thresholdSweep||[],contextSamples:m.contextSamples||0,fundamentalCoverage:m.fundamentalCoverage||0,newsCoverage:m.newsCoverage||0}))});});
app.get('/api/signals/metrics',(req,res)=>res.json(signalMonitor.metrics()));
app.get('/api/signals/history',(req,res)=>res.json(signalMonitor.history(req.query.limit)));
app.get('/api/signals/board',async(req,res)=>{try{const e=await calendar().catch(()=>null);const out=[];for(const symbol of SYMBOLS)for(const timeframe of ['1h','4h']){try{out.push(research.signal(symbol,timeframe,e));}catch(err){out.push({symbol,timeframe,direction:'WAIT',candidateDirection:'WAIT',directionalProbability:0,filters:[err.message],priceAction:null,regime:'unknown'});}}res.json(out);}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/execution/status',(req,res)=>res.json(execution.status()));
app.get('/api/broker/status',async(req,res)=>res.json(await brokerBridge.health()));
app.post('/api/broker/demo-dispatch/:id',admin,async(req,res)=>{try{res.json(await brokerBridge.dispatchDemo(Number(req.params.id)));}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/broker/manual-preview/:id',admin,async(req,res)=>{try{res.json(await brokerBridge.previewManual(Number(req.params.id)));}catch(e){res.status(400).json({error:e.response?.data?.detail||e.message});}});
app.post('/api/broker/symbols',admin,async(req,res)=>{try{res.json(await brokerBridge.symbols(String(req.body?.query||'')));}catch(e){res.status(400).json({error:e.response?.data?.detail||e.message});}});
app.post('/api/broker/manual-dispatch/:id',admin,async(req,res)=>{try{res.json(await brokerBridge.dispatchManual(Number(req.params.id),{confirm:req.body?.confirm}));}catch(e){res.status(400).json({error:e.response?.data?.detail||e.message});}});
app.post('/api/broker/reconcile',admin,async(req,res)=>{try{res.json(await brokerBridge.reconcile(Number(req.body?.limit||100)));}catch(e){res.status(400).json({error:e.response?.data?.detail||e.message});}});
app.get('/api/execution/intents',(req,res)=>res.json(execution.list(req.query.limit)));
app.post('/api/execution/evaluate',admin,async(req,res)=>{try{const symbol=String(req.body?.symbol||'EURUSD').toUpperCase();const timeframe=String(req.body?.timeframe||'1h');if(!SYMBOLS.includes(symbol))throw new Error('Unsupported symbol');const e=await calendar().catch(()=>null);const signal=research.signal(symbol,timeframe,e);res.json({signal,intent:execution.createIntent(signal,{riskPct:Number(req.body?.riskPct||0.5),equity:Number(req.body?.equity||10000),maxPositionUnits:Number(req.body?.maxUnits||100000)})});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/execution/manual',admin,async(req,res)=>{try{const symbol=String(req.body?.symbol||'').toUpperCase(),timeframe=String(req.body?.timeframe||'1h'),side=String(req.body?.side||'').toUpperCase();if(!SYMBOLS.includes(symbol))throw new Error('Unsupported symbol');if(!['LONG','SHORT'].includes(side))throw new Error('side must be LONG or SHORT');const e=await calendar().catch(()=>null);const signal=research.signal(symbol,timeframe,e);const intent=execution.createManualIntent(signal,{side,equity:Number(req.body?.equity||process.env.PAPER_EQUITY||10000),riskPct:Number(req.body?.riskPct||process.env.RISK_PER_TRADE_PCT||0.5),maxPositionUnits:Number(req.body?.maxUnits||process.env.MAX_POSITION_UNITS||100000)});res.json({signal,intent,broker:brokerBridge.status()});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/execution/intents/:id/approve',admin,(req,res)=>{try{res.json(execution.approve(Number(req.params.id)));}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/news/history',(req,res)=>res.json(db.prepare('SELECT symbol,published_at,known_at,headline,score,provider FROM news_history WHERE symbol=? ORDER BY known_at DESC LIMIT 100').all(String(req.query.symbol||'EURUSD').toUpperCase())));
app.post('/api/research/train',(req,res)=>{try{const symbol=String(req.body.symbol||'EURUSD').toUpperCase();if(!SYMBOLS.includes(symbol))throw new Error('Unsupported symbol');res.json(research.trainSeries(symbol,req.body.timeframe||'1h'));}catch(e){res.status(400).json({error:e.message});}});
app.get('/health',(req,res)=>res.json({ok:true,time:new Date().toISOString(),tradingEnabled:enabled(),providers:providerStatus()}));
app.get('/api/providers',(req,res)=>res.json(providerStatus()));
app.get('/api/market',async(req,res)=>{try{const symbol=(req.query.symbol||'EURUSD').toUpperCase();if(!SYMBOLS.includes(symbol))return res.status(400).json({error:'Unsupported symbol'});res.json({symbol,provider:providerStatus().market,candles:await candles(symbol,req.query.interval||'1h',250)});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/calendar',async(req,res)=>{try{res.json(await calendar());}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/news',async(req,res)=>{try{res.json(await news((req.query.symbol||'EURUSD').toUpperCase()));}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/signal',async(req,res)=>{try{const symbol=(req.query.symbol||'EURUSD').toUpperCase();const e=await calendar().catch(()=>null);res.json(research.signal(symbol,req.query.timeframe||'1h',e));}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/signals',async(req,res)=>{try{const e=await calendar().catch(()=>null);const out=[];for(const symbol of SYMBOLS){out.push(research.signal(symbol,'1h',e));}res.json(out);}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/risk-plan',async(req,res)=>{try{const symbol=(req.query.symbol||'EURUSD').toUpperCase();const e=await calendar().catch(()=>null);const signal=research.signal(symbol,req.query.timeframe||'1h',e);res.json({signal,risk:planTrade(signal,{riskPct:Number(req.query.riskPct||0.5),equity:Number(req.query.equity||10000),maxPositionUnits:Number(req.query.maxUnits||100000)})});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/history/status',(req,res)=>res.json({...history.status(),macro:macroStatus(),macroVintages:vintageStatus()}));
app.get('/api/history/candles',(req,res)=>{const symbol=(req.query.symbol||'EURUSD').toUpperCase(),timeframe=String(req.query.timeframe||'1h'),limit=Math.max(1,Math.min(5000,Number(req.query.limit||500)));if(!SYMBOLS.includes(symbol))return res.status(400).json({error:'Unsupported symbol'});res.json(db.prepare('SELECT ts,open,high,low,close,volume,provider FROM candles WHERE symbol=? AND timeframe=? ORDER BY ts DESC LIMIT ?').all(symbol,timeframe,limit).reverse());});
app.post('/api/history/sync',admin,async(req,res)=>{try{const symbols=Array.isArray(req.body?.symbols)?req.body.symbols.map(x=>String(x).toUpperCase()):SYMBOLS;const invalid=symbols.filter(x=>!SYMBOLS.includes(x));if(invalid.length)return res.status(400).json({error:`Unsupported symbols: ${invalid.join(', ')}`});const timeframes=Array.isArray(req.body?.timeframes)?req.body.timeframes:history.DEFAULT_TIMEFRAMES;res.json({results:await history.syncHistory({symbols,timeframes,outputsize:req.body?.outputsize})});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/macro/sync',admin,async(req,res)=>{try{res.json({results:await syncMacro(req.body?.seriesIds)});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/macro/vintages/status',(req,res)=>res.json(vintageStatus()));
app.post('/api/macro/vintages/sync',admin,async(req,res)=>{try{res.json({results:await syncPointInTimeMacro(req.body?.seriesIds,req.body?.options||{})});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/backtest/walk-forward',admin,(req,res)=>{try{const config=req.body||{};const result=model.walkForwardFromDb(config);const id=model.saveBacktest(result,config);res.json({id,...result});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/backtests/latest',(req,res)=>res.json(model.latestBacktest()||{}));
app.post('/api/training/observations',(req,res)=>res.status(410).json({error:'Manual labels disabled; v2 trains from closed candles'}));
app.post('/api/model/train',(req,res)=>{try{res.json(research.trainSeries(String(req.body?.symbol||'EURUSD').toUpperCase(),req.body?.timeframe||'1h'));}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/model/status',(req,res)=>{const models=research.status();res.json({version:research.VERSION,trained:models.length>0,models,legacyModelNotUsed:true});});
app.get('/api/paper-trades',(req,res)=>res.json(db.prepare('SELECT * FROM paper_trades ORDER BY id DESC LIMIT 100').all()));
app.post('/api/paper-trades',(req,res)=>{try{if(enabled())return res.status(403).json({error:'Live execution is not implemented in this release. Keep TRADING_ENABLED=false'});const {symbol,side,entry,stop,target,units}=req.body;if(!symbol||!['LONG','SHORT'].includes(side)||!entry||!units)return res.status(400).json({error:'symbol, side, entry and units are required'});const r=db.prepare('INSERT INTO paper_trades(created_at,symbol,side,entry,stop,target,units) VALUES(?,?,?,?,?,?,?)').run(Date.now(),symbol,side,entry,stop||null,target||null,units);res.json({ok:true,id:r.lastInsertRowid});}catch(e){res.status(400).json({error:e.message});}});
const port=Number(process.env.PORT||3000);app.listen(port,()=>console.log(`ForexBot AI listening on ${port}`));

async function autoDemoStrict(signals){
  if(process.env.AUTO_DEMO_STRICT!=='true')return [];
  if(String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase()!=='demo')return [{skipped:'Automatic strict execution is demo-only'}];
  const runs=[];
  for(const signal of signals){
    if(!['LONG','SHORT'].includes(signal.direction))continue;
    try{
      const intent=execution.createAutoDemoIntent(signal,{riskPct:Number(process.env.RISK_PER_TRADE_PCT||0.5)});
      if(!intent.created){runs.push({symbol:signal.symbol,timeframe:signal.timeframe,...intent});continue;}
      const broker=await brokerBridge.previewAndDispatchDemo(intent.id);
      runs.push({symbol:signal.symbol,timeframe:signal.timeframe,intentId:intent.id,brokerOrderId:broker.sent.brokerOrderId,status:'DEMO_SENT'});
    }catch(e){
      runs.push({symbol:signal.symbol,timeframe:signal.timeframe,error:e.response?.data?.detail||e.message});
    }
  }
  return runs;
}

async function bootstrapMonitoring(){
  try{
    let macroVintages=[];
    if(process.env.FRED_API_KEY&&vintageStatus().length<5){
      macroVintages=await syncPointInTimeMacro();
    }
    const learning=[];
    if(process.env.MODEL_AUTO_TRAIN==='true'){
      for(const symbol of SYMBOLS)for(const tf of ['1h','4h']){
        try{learning.push(research.trainSeries(symbol,tf));}catch(e){learning.push({symbol,timeframe:tf,error:e.message});}
        await new Promise(resolve=>setImmediate(resolve));
      }
    }
    const settledSignals=signalMonitor.settle();
    const brokerReconcile=await brokerBridge.reconcile().catch(e=>({checked:0,error:e.message}));
    const e=await calendar().catch(()=>null),recordedSignals=[],generatedSignals=[];
    for(const symbol of SYMBOLS)for(const timeframe of ['1h','4h']){
      try{
        const s=research.signal(symbol,timeframe,e);generatedSignals.push(s);
        recordedSignals.push({symbol,timeframe,id:signalMonitor.record(s).id,direction:s.direction,candidateDirection:s.candidateDirection,directionalProbability:s.directionalProbability,confluence:s.analysis?.confluence?.agreement});
      }catch(err){recordedSignals.push({symbol,timeframe,error:err.message});}
    }
    const autoDemoRuns=await autoDemoStrict(generatedSignals);
    console.log(JSON.stringify({event:'signal-bootstrap',macroVintages,learning,settledSignals,brokerReconcile,recordedSignals,autoDemoRuns,signalMetrics:signalMonitor.metrics()}));
  }catch(e){console.error('Signal bootstrap failed:',e.message);}
}
setTimeout(bootstrapMonitoring,3000);

let syncing=false;
async function scheduledSync(){
  if(syncing)return;syncing=true;
  try{
    const macro=process.env.FRED_API_KEY?await syncMacro():[];
    const macroVintages=process.env.FRED_API_KEY?await syncPointInTimeMacro():[];
    research.captureMacro();
    const newsRuns=[];
    for(const symbol of SYMBOLS){try{const articles=await news(symbol);research.recordNews(symbol,articles);newsRuns.push({symbol,articles:articles.length});}catch(e){newsRuns.push({symbol,error:'News collection failed'});}}
    const market=await history.syncHistory();
    const settledSignals=signalMonitor.settle();
    const brokerReconcile=await brokerBridge.reconcile().catch(e=>({checked:0,error:e.message}));
    const learning=[];
    if(process.env.MODEL_AUTO_TRAIN==='true'){
      for(const symbol of SYMBOLS)for(const tf of ['1h','4h']){
        try{learning.push(research.trainSeries(symbol,tf));}catch(e){learning.push({symbol,timeframe:tf,error:e.message});}
        await new Promise(resolve=>setImmediate(resolve));
      }
    }
    const recordedSignals=[],generatedSignals=[];
    const signalEvents=await calendar().catch(()=>null);
    for(const symbol of SYMBOLS)for(const timeframe of ['1h','4h']){
      try{
        const s=research.signal(symbol,timeframe,signalEvents);generatedSignals.push(s);
        recordedSignals.push({symbol,timeframe,id:signalMonitor.record(s).id,direction:s.direction,candidateDirection:s.candidateDirection,directionalProbability:s.directionalProbability,confluence:s.analysis?.confluence?.agreement});
      }catch(err){recordedSignals.push({symbol,timeframe,error:err.message});}
    }
    const autoDemoRuns=await autoDemoStrict(generatedSignals);
    const executionRuns=[];
    if(process.env.AUTO_PAPER_TRADING==='true'&&String(process.env.EXECUTION_MODE||'off').toLowerCase()==='paper'){
      for(const signal of generatedSignals.filter(x=>x.timeframe==='1h')){
        try{executionRuns.push({symbol:signal.symbol,...execution.createIntent(signal,{riskPct:Number(process.env.RISK_PER_TRADE_PCT||0.5),equity:Number(process.env.PAPER_EQUITY||10000),maxPositionUnits:Number(process.env.MAX_POSITION_UNITS||100000)})});}
        catch(err){executionRuns.push({symbol:signal.symbol,error:err.message});}
      }
    }
    console.log(JSON.stringify({event:'research-sync',macro,macroVintages,newsRuns,market,settledSignals,brokerReconcile,learning,recordedSignals,autoDemoRuns,signalMetrics:signalMonitor.metrics(),executionRuns}));
  }catch(e){console.error('Research sync failed:',e.message);}finally{syncing=false;}
}
if(process.env.HISTORY_AUTO_SYNC==='true'){
  const minutes=Math.max(15,Number(process.env.HISTORY_SYNC_MINUTES||60));
  setTimeout(scheduledSync,15000);
  setInterval(scheduledSync,minutes*60000);
}

let brokerReconciling=false;
if(process.env.BROKER_RECONCILE_ENABLED==='true'){
  const seconds=Math.max(30,Number(process.env.BROKER_RECONCILE_SECONDS||60));
  setTimeout(async()=>{
    if(brokerReconciling)return;brokerReconciling=true;
    try{console.log(JSON.stringify({event:'broker-reconcile',...(await brokerBridge.reconcile())}));}catch(e){console.error('Broker reconcile failed:',e.message);}finally{brokerReconciling=false;}
  },20000);
  setInterval(async()=>{
    if(brokerReconciling)return;brokerReconciling=true;
    try{console.log(JSON.stringify({event:'broker-reconcile',...(await brokerBridge.reconcile())}));}catch(e){console.error('Broker reconcile failed:',e.message);}finally{brokerReconciling=false;}
  },seconds*1000);
}
