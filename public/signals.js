const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let board=[],settings=null,adminToken='';

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

function modal(title,body,actions=''){ $('modalTitle').textContent=title;$('modalBody').innerHTML=body;$('modalActions').innerHTML=actions;$('modalBackdrop').classList.add('open');}
window.closeModal=()=>$('modalBackdrop').classList.remove('open');
window.backdropClose=e=>{if(e.target===$('modalBackdrop'))closeModal()};
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2800)}

function renderAccuracy(m){
 const strict=m.strict||m.actionable,research=m.researchCandidates||m.qualified;
 $('accuracyCards').innerHTML=`
 <div class="card metric"><span class="label">Approved-trade accuracy</span><div class="big">${pct(strict.accuracy)}</div><span class="muted">${strict.wins} wins · ${strict.settled} finished approved setups</span></div>
 <div class="card metric"><span class="label">Approved setups open</span><div class="big compact">${strict.pendingEntry+strict.active} open</div><span class="muted">${strict.pendingEntry} waiting for entry · ${strict.active} entry triggered</span></div>
 <div class="card metric"><span class="label">Research validation</span><div class="big compact">${m.readyForBrokerValidation?'READY':'RESEARCH'}</div><span class="muted">Target ${pct(m.targetAccuracy)} · research-only: ${research.settled} finished / ${research.wins} wins</span></div>`;
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
   <td>${stateHtml(signalStatusMeta(status),status==='STRICT'?'good':'neutral')}<small>${esc((s.filters||[])[0]||'All gates passed')}</small></td>
   <td><div class="action-stack"><button class="small-btn" onclick="explain(${i})">Details</button><button class="small-btn primary" onclick="trade(${i})">Trade</button></div></td>
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
function renderHistory(rows){$('signalHistory').innerHTML=rows.map(r=>{const st=lifecycleMeta(r.status),out=outcomeMeta(r.outcome),scope=r.actionable===1?'Approved trade':'Research only';return `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td><b>${esc(r.symbol)}</b><small>${esc(r.timeframe)} · ${scope}</small></td><td class="${cls(r.lean_direction)}">${esc(r.lean_direction||r.candidate_direction)}</td><td>${pct(r.setup_probability)}<small>dir ${pct(r.directional_probability)}</small></td><td>${fmt(r.entry_price)}</td><td>${stateHtml(st,r.status==='SETTLED'?'good':'neutral')}</td><td>${r.outcome?stateHtml(out,r.success===1?'good':r.status==='EXPIRED'?'neutral':'bad'):'—'}</td><td>${r.outcome_pips==null?'—':Number(r.outcome_pips).toFixed(1)+' '+esc(r.unit_label||'')}<small>${r.realized_r==null?'':Number(r.realized_r).toFixed(2)+'R'}</small></td></tr>`}).join('')||'<tr><td colspan="8">No monitored history yet.</td></tr>'}

window.load=async()=>{
 try{
  const [m,b,h,e,s,broker,x]=await Promise.all([get('/api/signals/metrics'),get('/api/signals/board'),get('/api/signals/history?limit=200'),get('/api/research/edge'),get('/api/settings'),get('/api/broker/status'),get('/api/execution/intents?limit=100')]);
  renderAccuracy(m);renderBoard(b);renderHistory(h);renderEdge(e);renderSeries(m);renderSettings(s);renderBroker(broker);renderBrokerActivity(x);
 }catch(e){toast(friendly(e))}
};
load();setInterval(load,60000);
