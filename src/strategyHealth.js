const db=require('./db');
const research=require('./research');
const signalMonitor=require('./signalMonitor');

function finite(v){return Number.isFinite(Number(v))?Number(v):null;}
function recentIngestion(hours=6){
  const since=Date.now()-Math.max(1,Number(hours)||6)*3600000;
  const rows=db.prepare('SELECT started_at,symbol,timeframe,provider,status,error FROM ingestion_runs WHERE started_at>=? ORDER BY id DESC LIMIT 500').all(since);
  const failed=rows.filter(r=>r.status==='FAILED');
  const quota=failed.filter(r=>/credit|quota|rate.?limit|too many|429/i.test(String(r.error||'')));
  const bySeries={};
  for(const row of rows){
    const key=row.symbol+':'+row.timeframe;
    if(!bySeries[key])bySeries[key]=row;
  }
  return {
    windowHours:hours,
    runs:rows.length,
    failures:failed.length,
    quotaFailures:quota.length,
    failureRate:rows.length?failed.length/rows.length:0,
    affectedSeries:[...new Set(failed.map(r=>r.symbol+':'+r.timeframe))],
    latestFailures:failed.slice(0,8).map(r=>({symbol:r.symbol,timeframe:r.timeframe,provider:r.provider,error:String(r.error||'').slice(0,240)}))
  };
}
function status(){
  const models=research.status();
  const approved=models.filter(m=>m.approved);
  const byTimeframe={};
  for(const m of models){
    const x=byTimeframe[m.timeframe]||(byTimeframe[m.timeframe]={total:0,approved:0});
    x.total++;if(m.approved)x.approved++;
  }
  const metrics=signalMonitor.metrics(),strict=metrics.strict||metrics.actionable||{},shadow=metrics.shadowFiltered||{};
  const data=recentIngestion(Number(process.env.EDGE_STATUS_INGESTION_HOURS||6));
  const dataDegraded=data.quotaFailures>0||data.failureRate>.20;
  const forwardReady=!!metrics.readyForBrokerValidation;
  const positiveEvidence=(strict.settled||0)>0&&finite(strict.averageR)>0&&finite(strict.expectancyLower95)>0&&(strict.profitFactorR==null||finite(strict.profitFactorR)>1);
  const convincing=approved.length>0&&forwardReady&&positiveEvidence&&!dataDegraded;
  const predictionQuality=convincing?'VALIDATED':approved.length?'VALIDATING':'NOT_VALIDATED';
  const reasons=[];
  if(!models.length)reasons.push('No model in the current research version has completed validation yet.');
  else if(!approved.length)reasons.push('Zero current research series have passed all out-of-sample approval gates.');
  if((strict.settled||0)<Number(process.env.SIGNAL_MIN_SETTLED||50))reasons.push('Approved forward outcomes are below the minimum settled sample.');
  if(strict.settled&&!(finite(strict.expectancyLower95)>0))reasons.push('Forward expectancy is not yet positive with 95% confidence.');
  if(data.quotaFailures)reasons.push('Recent market-data quota/rate-limit failures are degrading freshness.');
  else if(dataDegraded)reasons.push('Recent market-data ingestion failures are degrading freshness.');
  return {
    generatedAt:Date.now(),
    researchVersion:research.VERSION,
    verdict:predictionQuality,
    convincing,
    dataHealth:dataDegraded?'DEGRADED':'HEALTHY',
    approvedSeries:approved.length,
    totalSeries:models.length,
    approvedByTimeframe:byTimeframe,
    forward:{
      ready:forwardReady,
      minimumSettled:Number(process.env.SIGNAL_MIN_SETTLED||50),
      total:strict.total||0,settled:strict.settled||0,wins:strict.wins||0,losses:strict.losses||0,
      winRate:strict.accuracy??null,averageR:strict.averageR??null,expectancyLower95:strict.expectancyLower95??null,
      profitFactorR:strict.profitFactorR??null,maxDrawdownR:strict.maxDrawdownR??null
    },
    shadow:{
      settled:shadow.settled||0,winRate:shadow.accuracy??null,averageR:shadow.averageR??null,
      expectancyLower95:shadow.expectancyLower95??null,profitFactorR:shadow.profitFactorR??null,maxDrawdownR:shadow.maxDrawdownR??null
    },
    data,
    reasons,
    interpretation:convincing
      ?'Current approved strategy evidence is positive after costs and has enough forward outcomes to be considered validated for continued demo testing.'
      :'Do not treat current predictions as proven profitable yet. Continue research/demo validation and fix any data-quality blockers before increasing risk.'
  };
}
module.exports={status,recentIngestion};
