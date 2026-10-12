const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function get(u){const r=await fetch(u);const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
const pct=x=>x==null?'—':(Number(x)*100).toFixed(1)+'%';const fmt=x=>x==null?'—':Number(x).toFixed(Math.abs(Number(x))>=100?2:5);const cls=x=>x==='LONG'?'long':x==='SHORT'?'short':'wait';
const signalStatusMeta=code=>({
 STRICT:{label:'Ready — strict setup',detail:'All required signal gates passed.'},
 FILTERED:{label:'Filtered — setup blocked',detail:'A possible setup was found, but one or more quality or safety gates rejected it.'},
 WATCH:{label:'Watching — no setup yet',detail:'The market is being monitored, but there is no qualified entry setup yet.'}
}[String(code||'').toUpperCase()]||{label:String(code||'—').replaceAll('_',' '),detail:''});
function box(title,body){return `<div class="analysis-box"><h3>${esc(title)}</h3>${body}</div>`}
function renderSignal(s){
 const p=s.tradePlan||{},a=s.analysis||{},status=s.direction!=='WAIT'?'STRICT':s.candidateDirection!=='WAIT'?'FILTERED':'WATCH',statusMeta=signalStatusMeta(status),conf=a.confluence?.agreement;
 $('hero').innerHTML=`
  <div class="card metric"><span class="label">${esc(s.symbol)} · ${esc(s.timeframe)}</span><div class="big">${fmt(s.price)}</div><b class="${cls(s.leanDirection)}">${esc(s.leanDirection)} bias</b></div>
  <div class="card metric"><span class="label">Model probability</span><div class="big">${pct(s.directionalProbability)}</div><span class="muted">strict min ${pct(s.minProbability)}</span></div>
  <div class="card metric"><span class="label">Evidence agreement</span><div class="big">${conf==null?'—':conf+'%'}</div><span class="muted">${esc(statusMeta.label)}</span></div>`;
 const fund=a.fundamentals||{},pa=a.priceAction||{};
 $('analysis').innerHTML=
  box('Technical',`<p>Bias <b>${a.technicalBias==null?'—':Number(a.technicalBias).toFixed(2)}</b></p><p>${esc((a.technical||[]).slice(0,3).join(' · '))}</p>`)+
  box('Price action',`<p>Structure <b>${esc(pa.structure||'—')}</b></p><p>${esc((pa.patterns||[]).join(', ')||'No major candle pattern')}</p>`)+
  box('Fundamentals',`<p>Combined bias <b>${fund.bias==null?'—':Number(fund.bias).toFixed(2)}</b></p><p>Macro ${a.macro?.bias==null?'—':Number(a.macro.bias).toFixed(2)} · News ${a.news?.sentiment==null?'—':Number(a.news.sentiment).toFixed(2)}</p>`);
 $('planState').textContent=statusMeta.label;
 $('plan').innerHTML=`<div class="kv"><div><small>Entry</small><b>${fmt(p.entry)}</b></div><div><small>Stop</small><b>${fmt(p.stop)}</b></div><div><small>Target</small><b>${fmt(p.target)}</b></div><div><small>R:R</small><b>${p.riskReward?Number(p.riskReward).toFixed(2):'—'}</b></div></div><div class="notice">${esc(statusMeta.detail)}${(s.filters||[]).length?' '+esc((s.filters||[])[0]):''}</div><a class="btn primary" href="/signals.html">Open signal board</a>`;
 $('updated').textContent=new Date(s.generatedAt).toLocaleTimeString();
}
function renderNews(a){$('news').innerHTML=(a||[]).slice(0,5).map(n=>`<div class="article"><b>${esc(n.headline)}</b><small>${esc(n.source||'')} · ${n.time?new Date(n.time).toLocaleString():''}</small></div>`).join('')||'<p class="muted">No recent news.</p>'}
function renderCalendar(a){$('calendar').innerHTML=(a||[]).slice(0,6).map(e=>`<div class="event"><b>${esc(e.currency||e.country||'')}</b><span>${esc(e.event)}<br><small>${e.time?new Date(e.time).toLocaleString():''}</small></span><span class="pill neutral">${esc(e.impact||'')}</span></div>`).join('')||'<p class="muted">No upcoming events.</p>'}
async function loadHealth(){
 try{
  const [r,h,p,edge]=await Promise.all([get('/api/research/status'),get('/api/history/status'),get('/api/providers'),get('/api/system/edge-status')]);
  const symbol=$('symbol').value,tf=$('timeframe').value,m=r.models.find(x=>x.symbol===symbol&&x.timeframe===tf);
  const modelText=m?`${m.approved?'validated':'research only'} · ${m.samples||0} samples`:'awaiting training';
  $('researchHealth').textContent=`Prediction quality: ${edge.verdict||'UNKNOWN'} · ${symbol} ${tf.toUpperCase()} model: ${modelText} · approved series ${edge.approvedSeries||0}/${edge.totalSeries||0}`;
  $('dataSources').textContent=`Data health: ${edge.dataHealth||'UNKNOWN'} · Stored candles: ${h.totals?.candles||0} · Market: ${p.mt5MarketDataEnabled?'MT5 + '+String(p.market||'').toUpperCase():String(p.market||'').toUpperCase()} · News: ${String(p.news||'').toUpperCase()}`;
 }catch(e){$('researchHealth').textContent='Research status unavailable.'}
}
window.loadSignal=async()=>{
 const symbol=$('symbol').value,tf=$('timeframe').value;
 $('hero').innerHTML='<div class="card">Loading analysis…</div>';
 const [signalResult,calendarResult,newsResult]=await Promise.allSettled([
  get('/api/signal?symbol='+symbol+'&timeframe='+tf),
  get('/api/calendar'),
  get('/api/news?symbol='+symbol)
 ]);
 if(signalResult.status==='fulfilled')renderSignal(signalResult.value);
 else $('hero').innerHTML='<div class="card">Signal analysis unavailable: '+esc(signalResult.reason?.message||'request failed')+'</div>';
 if(calendarResult.status==='fulfilled')renderCalendar(calendarResult.value);
 else $('calendar').innerHTML='<div class="notice">Economic calendar is temporarily unavailable. Strict trade qualification remains protected and will not treat missing calendar data as safe.</div>';
 if(newsResult.status==='fulfilled')renderNews(newsResult.value);
 else $('news').innerHTML='<div class="notice">News feed is temporarily unavailable. The core market analysis can still load while this source recovers.</div>';
 loadHealth();
};
$('symbol').addEventListener('change',loadSignal);$('timeframe').addEventListener('change',loadSignal);loadSignal();
