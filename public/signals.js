const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let board=[],settings=null,adminToken='',executionIntents=[];

async function get(u){const r=await fetch(u);const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
async function post(u,body,token=adminToken){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json','x-admin-token':token||''},body:JSON.stringify(body||{})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
const pct=x=>x==null?'—':(Number(x)*100).toFixed(1)+'%';
const fmt=x=>x==null?'—':Number(x).toFixed(Math.abs(Number(x))>=100?2:5);
const num=x=>x==null?'—':Number(x).toFixed(1);
const cls=x=>x==='LONG'?'long':x==='SHORT'?'short':'wait';
const statusOf=s=>s.direction!=='WAIT'?'STRICT':s.candidateDirection!=='WAIT'?'FILTERED':'WATCH';
const signalStatusMeta=code=>({
 STRICT:{label:'Ready — strict setup',detail:'All required model, probability, confluence and risk gates passed.'},
 FILTERED:{label:'Filtered — setup blocked',detail:'A possible setup was found, but one or more quality or safety gates rejected it.'},
 WATCH:{label:'Watching — no setup yet',detail:'The market is being monitored, but there is no qualified entry setup yet.'}
}[String(code||'').toUpperCase()]||{label:String(code||'—').replaceAll('_',' '),detail:''});
const executionForSignal=s=>{
 const key=[s.symbol,s.timeframe,s.source_ts??s.sourceCandleTs].join(':');
 return executionIntents.find(x=>!x.manual&&[x.symbol,x.timeframe,x.source_ts].join(':')===key)||null;
};
const brokerTrackingMeta=intent=>{
 if(!intent)return {label:'Internal monitoring',detail:'This setup has not been sent to XM. ForexBot will confirm entry from refreshed candle data.',css:'neutral'};
 const broker=String(intent.broker_status||'').toUpperCase(),status=String(intent.status||'').toUpperCase();
 if(status==='DEMO_FILLED'||broker==='OPEN')return {label:'XM entry filled',detail:`XM filled this demo order${intent.broker_order_id?' · ticket '+intent.broker_order_id:''}.`,css:'good'};
 if(status==='DEMO_CLOSED'||broker==='CLOSED')return {label:'XM trade closed',detail:`XM reports this demo trade closed${intent.broker_order_id?' · ticket '+intent.broker_order_id:''}.`,css:'good'};
 if(['DEMO_CANCELLED','BROKER_NOT_FOUND'].includes(status)||['CANCELLED','EXPIRED','REJECTED','NOT_FOUND'].includes(broker))return {label:'XM order inactive',detail:`The broker-side order is no longer pending${intent.broker_order_id?' · ticket '+intent.broker_order_id:''}.`,css:'bad'};
 if(intent.broker_order_id||status==='DEMO_SENT'||broker==='PENDING')return {label:'XM monitoring live price',detail:`Pending demo order is at XM and can trigger intrabar${intent.broker_order_id?' · ticket '+intent.broker_order_id:''}.`,css:'good'};
 return {label:'Preparing XM order',detail:'A demo execution intent exists but has not yet received a broker ticket.',css:'neutral'};
};

const lifecycleMeta=code=>({
 FILTERED:{label:'Filtered — not qualified',detail:'The setup failed one or more quality gates, so no entry was tracked.'},
 PENDING_ENTRY:{label:'Waiting for entry',detail:'The setup qualified, but price has not reached the planned entry yet.'},
 ACTIVE:{label:'Entry triggered — active',detail:'Price reached the entry. Stop, target and time limit are now being monitored.'},
 EXPIRED:{label:'Expired — entry never triggered',detail:'Price did not reach the planned entry before the entry window closed.'},
 SETTLED:{label:'Finished — result recorded',detail:'The setup has completed and its final result has been recorded.'}
}[String(code||'').toUpperCase()]||{label:String(code||'—').replaceAll('_',' '),detail:''});
const outcomeMeta=code=>({
 TP:{label:'Target hit — win',detail:'Price reached the planned profit target.'},
 SL:{label:'Stop hit — loss',detail:'Price reached the planned stop-loss.'},
 TIMEOUT_WIN:{label:'Time limit reached — win',detail:'Neither target nor stop was hit before the holding limit; closing price finished profitable after estimated costs.'},
 TIMEOUT_LOSS:{label:'Time limit reached — loss',detail:'Neither target nor stop was hit before the holding limit; closing price finished unprofitable after estimated costs.'},
 NO_ENTRY:{label:'No entry — expired',detail:'The confirmation entry was never triggered.'}
}[String(code||'').toUpperCase()]||{label:String(code||'—').replaceAll('_',' '),detail:''});
const stateHtml=(meta,css='neutral')=>`<span class="pill ${css}" title="${esc(meta.detail)}">${esc(meta.label)}</span>${meta.detail?`<small>${esc(meta.detail)}</small>`:''}`;
const friendly=e=>{const m=String(e?.message||e||'Unknown error');if(/Market closed/i.test(m))return 'This market is currently closed. No order was sent.';if(/Preview stale/i.test(m))return 'Price moved after the preview. Refresh the trade preview and try again.';if(/Autotrading disabled/i.test(m))return 'MT5 Algo Trading is disabled. Enable Algo Trading and external Python API trading in MT5.';return m.replace(/^MT5 order_send failed:\s*/,'');};

function modal(title,body,actions='',wide=false){ $('modalTitle').textContent=title;$('modalBody').innerHTML=body;$('modalActions').innerHTML=actions;document.querySelector('.modal')?.classList.toggle('wide',!!wide);$('modalBackdrop').classList.add('open');}
window.closeModal=()=>{document.querySelector('.modal')?.classList.remove('wide');$('modalBackdrop').classList.remove('open');};
window.backdropClose=e=>{if(e.target===$('modalBackdrop'))closeModal()};
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2800)}

