require('dotenv').config();

const {SYMBOLS,news,calendar}=require('./providers');
const history=require('./history');
const research=require('./research');
const signalMonitor=require('./signalMonitor');
const brokerBridge=require('./brokerBridge');
const execution=require('./execution');
const {syncMacro,syncPointInTimeMacro}=require('./macro');

const sleepImmediate=()=>new Promise(resolve=>setImmediate(resolve));
let syncing=false;

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

function compactLearning(rows){
  return (rows||[]).map(x=>({
    symbol:x.symbol,timeframe:x.timeframe,status:x.status||'trained',error:x.error||null,approved:!!x.approved,
    fundamentalCoverage:x.fundamentalCoverage??null,newsCoverage:x.newsCoverage??null,
    directional:{accuracy:x.qualifiedAccuracy??null,minProbability:x.directionalMinProbability??null},
    setup:x.setupProbability?{
      status:x.setupProbability.status,testSamples:x.setupProbability.testSamples??x.setupProbability.samples??null,
      baseRate:x.setupProbability.baseRate??null,accuracy:x.setupProbability.accuracy??null,
      logLoss:x.setupProbability.logLoss??null,baselineLoss:x.setupProbability.baselineLoss??null,
      selected:x.setupProbability.selected??0,selectedAccuracy:x.setupProbability.selectedAccuracy??null,
      averageR:x.setupProbability.averageR??null,p90:x.setupProbability.prediction?.p90??null,max:x.setupProbability.prediction?.max??null,
      calibrationRecommendedThreshold:x.setupProbability.calibrationRecommendedThreshold??null,
      recommendedTest:x.setupProbability.recommendedTest??null,
      planOptions:x.setupProbability.planOptions??null,
      planTune:x.setupProbability.planSelection?.chosen?.stats??null,
      modelCompetition:x.setupProbability.modelCompetition??null,
      adaptation:x.setupProbability.adaptation??null
    }:null,
    folds:(x.folds||[]).map(f=>({
      directionalLogLoss:f.logLoss??null,
      setup:f.setupProbability?{
        status:f.setupProbability.status,
        logLoss:f.setupProbability.logLoss??null,
        baselineLoss:f.setupProbability.baselineLoss??null,
        calibrationRecommendedThreshold:f.setupProbability.calibrationRecommendedThreshold??null,
        recommendedTest:f.setupProbability.recommendedTest??null
      }:null
    }))
  }));
}

async function collectNews(){
  const runs=[];
  for(const symbol of SYMBOLS){
    try{
      const articles=await news(symbol);
      research.recordNews(symbol,articles);
      runs.push({symbol,articles:articles.length});
    }catch(e){
      runs.push({symbol,error:'News collection failed'});
    }
  }
  return runs;
}

async function trainAll(){
  const learning=[];
  if(process.env.MODEL_AUTO_TRAIN!=='true')return learning;
  const priority=[['XAUUSD','4h']];
  const rest=[];
  for(const timeframe of ['1h','4h'])for(const symbol of SYMBOLS){
    if(symbol==='XAUUSD'&&timeframe==='4h')continue;
    rest.push([symbol,timeframe]);
  }
  for(const [symbol,timeframe] of [...priority,...rest]){
    let report;
    try{report=research.trainSeries(symbol,timeframe);}
    catch(e){report={symbol,timeframe,error:e.message};}
    learning.push(report);
    console.log(JSON.stringify({
      event:'research-series-trained',version:research.VERSION,symbol,timeframe,
      approved:!!report.approved,status:report.status||'trained',
      setup:report.setupProbability?{
        status:report.setupProbability.status,testSamples:report.setupProbability.testSamples??null,
        selected:report.setupProbability.selected??0,selectedAccuracy:report.setupProbability.selectedAccuracy??null,
        averageR:report.setupProbability.averageR??null,logLoss:report.setupProbability.logLoss??null,
        baselineLoss:report.setupProbability.baselineLoss??null,
        plan:report.setupProbability.planOptions?.name||null,
        adaptation:report.setupProbability.adaptation?.selected||null
      }:null
    }));
    await sleepImmediate();
  }
  return learning;
}

