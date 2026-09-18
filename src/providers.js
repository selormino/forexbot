const axios = require('axios');

const SYMBOLS = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','XAUUSD','XAGUSD','WTI'];
const BASE = {EURUSD:1.171,GBPUSD:1.352,USDJPY:147.8,AUDUSD:0.665,USDCAD:1.381,XAUUSD:3665,XAGUSD:42.1,WTI:64.2};
const YAHOO_SYMBOLS = {EURUSD:'EURUSD=X',GBPUSD:'GBPUSD=X',USDJPY:'USDJPY=X',AUDUSD:'AUDUSD=X',USDCAD:'USDCAD=X',XAUUSD:'GC=F',XAGUSD:'SI=F',WTI:'CL=F'};
const TD_SYMBOLS = {EURUSD:'EUR/USD',GBPUSD:'GBP/USD',USDJPY:'USD/JPY',AUDUSD:'AUD/USD',USDCAD:'USD/CAD',XAUUSD:'XAU/USD',XAGUSD:'XAG/USD',WTI:'WTI/USD'};
const cache = new Map();
const TTL = Math.max(15, Number(process.env.DATA_REFRESH_SECONDS || 120)) * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cached(key){
  const x=cache.get(key);
  return x && Date.now()-x.at<TTL ? x.value : null;
}
function put(key,value){ cache.set(key,{at:Date.now(),value}); return value; }

function demoCandles(symbol, count=250){
  const base=BASE[symbol]||1; let p=base; const out=[]; let seed=symbol.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  for(let i=count;i>0;i--){ seed=(seed*9301+49297)%233280; const noise=(seed/233280-.5)*0.006; const open=p; const close=Math.max(0.0001,p*(1+noise)); const high=Math.max(open,close)*(1+Math.abs(noise)*0.8); const low=Math.min(open,close)*(1-Math.abs(noise)*0.8); out.push({time:Date.now()-i*3600000,open,high,low,close,volume:1000+Math.floor((seed/233280)*9000)}); p=close; }
  return out;
}

function intervalToYahoo(interval){
  const map={'1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','1d':'1d','1wk':'1wk','1mo':'1mo'};
  return map[interval]||'1h';
}
function yahooRange(interval, outputsize){
  if(interval==='1d') return outputsize>1000?'5y':outputsize>500?'2y':'1y';
  if(interval==='1wk') return outputsize>260?'10y':'5y';
  if(interval==='1mo') return '10y';
  const days=Math.min(60,Math.max(5,Math.ceil(outputsize/24)+4));
  return `${days}d`;
}

async function yahooChart(symbol, interval='1h', outputsize=250){
  const key=`yahoo:${symbol}:${interval}:${outputsize}`; const hit=cached(key); if(hit) return hit;
  const ticker=YAHOO_SYMBOLS[symbol]||symbol;
  const params={range:yahooRange(interval,outputsize),interval:intervalToYahoo(interval),events:'div,splits'};
  let r;
  try{
    r=await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,{params,headers:{'User-Agent':'Mozilla/5.0'},timeout:12000});
  }catch(first){
    if(![401,403,429].includes(first.response?.status)) throw first;
    const cookieResponse=await axios.get('https://fc.yahoo.com',{headers:{'User-Agent':'Mozilla/5.0'},timeout:12000,validateStatus:s=>s<500});
    const cookies=(cookieResponse.headers['set-cookie']||[]).map(x=>x.split(';')[0]).join('; ');
    const crumbResponse=await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb',{headers:{'User-Agent':'Mozilla/5.0',Cookie:cookies},timeout:12000});
    const crumb=String(crumbResponse.data||'').trim();
    r=await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,{params:{...params,crumb},headers:{'User-Agent':'Mozilla/5.0',Cookie:cookies},timeout:12000});
  }
  const result=r.data?.chart?.result?.[0];
  if(!result) throw new Error(`Yahoo Finance returned no chart data for ${symbol}`);
  const q=result.indicators?.quote?.[0]||{};
  const rows=(result.timestamp||[]).map((ts,i)=>({time:ts*1000,open:q.open?.[i],high:q.high?.[i],low:q.low?.[i],close:q.close?.[i],volume:q.volume?.[i]||0})).filter(x=>[x.open,x.high,x.low,x.close].every(Number.isFinite));
  if(!rows.length) throw new Error(`Yahoo Finance returned no usable candles for ${symbol}`);
  return put(key,rows.slice(-outputsize));
}