function chartPath(values,x,y){
 const parts=[];let open=false;
 values.forEach((v,i)=>{if(v==null||!Number.isFinite(Number(v))){open=false;return}const p=(open?'L':'M')+x(i).toFixed(1)+' '+y(Number(v)).toFixed(1);parts.push(p);open=true});
 return parts.join(' ');
}
function mainChartSvg(data,sig){
 const c=data.candles||[],ind=data.indicators||{},p=sig.tradePlan||{};if(!c.length)return '<div class="notice">No candle data available.</div>';
 const W=1000,H=460,L=68,R=34,T=24,B=42,plotW=W-L-R,plotH=H-T-B,step=plotW/Math.max(1,c.length-1);
 const levels=[p.entry,p.stop,p.target,data.levels?.support,data.levels?.resistance].filter(Number.isFinite);
 const prices=[...c.flatMap(x=>[x.low,x.high]),...levels];let min=Math.min(...prices),max=Math.max(...prices);const pad=Math.max((max-min)*.07,Math.abs(max)*.0005,1e-6);min-=pad;max+=pad;
 const x=i=>L+i*step,y=v=>T+(max-v)/(max-min)*plotH;
 const grid=Array.from({length:6},(_,i)=>{const v=max-(max-min)*i/5,yy=y(v);return '<line class="chart-grid" x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'"/><text class="chart-axis" x="'+(L-8)+'" y="'+(yy+4)+'" text-anchor="end">'+esc(fmt(v))+'</text>'}).join('');
 const candles=c.map((b,i)=>{const xx=x(i),up=b.close>=b.open,top=y(Math.max(b.open,b.close)),bot=y(Math.min(b.open,b.close)),h=Math.max(1.5,bot-top),w=Math.max(2,Math.min(9,step*.55)),klass=up?'chart-up':'chart-down';return '<line class="'+klass+'" x1="'+xx+'" y1="'+y(b.high)+'" x2="'+xx+'" y2="'+y(b.low)+'"/><rect class="'+klass+' fill" x="'+(xx-w/2)+'" y="'+top+'" width="'+w+'" height="'+h+'"/>'}).join('');
 const ema20=chartPath(ind.ema20||[],x,y),ema50=chartPath(ind.ema50||[],x,y),ema200=chartPath(ind.ema200||[],x,y);
 const hline=(v,label,klass)=>Number.isFinite(v)?'<line class="'+klass+'" x1="'+L+'" y1="'+y(v)+'" x2="'+(W-R)+'" y2="'+y(v)+'"/><text class="chart-level-label '+klass+'" x="'+(W-R-3)+'" y="'+(y(v)-4)+'" text-anchor="end">'+esc(label)+' '+esc(fmt(v))+'</text>':'';
 const tsIndex=new Map(c.map((r,i)=>[Number(r.ts),i]));
 const patterns=(data.priceAction?.patterns||[]).slice(0,3).map((ptn,pi)=>{const pts=(ptn.points||[]).map(q=>({i:tsIndex.get(Number(q.ts)),price:Number(q.price),role:q.role})).filter(q=>Number.isFinite(q.i)&&Number.isFinite(q.price));if(pts.length<2)return '';const points=pts.map(q=>x(q.i)+','+y(q.price)).join(' ');const labels=pts.map(q=>'<text class="chart-pattern-label" x="'+x(q.i)+'" y="'+(y(q.price)-8)+'" text-anchor="middle">'+esc(q.role||ptn.label)+'</text>').join('');return '<polyline class="chart-pattern p'+pi+'" points="'+points+'"/>'+labels+'<text class="chart-pattern-title" x="'+(L+8)+'" y="'+(T+18+pi*18)+'">'+esc(ptn.label)+' · '+Math.round(Number(ptn.confidence||0)*100)+'%'+(ptn.confirmed?' · confirmed':'')+'</text>'}).join('');
 const tickEvery=Math.max(1,Math.floor(c.length/7));const timeLabels=c.map((b,i)=>i%tickEvery===0||i===c.length-1?'<text class="chart-axis" x="'+x(i)+'" y="'+(H-12)+'" text-anchor="middle">'+esc(new Date(b.ts).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit'}))+'</text>':'').join('');
 return '<div class="chart-frame"><svg class="trade-chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(sig.symbol+' '+sig.timeframe+' price chart')+'">'+grid+candles+'<path class="chart-line ema20" d="'+ema20+'"/><path class="chart-line ema50" d="'+ema50+'"/><path class="chart-line ema200" d="'+ema200+'"/>'+hline(data.levels?.support,'Support','support')+hline(data.levels?.resistance,'Resistance','resistance')+hline(p.entry,'Entry','entry')+hline(p.stop,'Stop','stop')+hline(p.target,'Target','target')+patterns+timeLabels+'<text class="chart-title" x="'+L+'" y="18">'+esc(sig.symbol+' · '+sig.timeframe.toUpperCase())+'</text></svg><div class="chart-legend"><span class="ema20">EMA20</span><span class="ema50">EMA50</span><span class="ema200">EMA200</span><span class="entry">Entry</span><span class="stop">SL</span><span class="target">TP</span></div></div>';
}
function oscillatorSvg(values,{min=0,max=100,lines=[],label=''}={}){
 const W=1000,H=132,L=48,R=25,T=18,B=22,w=W-L-R,h=H-T-B,x=i=>L+i*w/Math.max(1,values.length-1),y=v=>T+(max-v)/(max-min)*h;
 const path=chartPath(values,x,y),refs=lines.map(v=>'<line class="chart-grid strong" x1="'+L+'" y1="'+y(v)+'" x2="'+(W-R)+'" y2="'+y(v)+'"/><text class="chart-axis" x="'+(L-7)+'" y="'+(y(v)+4)+'" text-anchor="end">'+v+'</text>').join('');
 return '<svg class="indicator-chart" viewBox="0 0 '+W+' '+H+'"><text class="chart-title" x="'+L+'" y="14">'+esc(label)+'</text>'+refs+'<path class="chart-line oscillator" d="'+path+'"/></svg>';
}
function macdSvg(data){
 const a=data.indicators?.macd||[],b=data.indicators?.macdSignal||[],hist=data.indicators?.macdHist||[],all=[...a,...b,...hist].filter(v=>v!=null&&Number.isFinite(Number(v)));if(!all.length)return '';
 const W=1000,H=150,L=48,R=25,T=18,B=22,w=W-L-R,h=H-T-B,min=Math.min(0,...all),max=Math.max(0,...all),span=Math.max(max-min,1e-9),x=i=>L+i*w/Math.max(1,a.length-1),y=v=>T+(max-v)/span*h,zero=y(0),bw=Math.max(1,w/Math.max(1,a.length)*.65);
 const bars=hist.map((v,i)=>v==null?'':'<rect class="macd-bar '+(v>=0?'pos':'neg')+'" x="'+(x(i)-bw/2)+'" y="'+Math.min(zero,y(v))+'" width="'+bw+'" height="'+Math.max(1,Math.abs(y(v)-zero))+'"/>').join('');
 return '<svg class="indicator-chart" viewBox="0 0 '+W+' '+H+'"><text class="chart-title" x="'+L+'" y="14">MACD (12,26,9)</text><line class="chart-grid strong" x1="'+L+'" y1="'+zero+'" x2="'+(W-R)+'" y2="'+zero+'"/>'+bars+'<path class="chart-line macd" d="'+chartPath(a,x,y)+'"/><path class="chart-line macd-signal" d="'+chartPath(b,x,y)+'"/></svg>';
}
function patternCards(data){
 const pts=data.priceAction?.patterns||[];if(!pts.length)return '<div class="analysis-box"><h3>Pattern formations</h3><p>No high-quality classical formation detected in the current window.</p></div>';
 return pts.slice(0,6).map(p=>'<div class="analysis-box pattern-card"><h3>'+esc(p.label)+' <span class="pill '+(p.bias>0?'good':'bad')+'">'+(p.bias>0?'Bullish':'Bearish')+'</span></h3><p><b>'+Math.round(Number(p.confidence||0)*100)+'% pattern confidence</b> · '+(p.confirmed?'Confirmed':'Forming')+'</p><p>'+esc(p.description||'')+'</p></div>').join('');
}
window.showChart=async i=>{
 const sig=board[i];if(!sig)return;modal(sig.symbol+' · '+sig.timeframe+' chart analysis','<div class="notice">Loading closed candles and indicators…</div>','<button onclick="closeModal()">Close</button>',true);
 try{
  const data=await get('/api/signals/chart?symbol='+encodeURIComponent(sig.symbol)+'&timeframe='+encodeURIComponent(sig.timeframe)+'&limit=90');
  const sum=data.indicatorSummary||{},pa=data.priceAction||{},conf=sig.analysis?.confluence||{};
  $('modalBody').innerHTML='<div class="chart-summary"><div><span class="label">Setup probability</span><b>'+pct(sig.setupProbability)+'</b></div><div><span class="label">Evidence</span><b>'+((conf.agreement??0)+'%')+'</b></div><div><span class="label">Structure</span><b>'+esc(pa.structure||'—')+'</b></div><div><span class="label">Pattern bias</span><b class="'+(pa.patternBias>0?'long':pa.patternBias<0?'short':'wait')+'">'+Number(pa.patternBias||0).toFixed(2)+'</b></div></div>'+mainChartSvg(data,sig)+'<div class="indicator-stack">'+oscillatorSvg(data.indicators?.rsi||[],{min:0,max:100,lines:[30,50,70],label:'RSI (14)'})+macdSvg(data)+'</div><div class="analysis-grid chart-analysis-grid"><div class="analysis-box"><h3>Indicator interpretation</h3>'+(data.explanations||[]).map(x=>'<p>'+esc(x)+'</p>').join('')+'</div><div class="analysis-box"><h3>Evidence components</h3><p>Technical: '+Number(conf.components?.technical||0).toFixed(2)+'</p><p>Structure: '+Number(conf.components?.structure||0).toFixed(2)+'</p><p>Pattern: '+Number(conf.components?.pattern||0).toFixed(2)+'</p><p>Higher timeframe: '+Number(conf.components?.higherTimeframe||0).toFixed(2)+'</p><p>Fundamental: '+Number(conf.components?.fundamental||0).toFixed(2)+'</p></div><div class="analysis-box"><h3>Current indicators</h3><p>EMA alignment: <b>'+esc(sum.emaAlignment||'—')+'</b></p><p>RSI: <b>'+num(sum.rsi)+'</b> · '+esc(sum.rsiState||'')+'</p><p>MACD: <b>'+esc(sum.macdState||'—')+'</b></p><p>ADX: <b>'+num(sum.adx)+'</b> · '+esc(sum.trendStrength||'')+'</p></div>'+patternCards(data)+'</div>';
 }catch(e){$('modalBody').innerHTML='<div class="notice">'+esc(friendly(e))+'</div>';}
};

function renderAccuracy(m){
 const strict=m.strict||m.actionable,research=m.researchCandidates||m.qualified,all=m.allTimeActionable||strict;
 const currentAccuracy=strict.settled?pct(strict.accuracy):'—';
 const priorNote=!strict.settled&&all.settled?`<small>Current model: no finished approved setups yet · all-time ${pct(all.accuracy)} (${all.settled} finished)</small>`:'';
 $('accuracyCards').innerHTML=`
 <div class="card metric"><span class="label">Approved-trade accuracy</span><div class="big">${currentAccuracy}</div><span class="muted">${strict.wins} wins · ${strict.settled} finished approved setups</span>${priorNote}</div>
 <div class="card metric"><span class="label">Approved setups open</span><div class="big compact">${strict.pendingEntry+strict.active} open</div><span class="muted">${strict.pendingEntry} waiting for entry · ${strict.active} entry triggered</span></div>
 <div class="card metric"><span class="label">Research validation</span><div class="big compact">${m.readyForBrokerValidation?'READY':'RESEARCH'}</div><span class="muted">Target ${pct(m.targetAccuracy)} · research-only: ${research.settled} finished / ${research.wins} wins</span></div>
 <div class="card metric"><span class="label">Filtered-signal shadow accuracy</span><div class="big">${pct(m.shadowFiltered?.accuracy)}</div><span class="muted">${m.shadowFiltered?.wins||0} wins · ${m.shadowFiltered?.settled||0} finished · ${m.shadowFiltered?.expired||0} no-entry</span></div>`;
}
function renderSettings(s){settings=s;$('thresholdInput').value=Math.round(Number(s.signalMinProbability||.7)*100);$('thresholdSource').textContent=s.source==='database'?'custom':'default';}
function renderBroker(b){
 $('brokerMode').textContent=(b.mode||'demo').toUpperCase();
 const ok=!!(b.configured&&b.reachable&&b.bridge?.accountConnected);
 $('brokerDot').className='dot'+(ok?' ok':'');
 $('brokerText').textContent=ok?'XM MT5 connected':b.configured?'Bridge unavailable':'Bridge not configured';
}
function renderBoard(rows){
 board=rows;
 $('signalBoard').innerHTML=rows.map((s,i)=>{
  const p=s.tradePlan||{},status=statusOf(s),conf=s.analysis?.confluence?.agreement,unit=p.unitLabel||'pips';
  return `<tr>
   <td><b>${esc(s.symbol)}</b><small>${esc(s.timeframe)} · spot ${fmt(s.price)}</small></td>
   <td class="${cls(s.leanDirection)}"><b>${esc(s.leanDirection||'WAIT')}</b><small>${esc(s.regime||'')}</small></td>
   <td><b>${pct(s.setupProbability)}</b><small>direction ${pct(s.directionalProbability)} · min ${pct(s.minProbability)}</small></td>
   <td><b>${conf==null?'—':conf+'%'}</b><small>cross-factor agreement</small></td>
   <td><b>${fmt(p.entry)}</b><small>SL ${fmt(p.stop)} · TP ${fmt(p.target)} · ${num(p.targetPips)} ${esc(unit)}</small></td>
   <td><b>${p.riskReward?Number(p.riskReward).toFixed(2):'—'}</b></td>
   <td>${stateHtml(signalStatusMeta(status),status==='STRICT'?'good':'neutral')}<small>${esc((s.filters||[])[0]||'All gates passed')}</small>${['LONG','SHORT'].includes(s.candidateDirection)?stateHtml(brokerTrackingMeta(executionForSignal(s)),brokerTrackingMeta(executionForSignal(s)).css):''}</td>
   <td><div class="action-stack"><button class="small-btn" onclick="showChart(${i})">Chart</button><button class="small-btn" onclick="explain(${i})">Details</button><button class="small-btn primary" onclick="trade(${i})">Trade</button></div></td>
  </tr>`;
 }).join('');
 $('boardUpdated').textContent=new Date().toLocaleTimeString();
}
function list(title,arr){return `<div class="analysis-box"><h3>${esc(title)}</h3><ul>${(arr||[]).slice(0,6).map(x=>`<li>${esc(x)}</li>`).join('')||'<li>None</li>'}</ul></div>`}
window.explain=i=>{
 const s=board[i],a=s.analysis||{},p=s.tradePlan||{},fund=a.fundamentals||{},n=a.news||{},pa=a.priceAction||{};
 modal(`${s.symbol} · ${s.timeframe}`,`
   <div class="kv">
    <div><small>Bias</small><b class="${cls(s.leanDirection)}">${esc(s.leanDirection)}</b></div>
    <div><small>Setup success</small><b>${pct(s.setupProbability)}</b><small>direction ${pct(s.directionalProbability)}</small></div>
    <div><small>Evidence agreement</small><b>${a.confluence?.agreement??'—'}%</b></div>
    <div><small>Status</small><b>${esc(signalStatusMeta(statusOf(s)).label)}</b><small>${esc(signalStatusMeta(statusOf(s)).detail)}</small></div>
   </div>
   <div class="notice">${esc(a.thesis||'')}</div>
   <div class="kv"><div><small>Entry</small><b>${fmt(p.entry)}</b></div><div><small>Stop</small><b>${fmt(p.stop)}</b></div><div><small>Target</small><b>${fmt(p.target)}</b></div><div><small>R:R</small><b>${p.riskReward?Number(p.riskReward).toFixed(2):'—'}</b></div></div>
   <div class="analysis-grid" style="margin-top:12px">
    ${list('Technical',a.technical)}
    <div class="analysis-box"><h3>Price action</h3><p>Structure: <b>${esc(pa.structure||'—')}</b></p><p>Patterns: ${esc((pa.patterns||[]).join(', ')||'none')}</p><p>Bias: ${pa.bias==null?'—':Number(pa.bias).toFixed(2)}</p></div>
    <div class="analysis-box"><h3>Fundamentals</h3><p>Combined bias: <b>${fund.bias==null?'—':Number(fund.bias).toFixed(2)}</b></p><p>Macro: ${a.macro?.bias==null?'—':Number(a.macro.bias).toFixed(2)}</p><p>News: ${n.sentiment==null?'—':Number(n.sentiment).toFixed(2)}</p><p>Event surprise: ${fund.eventBias==null?'—':Number(fund.eventBias).toFixed(2)}</p></div>
    ${list('Confirmations',a.confirmations)}
    ${list('Blockers',a.risks)}
    <div class="analysis-box"><h3>Recent news</h3>${(n.headlines||[]).slice(0,3).map(h=>`<p><b>${esc(h.headline||'')}</b><br><small>${esc(h.provider||'')}</small></p>`).join('')||'<p>No recent headlines.</p>'}</div>
   </div>`,
   '<button onclick="closeModal()">Close</button>');
};

window.openThreshold=()=>{
 const current=Number($('thresholdInput').value||60);
 modal('Strict signal threshold',`
  <p class="muted">This changes qualification for new signals. Historical results keep their original threshold.</p>
  <div class="field"><label>Threshold (%)</label><input id="modalThreshold" type="number" min="50" max="95" value="${current}"></div>
  <div class="field"><label>Admin API key</label><input id="modalAdmin" type="password" autocomplete="off" placeholder="Required to save"></div>`,
  '<button onclick="closeModal()">Cancel</button><button class="primary" onclick="saveThreshold()">Save threshold</button>');
};
window.saveThreshold=async()=>{
 const value=Number($('modalThreshold')?.value),token=$('modalAdmin')?.value||adminToken;
 if(!Number.isFinite(value)||value<50||value>95){toast('Threshold must be between 50% and 95%.');return}
 if(!token){toast('Admin API key is required.');return}
 try{adminToken=token;const s=await post('/api/settings/signal-threshold',{value:value/100},token);renderSettings(s);closeModal();toast('Threshold updated to '+value.toFixed(0)+'%');await load();}
 catch(e){toast(friendly(e))}
};

window.trade=i=>{
 const s=board[i],p=s.tradePlan||{},conf=s.analysis?.confluence?.agreement;
 modal(`Trade ${s.symbol} ${s.timeframe}`,`
   <div class="kv"><div><small>Bias</small><b class="${cls(s.leanDirection)}">${esc(s.leanDirection)}</b></div><div><small>Setup success</small><b>${pct(s.setupProbability)}</b><small>direction ${pct(s.directionalProbability)}</small></div><div><small>Evidence agreement</small><b>${conf??'—'}%</b></div><div><small>Status</small><b>${esc(signalStatusMeta(statusOf(s)).label)}</b><small>${esc(signalStatusMeta(statusOf(s)).detail)}</small></div></div>
   <div class="notice">${statusOf(s)==='STRICT'?'Strict gates passed.':'Manual demo execution is allowed, but this setup has not passed all strict gates.'}</div>
   <div class="kv"><div><small>Entry</small><b>${fmt(p.entry)}</b></div><div><small>SL</small><b>${fmt(p.stop)}</b></div><div><small>TP</small><b>${fmt(p.target)}</b></div><div><small>R:R</small><b>${p.riskReward?Number(p.riskReward).toFixed(2):'—'}</b></div></div>
   <div class="field"><label>Admin API key</label><input id="tradeAdmin" type="password" autocomplete="off" value="${esc(adminToken)}" placeholder="Required for broker preview"></div>`,
   '<button onclick="closeModal()">Cancel</button><button class="primary" onclick="previewTrade('+i+')">Preview on XM</button>');
};
window.previewTrade=async i=>{
 const token=$('tradeAdmin')?.value||adminToken;if(!token){toast('Admin API key is required.');return}
 adminToken=token;const s=board[i];
 try{
  $('modalActions').innerHTML='<button disabled>Checking XM…</button>';
  const created=await post('/api/execution/manual',{symbol:s.symbol,timeframe:s.timeframe,side:s.leanDirection},token);
  if(!created.broker?.configured)throw new Error('MT5 bridge is not configured');
  const preview=await post('/api/broker/manual-preview/'+created.intent.id,{},token);
  const mode=created.broker.mode||'demo';
  modal('XM order preview',`
    <div class="notice">${preview.adjusted?'XM adjusted the pending entry to a broker-safe distance.':'XM validated the planned entry.'} No order has been sent yet.</div>
    <div class="kv">
      <div><small>Broker symbol</small><b>${esc(preview.brokerSymbol||s.symbol)}</b></div>
      <div><small>Order type</small><b>${esc(preview.orderType||s.leanDirection)}</b></div>
      <div><small>Entry</small><b>${fmt(preview.entry)}</b></div>
      <div><small>SL / TP</small><b>${fmt(preview.stop)} / ${fmt(preview.target)}</b></div>
      <div><small>Volume</small><b>${num(preview.volumeLots)} lots</b></div>
      <div><small>Risk cash</small><b>${preview.riskCash==null?'—':Number(preview.riskCash).toFixed(2)}</b></div>
      <div><small>Bid / Ask</small><b>${fmt(preview.bid)} / ${fmt(preview.ask)}</b></div>
      <div><small>Mode</small><b>${esc(String(mode).toUpperCase())}</b></div>
    </div>`,
    '<button onclick="closeModal()">Cancel</button><button class="primary" onclick="sendTrade('+created.intent.id+',\''+mode+'\')">Send '+String(mode).toUpperCase()+' order</button>');
 }catch(e){modal('Trade preview failed','<div class="notice">'+esc(friendly(e))+'</div>','<button onclick="closeModal()">Close</button>')}
};
window.sendTrade=async(id,mode)=>{
 try{
  $('modalActions').innerHTML='<button disabled>Sending…</button>';
  const sent=await post('/api/broker/manual-dispatch/'+id,{confirm:mode==='live'?'CONFIRM_LIVE_TRADE':undefined});
  modal('Order sent',`<div class="notice">XM accepted the ${esc(String(sent.mode).toUpperCase())} order.</div><div class="kv"><div><small>Broker ticket</small><b>${esc(sent.brokerOrderId||'accepted')}</b></div><div><small>Mode</small><b>${esc(String(sent.mode).toUpperCase())}</b></div></div>`,'<button class="primary" onclick="closeModal()">Done</button>');
 }catch(e){modal('Order not sent','<div class="notice">'+esc(friendly(e))+'</div>','<button onclick="closeModal()">Close</button>')}
};

function renderSeries(m){const rows=Object.entries(m.bySeries||{}).sort((a,b)=>a[0].localeCompare(b[0]));$('seriesAccuracy').innerHTML=rows.map(([k,v])=>{const [symbol,tf]=k.split(':');return `<tr><td><b>${esc(symbol)}</b></td><td>${esc(tf)}</td><td>${v.pendingEntry}<small>waiting for entry</small></td><td>${v.active}<small>entry triggered</small></td><td>${v.settled}<small>finished</small></td><td>${v.wins}</td><td>${pct(v.accuracy)}</td><td>${v.averageR==null?'—':Number(v.averageR).toFixed(2)}</td></tr>`}).join('')||'<tr><td colspan="8">No strict setups yet.</td></tr>'}
function renderEdge(e){const out=(e.series||[]).map(s=>({symbol:s.symbol,timeframe:s.timeframe,approved:s.approved,direction:s.setupBacktest,setup:s.setupProbability}));$('edgeDiagnostics').innerHTML=out.map(x=>`<tr><td><b>${esc(x.symbol)}</b></td><td>${esc(x.timeframe)}</td><td>${pct(x.setup?.threshold)}</td><td>${x.setup?.testSamples||0}</td><td>${pct(x.setup?.accuracy)}</td><td>${x.setup?.selected||0}</td><td>${pct(x.setup?.selectedAccuracy)}</td><td>${x.setup?.averageR==null?'—':Number(x.setup.averageR).toFixed(2)}</td></tr>`).join('')}
function renderBrokerActivity(rows){$('brokerActivity').innerHTML=(rows||[]).filter(r=>r.broker_order_id||String(r.status||'').startsWith('DEMO_')).map(r=>`<tr><td>${new Date(r.created_at).toLocaleString()}</td><td><b>${esc(r.symbol)}</b><small>${esc(r.timeframe)}</small></td><td>${r.manual?'MANUAL':'AUTO'}<small>${esc(String(r.mode||'').toUpperCase())}</small></td><td class="${cls(r.side)}">${esc(r.side)}<small>${pct(r.probability)} · conf ${r.confluence==null?'—':Number(r.confluence).toFixed(0)+'%'}</small></td><td>${esc(r.broker_order_id||'—')}</td><td><span class="pill neutral">${esc(r.broker_status||r.status||'—')}</span></td><td>${r.broker_fill_price==null?'—':fmt(r.broker_fill_price)}<small>${r.broker_close_price==null?'':'close '+fmt(r.broker_close_price)}</small></td><td>${r.broker_profit==null?'—':Number(r.broker_profit).toFixed(2)}</td></tr>`).join('')||'<tr><td colspan="8">No broker executions recorded yet.</td></tr>'}
function renderHistory(rows){$('signalHistory').innerHTML=rows.map(r=>{const st=lifecycleMeta(r.status),out=outcomeMeta(r.outcome),scope=r.actionable===1?'Approved trade':'Research only',tracking=brokerTrackingMeta(executionForSignal(r)),shadowState=r.shadow_status?lifecycleMeta(r.shadow_status):null,shadowOut=r.shadow_outcome?outcomeMeta(r.shadow_outcome):null;return `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td><b>${esc(r.symbol)}</b><small>${esc(r.timeframe)} · ${scope} · ${esc(r.model_version||'legacy')}</small></td><td class="${cls(r.lean_direction)}">${esc(r.lean_direction||r.candidate_direction)}</td><td>${pct(r.setup_probability)}<small>dir ${pct(r.directional_probability)}</small></td><td>${fmt(r.entry_price)}</td><td>${stateHtml(st,r.status==='SETTLED'?'good':'neutral')}${r.status==='PENDING_ENTRY'||r.status==='ACTIVE'?stateHtml(tracking,tracking.css):''}${r.status==='FILTERED'&&shadowState?'<small>Shadow: '+esc(shadowState.label)+'</small>':''}</td><td>${r.outcome?stateHtml(out,r.success===1?'good':r.status==='EXPIRED'?'neutral':'bad'):shadowOut?stateHtml({label:'Shadow — '+shadowOut.label,detail:shadowOut.detail},r.shadow_success===1?'good':r.shadow_status==='EXPIRED'?'neutral':'bad'):'—'}</td><td>${r.outcome_pips!=null?Number(r.outcome_pips).toFixed(1)+' '+esc(r.unit_label||''):(r.shadow_outcome_pips!=null?Number(r.shadow_outcome_pips).toFixed(1)+' '+esc(r.unit_label||''):'—')}<small>${r.realized_r!=null?Number(r.realized_r).toFixed(2)+'R':r.shadow_realized_r!=null?'shadow '+Number(r.shadow_realized_r).toFixed(2)+'R':''}</small></td></tr>`}).join('')||'<tr><td colspan="8">No monitored history yet.</td></tr>'}

window.load=async()=>{
 try{
  const [m,b,h,e,s,broker,x]=await Promise.all([get('/api/signals/metrics'),get('/api/signals/board'),get('/api/signals/history?limit=200'),get('/api/research/edge'),get('/api/settings'),get('/api/broker/status'),get('/api/execution/intents?limit=100')]);
  executionIntents=x||[];renderAccuracy(m);renderBoard(b);renderHistory(h);renderEdge(e);renderSeries(m);renderSettings(s);renderBroker(broker);renderBrokerActivity(x);
 }catch(e){toast(friendly(e))}
};
load();setInterval(load,60000);