async function generateSignals(){
  const events=await calendar().catch(()=>null),recordedSignals=[],generatedSignals=[];
  for(const symbol of SYMBOLS)for(const timeframe of ['1h','4h']){
    try{
      const signal=research.signal(symbol,timeframe,events);
      generatedSignals.push(signal);
      const row=signalMonitor.record(signal);
      recordedSignals.push({
        symbol,timeframe,id:row.id,direction:signal.direction,candidateDirection:signal.candidateDirection,
        setupProbability:signal.setupProbability,directionalProbability:signal.directionalProbability,
        confluence:signal.analysis?.confluence?.agreement
      });
    }catch(error){
      recordedSignals.push({symbol,timeframe,error:error.message});
    }
  }
  return {recordedSignals,generatedSignals};
}

async function runCycle({bootstrap=false}={}){
  if(syncing)return {skipped:'cycle already running'};
  syncing=true;
  const startedAt=Date.now();
  console.log(JSON.stringify({event:'research-worker-cycle-start',bootstrap,startedAt,version:research.VERSION}));
  try{
    const historyBackfill=bootstrap&&process.env.HISTORY_BACKFILL_ENABLED==='true'
      ?await history.backfillHistory({
          targetBars:Number(process.env.HISTORY_BACKFILL_TARGET_BARS||5000),
          maxPages:Number(process.env.HISTORY_BACKFILL_PAGES||1)
        })
      :[];

    let learning=bootstrap?await trainAll():[];
    const macro=process.env.FRED_API_KEY?await syncMacro():[];
    const macroVintages=process.env.FRED_API_KEY?await syncPointInTimeMacro():[];
    research.captureMacro();
    const newsRuns=await collectNews();
    const market=process.env.HISTORY_AUTO_SYNC==='true'?await history.syncHistory():[];
    const settledSignals=signalMonitor.settle();
    if(!bootstrap)learning=await trainAll();
    const {recordedSignals,generatedSignals}=await generateSignals();
    const autoDemoRuns=await autoDemoStrict(generatedSignals);
    const brokerHealth=await brokerBridge.health().catch(e=>({configured:false,reachable:false,reason:e.message}));
    const executionRuns=[];

    if(process.env.AUTO_PAPER_TRADING==='true'&&String(process.env.EXECUTION_MODE||'off').toLowerCase()==='paper'){
      for(const signal of generatedSignals.filter(x=>x.timeframe==='1h')){
        try{
          executionRuns.push({symbol:signal.symbol,...execution.createIntent(signal,{
            riskPct:Number(process.env.RISK_PER_TRADE_PCT||0.5),
            equity:Number(process.env.PAPER_EQUITY||10000),
            maxPositionUnits:Number(process.env.MAX_POSITION_UNITS||100000)
          })});
        }catch(error){
          executionRuns.push({symbol:signal.symbol,error:error.message});
        }
      }
    }

    const learningSummary=compactLearning(learning);
    const approvedCount=learningSummary.filter(x=>x.approved).length;
    console.log(JSON.stringify({event:'model-summary',version:research.VERSION,approvedCount,learning:learningSummary}));
    console.log(JSON.stringify({
      event:bootstrap?'signal-bootstrap':'research-sync',
      role:'background-worker',version:research.VERSION,startedAt,finishedAt:Date.now(),durationMs:Date.now()-startedAt,
      historyBackfill,macro,macroVintages,newsRuns,market,settledSignals,learning:learningSummary,
      recordedSignals,autoDemoRuns,brokerHealth,signalMetrics:signalMonitor.metrics(),executionRuns
    }));
    return {ok:true,approvedCount};
  }catch(error){
    console.error(JSON.stringify({event:'research-worker-error',bootstrap,error:error.message,stack:String(error.stack||'').split('\n').slice(0,5)}));
    return {ok:false,error:error.message};
  }finally{
    syncing=false;
  }
}

console.log(JSON.stringify({event:'background-worker-started',pid:process.pid,version:research.VERSION}));
setTimeout(()=>runCycle({bootstrap:true}),1000);

const minutes=Math.max(15,Number(process.env.HISTORY_SYNC_MINUTES||60));
setInterval(()=>runCycle({bootstrap:false}),minutes*60000);

process.on('SIGTERM',()=>process.exit(0));
process.on('SIGINT',()=>process.exit(0));