async function twelveDataCandles(symbol, interval='1h', outputsize=250, options={}){
  const key=`td:${symbol}:${interval}:${outputsize}:${options.startTime||''}:${options.endTime||''}`; const hit=cached(key); if(hit) return hit;
  const params={symbol:TD_SYMBOLS[symbol]||symbol,interval,outputsize,apikey:process.env.TWELVE_DATA_API_KEY,format:'JSON',timezone:'UTC'};
  if(options.startTime) params.start_date=new Date(options.startTime).toISOString();
  if(options.endTime) params.end_date=new Date(options.endTime).toISOString();
  let r;
  for(let attempt=0;attempt<4;attempt++){
    try{r=await axios.get('https://api.twelvedata.com/time_series',{params,timeout:20000});break;}
    catch(error){
      if(error.response?.status!==429||attempt===3)throw error;
      const retryAfter=Number(error.response?.headers?.['retry-after']||0)*1000;
      await sleep(Math.max(retryAfter,15000*Math.pow(2,attempt)));
    }
  }
  if(r.data?.status==='error' || !Array.isArray(r.data?.values)) throw new Error(r.data?.message||`Twelve Data returned no candles for ${symbol}`);
  return put(key,r.data.values.reverse().map(x=>({time:new Date(x.datetime+'Z').getTime(),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0),provider:'twelvedata'})));
}

async function historicalCandles(symbol, interval='1h', options={}){
  const outputsize=Math.max(1,Math.min(5000,Number(options.outputsize||1500)));
  const provider=(process.env.MARKET_PROVIDER||'auto').toLowerCase();
  if(provider==='demo') return demoCandles(symbol,outputsize).filter(x=>!options.startTime||x.time>=options.startTime).map(x=>({...x,provider:'demo'}));
  if((provider==='twelvedata'||provider==='auto') && process.env.TWELVE_DATA_API_KEY){
    try{return await twelveDataCandles(symbol,interval,outputsize,options);}catch(e){if(provider==='twelvedata')throw e;}
  }
  const rows=interval==='4h'?aggregateCandles(await yahooChart(symbol,'1h',Math.min(5000,outputsize*4)),4):await yahooChart(symbol,interval,outputsize);
  return rows.filter(x=>!options.startTime||x.time>=options.startTime).map(x=>({...x,provider:'yahoo'}));
}

function aggregateCandles(rows, hours){
  const bucket=hours*3600000,out=[];
  for(const row of rows){
    const ts=Math.floor(row.time/bucket)*bucket;let x=out.at(-1);
    if(!x||x.time!==ts){x={time:ts,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume||0};out.push(x);}
    else{x.high=Math.max(x.high,row.high);x.low=Math.min(x.low,row.low);x.close=row.close;x.volume+=(row.volume||0);}
  }
  return out;
}

async function candles(symbol, interval='1h', outputsize=250){
  const provider=(process.env.MARKET_PROVIDER||'auto').toLowerCase();
  if(provider==='demo') return demoCandles(symbol,outputsize);
  if((provider==='twelvedata'||provider==='auto') && process.env.TWELVE_DATA_API_KEY){
    try{return await twelveDataCandles(symbol,interval,outputsize);}catch(e){ if(provider==='twelvedata') throw e; }
  }
  if(provider==='yahoo' || provider==='auto' || provider==='twelvedata') return yahooChart(symbol,interval,outputsize);
  throw new Error(`Unsupported MARKET_PROVIDER: ${provider}`);
}

function sentimentScore(text=''){
  const s=text.toLowerCase();
  const positive=['beats','beat','strong','growth','hawkish','raises','rise','rises','surge','surges','bullish','optimism','recovery','higher','improves'];
  const negative=['misses','miss','weak','dovish','cuts','cut','fall','falls','drop','drops','bearish','recession','lower','worsens','crisis'];
  let score=0; for(const w of positive) if(s.includes(w)) score+=1; for(const w of negative) if(s.includes(w)) score-=1;
  return Math.max(-1,Math.min(1,score/3));
}

async function finnhubNews(symbol){
  const to=new Date().toISOString().slice(0,10), from=new Date(Date.now()-3*864e5).toISOString().slice(0,10);
  const r=await axios.get('https://finnhub.io/api/v1/company-news',{params:{symbol,from,to,token:process.env.FINNHUB_API_KEY},timeout:12000});
  return (r.data||[]).slice(0,30).map(n=>({headline:n.headline,summary:n.summary,url:n.url,source:n.source,time:n.datetime*1000,sentiment:sentimentScore(`${n.headline} ${n.summary||''}`),provider:'finnhub'}));
}

