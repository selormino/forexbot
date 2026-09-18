const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function get(u){const r=await fetch(u);const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
const pct=x=>x==null?'—':(x*100).toFixed(1)+'%'; const price=x=>x==null?'—':Number(x).toFixed(Number(x)>100?2:5);
function signalClass(x){return x==='LONG'?'long':x==='SHORT'?'short':'wait'}
function renderAccuracy(m){
 const q=m.qualified,a=m.actionable;
 $('accuracyCards').innerHTML=`<div class="card"><span class="label">Qualified accuracy</span><div class="big">${pct(q.accuracy)}</div><span class="label">${q.wins} wins / ${q.settled} settled</span></div>
 <div class="card"><span class="label">95% confidence range</span><div class="big compact">${q.settled?pct(q.confidence95.lower)+'–'+pct(q.confidence95.upper):'—'}</div><span class="label">statistical uncertainty</span></div>
 <div class="card"><span class="label">Target</span><div class="big">${pct(m.targetAccuracy)}</div><span class="label">minimum observed goal</span></div>
 <div class="card"><span class="label">Broker-validation gate</span><div class="big compact">${m.readyForBrokerValidation?'PASS':'NOT YET'}</div><span class="label">needs ≥50 settled + target accuracy</span></div>`;
}
function renderBoard(rows){
 $('signalBoard').innerHTML=rows.map(s=>{const pa=s.priceAction||{},patterns=(pa.patterns||[]).join(', ')||pa.structure||'neutral';const status=s.direction==='WAIT'?(s.candidateDirection==='WAIT'?'NO SIGNAL':'FILTERED'):'QUALIFIED';
 return `<tr><td><b>${esc(s.symbol)}</b><small>${price(s.price)}</small></td><td>${esc(s.timeframe)}</td><td class="${signalClass(s.candidateDirection)}"><b>${esc(s.candidateDirection)}</b><small>${s.direction!==s.candidateDirection?'execution: '+esc(s.direction):''}</small></td><td><b>${pct(s.directionalProbability)}</b><small>min ${pct(s.minProbability)}</small></td><td>${esc(patterns)}</td><td>${esc(s.regime)}</td><td><span class="pill ${status==='QUALIFIED'?'good':'neutral'}">${status}</span><small>${esc((s.filters||[])[0]||'All gates passed')}</small></td></tr>`}).join('');
 $('boardUpdated').textContent='Updated '+new Date().toLocaleTimeString();
}
function renderHistory(rows){
 $('signalHistory').innerHTML=rows.map(r=>`<tr><td>${new Date(r.created_at).toLocaleString()}</td><td><b>${esc(r.symbol)}</b></td><td>${esc(r.timeframe)}</td><td class="${signalClass(r.candidate_direction)}"><b>${esc(r.candidate_direction)}</b></td><td>${pct(r.directional_probability)}</td><td>${r.actionable?'ACTIONABLE':r.qualified?'TRACKED':'FILTERED'}</td><td><span class="pill ${r.outcome==='WIN'?'good':r.outcome==='LOSS'?'bad':'neutral'}">${esc(r.outcome||r.status)}</span></td><td>${r.net_return==null?'—':pct(r.net_return)}</td></tr>`).join('')||'<tr><td colspan="8">No signal history yet. Monitoring will populate this after scheduled research cycles.</td></tr>';
}
async function load(){try{const [m,b,h]=await Promise.all([get('/api/signals/metrics'),get('/api/signals/board'),get('/api/signals/history?limit=300')]);renderAccuracy(m);renderBoard(b);renderHistory(h);}catch(e){$('signalBoard').innerHTML='<tr><td colspan="7">'+esc(e.message)+'</td></tr>'}}
load();setInterval(load,60000);