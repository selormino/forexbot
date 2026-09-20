const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let board=[];let currentSettings=null;
async function get(u){const r=await fetch(u);const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
async function post(u,body,token){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json','x-admin-token':token||''},body:JSON.stringify(body||{})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
const pct=x=>x==null?'—':(x*100).toFixed(1)+'%';
const fmtPrice=x=>x==null?'—':Number(x).toFixed(Number(x)>100?2:5);
const num=x=>x==null?'—':Number(x).toFixed(1);
const cls=x=>x==='LONG'?'long':x==='SHORT'?'short':'wait';
function renderAccuracy(m){
 const q=m.qualified;
 $('accuracyCards').innerHTML=`<div class="card"><span class="label">Triggered accuracy</span><div class="big">${pct(q.accuracy)}</div><span class="label">${q.wins} wins / ${q.settled} settled</span></div>
 <div class="card"><span class="label">Pending / active</span><div class="big compact">${q.pendingEntry} / ${q.active}</div><span class="label">${q.expired} expired without entry</span></div>
 <div class="card"><span class="label">Average R</span><div class="big">${q.averageR==null?'—':Number(q.averageR).toFixed(2)}</div><span class="label">settled strict setups</span></div>
 <div class="card"><span class="label">Broker-validation gate</span><div class="big compact">${m.readyForBrokerValidation?'PASS':'NOT YET'}</div><span class="label">≥50 settled + ${pct(m.targetAccuracy)} accuracy + confidence gate</span></div>`;
}
function renderSeries(m){
 const rows=Object.entries(m.bySeries||{}).sort((a,b)=>a[0].localeCompare(b[0]));
 $('seriesAccuracy').innerHTML=rows.map(([k,v])=>{const [symbol,tf]=k.split(':');return `<tr><td><b>${esc(symbol)}</b></td><td>${esc(tf)}</td><td>${v.pendingEntry}</td><td>${v.active}</td><td>${v.expired}</td><td>${v.settled}</td><td>${v.wins}</td><td><b>${pct(v.accuracy)}</b></td><td>${v.averageR==null?'—':Number(v.averageR).toFixed(2)}</td><td>${v.settled?pct(v.confidence95.lower)+'–'+pct(v.confidence95.upper):'—'}</td></tr>`}).join('')||'<tr><td colspan="10">No strict setups have qualified yet.</td></tr>';
}
function signalStatus(s){if(s.candidateDirection!=='WAIT'&&s.direction!=='WAIT')return 'STRICT';if(s.candidateDirection!=='WAIT')return 'FILTERED';return 'WATCH';}
function renderBoard(rows){
 board=rows;
 $('signalBoard').innerHTML=rows.map((s,i)=>{const p=s.tradePlan||{},status=signalStatus(s),unit=p.unitLabel||'pips';
 return `<tr><td><b>${esc(s.symbol)}</b><small>spot ${fmtPrice(s.price)}</small></td><td>${esc(s.timeframe)}</td>
 <td class="${cls(s.leanDirection)}"><b>${esc(s.leanDirection||'WAIT')}</b><small>${status==='WATCH'?'below strict threshold':''}</small></td>
 <td><b>${pct(s.directionalProbability)}</b><small>strict min ${pct(s.minProbability)}</small></td>
 <td><b>${fmtPrice(p.entry)}</b><small>${esc(p.entryType||'')}</small></td><td>${fmtPrice(p.stop)}<small>${num(p.stopPips)} ${esc(unit)}</small></td>
 <td>${fmtPrice(p.target)}<small>TP1 ${fmtPrice(p.tp1)}</small></td><td><b>${num(p.targetPips)} ${esc(unit)}</b><small>SL ${num(p.stopPips)} ${esc(unit)}</small></td>
 <td>${p.riskReward?Number(p.riskReward).toFixed(2):'—'}</td><td><span class="pill ${status==='STRICT'?'good':'neutral'}">${status}</span><small>${esc((s.filters||[])[0]||'All strict gates passed')}</small></td>
 <td><button class="small-btn" onclick="showDetail(${i})">Explain</button><button class="small-btn secondary" onclick="manualTrade(${i})">Trade ${esc(s.leanDirection||'')}</button></td></tr>`}).join('');
 $('boardUpdated').textContent='Updated '+new Date().toLocaleTimeString();
}
function lines(title,arr){return `<section><h3>${esc(title)}</h3><ul>${(arr||[]).map(x=>`<li>${esc(x)}</li>`).join('')||'<li>None</li>'}</ul></section>`}
window.showDetail=i=>{const s=board[i],a=s.analysis||{},p=s.tradePlan||{},pa=a.priceAction||{},n=a.news||{},m=a.macro||{};
 $('signalDetail').classList.remove('empty-state');
 $('signalDetail').innerHTML=`<div class="detail-head"><div><span class="label">${esc(s.symbol)} · ${esc(s.timeframe)}</span><h2 class="${cls(s.leanDirection)}">${esc(s.leanDirection)} lean · ${pct(s.directionalProbability)}</h2><p>${esc(a.thesis||'')}</p></div><div class="plan-summary"><b>Entry ${fmtPrice(p.entry)}</b><span>SL ${fmtPrice(p.stop)} · TP1 ${fmtPrice(p.tp1)} · TP2 ${fmtPrice(p.target)}</span><span>${num(p.stopPips)} ${esc(p.unitLabel)} risk · ${num(p.targetPips)} ${esc(p.unitLabel)} target · ${p.riskReward?Number(p.riskReward).toFixed(2):'—'}R</span></div></div>
 <div class="detail-grid">${lines('Technical analysis',a.technical)}
 ${lines('Confirmations',a.confirmations)}
 ${lines('Risks / blockers',a.risks)}
 <section><h3>Price action</h3><p>Structure: <b>${esc(pa.structure||'—')}</b></p><p>Patterns: ${esc((pa.patterns||[]).join(', ')||'none detected')}</p><p>Bias score: ${pa.bias==null?'—':Number(pa.bias).toFixed(2)}</p></section>
 <section><h3>News context</h3><p>${n.available?'Available':'Unavailable'} · ${n.count||0} recent items</p><p>Sentiment: ${n.sentiment==null?'—':Number(n.sentiment).toFixed(2)} (-1 bearish to +1 bullish)</p>${(n.headlines||[]).map(h=>`<p><b>${esc(h.provider||'news')}</b> · ${esc(h.headline||'')}<br><small>${h.time?new Date(h.time).toLocaleString():''} · score ${h.score==null?'—':Number(h.score).toFixed(2)}</small></p>`).join('')}</section>
 <section><h3>Macro context</h3><p>${m.available?'Available':'Unavailable'} · bias ${m.bias==null?'—':Number(m.bias).toFixed(2)}</p><p>Uses Fed funds, CPI, unemployment, real GDP and US 10Y yield context.</p></section>
 <section><h3>Economic calendar</h3>${(a.calendar||[]).map(e=>`<p><b>${esc(e.impact||'')}</b> ${esc(e.currency||'')} · ${esc(e.event||'')}<br><small>${e.time?new Date(e.time).toLocaleString():''} · actual ${esc(e.actual??'—')} · forecast ${esc(e.forecast??'—')} · previous ${esc(e.previous??'—')}</small></p>`).join('')||'<p>No near-term events returned.</p>'}</section></div>`;
};
function renderSettings(s){
 currentSettings=s;
 $('thresholdInput').value=Math.round(Number(s.signalMinProbability||.70)*100);
 $('thresholdSource').textContent=(s.source==='database'?'Custom runtime setting':'Environment default')+' · '+Math.round(Number(s.signalMinProbability||.70)*100)+'%';
}
window.saveThreshold=async()=>{
 const pctValue=Number($('thresholdInput').value);
 if(!Number.isFinite(pctValue)||pctValue<50||pctValue>95){alert('Threshold must be between 50% and 95%.');return;}
 const token=prompt('Admin API token (not saved)')||'';if(!token)return;
 try{
   const s=await post('/api/settings/signal-threshold',{value:pctValue/100},token);
   renderSettings(s);await load();
   alert('Strict probability threshold updated to '+pctValue.toFixed(0)+'%. New signals will use this threshold.');
 }catch(e){alert(e.message)}
};
async function manualTrade(i){
 const s=board[i],p=s.tradePlan||{};if(!s.leanDirection)return;
 if(!confirm(`Prepare a manual ${s.leanDirection} setup for ${s.symbol} ${s.timeframe}?\nEntry ${fmtPrice(p.entry)} | SL ${fmtPrice(p.stop)} | TP ${fmtPrice(p.target)}\nProbability ${pct(s.directionalProbability)}. Current strict threshold: ${pct(s.minProbability)}. Manual execution is allowed below that threshold.`))return;
 const token=prompt('Admin API token (not saved)')||'';if(!token)return;
 try{
   const created=await post('/api/execution/manual',{symbol:s.symbol,timeframe:s.timeframe,side:s.leanDirection},token);
   const broker=created.broker||{};
   if(!broker.configured){alert('Manual intent created (#'+created.intent.id+'). Broker bridge is not configured yet. Configure MT5_BRIDGE_URL and MT5_BRIDGE_TOKEN on Railway, then use the signal again.');return;}
   const mode=broker.mode||'demo';
   const preview=await post('/api/broker/manual-preview/'+created.intent.id,{},token);
   const previewText=`XM/MT5 PREVIEW\nBroker symbol: ${preview.brokerSymbol||s.symbol}\nOrder: ${preview.orderType||s.leanDirection}\n${preview.adjusted?'Broker-safe adjustment: YES\nOriginal entry: '+fmtPrice(preview.originalEntry)+'\n':''}Entry: ${fmtPrice(preview.entry)}\nSL: ${fmtPrice(preview.stop)}\nTP: ${fmtPrice(preview.target)}\nVolume: ${preview.volumeLots} lots\nRisk cash: ${preview.riskCash==null?'—':Number(preview.riskCash).toFixed(2)} ${preview.mode||mode}\nBid/Ask: ${fmtPrice(preview.bid)} / ${fmtPrice(preview.ask)}\n${preview.safetyGap!=null?'Minimum pending-entry gap: '+fmtPrice(preview.safetyGap)+'\n':''}\nNo trade has been placed yet.`;
   if(!confirm(previewText+`\n\nSend manual intent #${created.intent.id} to the configured ${mode.toUpperCase()} broker bridge now?`))return;
   const confirmPhrase=mode==='live'?'CONFIRM_LIVE_TRADE':undefined;
   const sent=await post('/api/broker/manual-dispatch/'+created.intent.id,{confirm:confirmPhrase},token);
   alert(`Trade sent to ${sent.mode} bridge. Broker order: ${sent.brokerOrderId||'accepted'}`);
 }catch(e){alert(e.message)}
}
function renderHistory(rows){
 $('signalHistory').innerHTML=rows.map(r=>{const p=r.plan||{},result=r.outcome_pips==null?'—':Number(r.outcome_pips).toFixed(1)+' '+(r.unit_label||p.unitLabel||'');
 const outcome=r.outcome||r.status;
 return `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td><b>${esc(r.symbol)}</b></td><td>${esc(r.timeframe)}</td><td class="${cls(r.lean_direction)}"><b>${esc(r.lean_direction||r.candidate_direction)}</b></td><td>${pct(r.directional_probability)}</td><td>${fmtPrice(r.entry_price)}<small>${r.entry_triggered_at?'triggered '+new Date(r.entry_triggered_at).toLocaleString():'waiting/unused'}</small></td><td>${fmtPrice(r.stop_price)} / ${fmtPrice(r.target_price)}<small>${num(r.stop_pips)} / ${num(r.target_pips)} ${esc(r.unit_label||'')}</small></td><td><span class="pill neutral">${esc(r.status)}</span></td><td><span class="pill ${r.success===1?'good':r.success===0&&r.status==='SETTLED'?'bad':'neutral'}">${esc(outcome)}</span></td><td>${esc(result)}<small>${r.realized_r==null?'':Number(r.realized_r).toFixed(2)+'R · MFE '+num(r.mfe_pips)+' · MAE '+num(r.mae_pips)}</small></td></tr>`}).join('')||'<tr><td colspan="10">Monitoring history will populate after closed-candle evaluations.</td></tr>';
}
function renderEdge(e){
 const out=[];
 for(const s of e.series||[])for(const x of s.thresholdSweep||[])out.push({...x,symbol:s.symbol,timeframe:s.timeframe});
 $('edgeDiagnostics').innerHTML=out.map(x=>`<tr><td><b>${esc(x.symbol)}</b></td><td>${esc(x.timeframe)}</td><td>${pct(x.threshold)}</td><td>${x.directionalSamples||0}</td><td>${pct(x.directionalAccuracy)}</td><td>${x.setup?.triggered||0}</td><td>${pct(x.setup?.accuracy)}</td><td>${x.setup?.averageR==null?'—':Number(x.setup.averageR).toFixed(2)}</td></tr>`).join('')||'<tr><td colspan="8">Edge diagnostics will populate after the current research version retrains.</td></tr>';
}
async function renderBroker(){
 try{const b=await get('/api/broker/status');$('brokerMode').textContent=(b.mode||'demo').toUpperCase();$('brokerStatus').innerHTML=`<div><span class="label">Configured</span><b>${b.configured?'YES':'NO'}</b></div><div><span class="label">Reachable</span><b>${b.reachable?'YES':'NO'}</b></div><div><span class="label">Manual live gate</span><b>${b.liveDispatchSupported?'ENABLED':'OFF'}</b></div><div><span class="label">Setup</span><b>${b.configured?'MT5 bridge connected':'Set MT5_BRIDGE_URL + MT5_BRIDGE_TOKEN'}</b></div>`;}catch(e){$('brokerStatus').textContent=e.message}
}
async function load(){try{const [m,b,h,e,s]=await Promise.all([get('/api/signals/metrics'),get('/api/signals/board'),get('/api/signals/history?limit=300'),get('/api/research/edge'),get('/api/settings')]);renderAccuracy(m);renderSeries(m);renderBoard(b);renderHistory(h);renderEdge(e);renderSettings(s);renderBroker();}catch(e){$('signalBoard').innerHTML='<tr><td colspan="11">'+esc(e.message)+'</td></tr>'}}
load();setInterval(load,60000);