async function gdeltNews(symbol){
  const terms={EURUSD:'EUR USD euro ECB',GBPUSD:'GBP USD pound Bank of England',USDJPY:'USD JPY yen Bank of Japan',AUDUSD:'AUD USD Australia RBA',USDCAD:'USD CAD Canada Bank of Canada',XAUUSD:'gold XAU USD bullion',XAGUSD:'silver XAG USD',WTI:'WTI crude oil'}[symbol]||symbol;
  const key=`gdelt:${symbol}`; const hit=cached(key); if(hit) return hit;
  const r=await axios.get('https://api.gdeltproject.org/api/v2/doc/doc',{params:{query:`${terms} sourcelang:english`,mode:'artlist',maxrecords:30,format:'json',sort:'datedesc',timespan:'3d'},timeout:15000});
  const articles=r.data?.articles||[];
  const out=articles.map(n=>({headline:n.title,summary:n.seendate?`Published ${n.seendate}`:'',url:n.url,source:n.domain||'GDELT',time:parseGdeltDate(n.seendate),sentiment:sentimentScore(n.title),provider:'gdelt'}));
  return put(key,out);
}
function parseGdeltDate(v){
  if(!v) return Date.now(); const m=String(v).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/); return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]):Date.now();
}

async function news(symbol){
  const provider=(process.env.NEWS_PROVIDER||'auto').toLowerCase();
  if(provider==='demo') return [{headline:`Demo news disabled for ${symbol}`,summary:'Configure FINNHUB_API_KEY or use NEWS_PROVIDER=gdelt.',source:'ForexBot',time:Date.now(),sentiment:0,provider:'demo'}];
  if((provider==='finnhub'||provider==='auto') && process.env.FINNHUB_API_KEY){try{return await finnhubNews(symbol);}catch(e){if(provider==='finnhub')throw e;}}
  if(provider==='gdelt'||provider==='auto'||provider==='finnhub') return gdeltNews(symbol);
  throw new Error(`Unsupported NEWS_PROVIDER: ${provider}`);
}

const COUNTRY_CURRENCY={
  USD:'USD',EUR:'EUR',GBP:'GBP',JPY:'JPY',CHF:'CHF',CAD:'CAD',AUD:'AUD',NZD:'NZD',CNY:'CNY',CNH:'CNY',
  'United States':'USD','Euro Area':'EUR','United Kingdom':'GBP','Japan':'JPY','Switzerland':'CHF','Canada':'CAD','Australia':'AUD','New Zealand':'NZD','China':'CNY'
};
async function finnhubCalendar(){
  const r=await axios.get('https://finnhub.io/api/v1/calendar/economic',{params:{from:new Date().toISOString().slice(0,10),to:new Date(Date.now()+7*864e5).toISOString().slice(0,10),token:process.env.FINNHUB_API_KEY},timeout:12000});
  return (r.data?.economicCalendar||[]).map(e=>({event:e.event,country:e.country,currency:e.currency,time:e.time,impact:String(e.impact||'medium').toLowerCase(),actual:e.actual,estimate:e.estimate,previous:e.prev,provider:'finnhub'}));
}
async function forexFactoryCalendar(){
  const key='ff:calendar'; const hit=cached(key); if(hit) return hit;
  const r=await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json',{headers:{'User-Agent':'ForexBot/1.0'},timeout:15000});
  const out=(Array.isArray(r.data)?r.data:[]).map(e=>({event:e.title,country:e.country,currency:e.currency||COUNTRY_CURRENCY[e.country],time:e.date||null,impact:String(e.impact||'medium').toLowerCase(),actual:e.actual,estimate:e.forecast,previous:e.previous,provider:'forexfactory'}));
  return put(key,out);
}
async function calendar(){
  const provider=(process.env.CALENDAR_PROVIDER||'auto').toLowerCase();
  if(provider==='demo') return [];
  if((provider==='finnhub'||provider==='auto') && process.env.FINNHUB_API_KEY){try{return await finnhubCalendar();}catch(e){if(provider==='finnhub')throw e;}}
  if(provider==='forexfactory'||provider==='auto'||provider==='finnhub') return forexFactoryCalendar();
  throw new Error(`Unsupported CALENDAR_PROVIDER: ${provider}`);
}

function providerStatus(){
  return {market:(process.env.MARKET_PROVIDER||'auto'),news:(process.env.NEWS_PROVIDER||'auto'),calendar:(process.env.CALENDAR_PROVIDER||'auto'),twelveDataConfigured:!!process.env.TWELVE_DATA_API_KEY,finnhubConfigured:!!process.env.FINNHUB_API_KEY,fredConfigured:!!process.env.FRED_API_KEY,realData:true};
}
module.exports={SYMBOLS,candles,historicalCandles,news,calendar,providerStatus};
