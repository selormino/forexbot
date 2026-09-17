const axios = require('axios');

const SYMBOLS = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','XAUUSD','XAGUSD','WTI'];
const BASE = {EURUSD:1.171,GBPUSD:1.352,USDJPY:147.8,AUDUSD:0.665,USDCAD:1.381,XAUUSD:3665,XAGUSD:42.1,WTI:64.2};

function demoCandles(symbol, count=250){
  const base=BASE[symbol]||1; let p=base; const out=[]; let seed=symbol.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  for(let i=count;i>0;i--){ seed=(seed*9301+49297)%233280; const noise=(seed/233280-.5)*0.006; const open=p; const close=Math.max(0.0001,p*(1+noise)); const high=Math.max(open,close)*(1+Math.abs(noise)*0.8); const low=Math.min(open,close)*(1-Math.abs(noise)*0.8); out.push({time:Date.now()-i*3600000,open,high,low,close,volume:1000+Math.floor((seed/233280)*9000)}); p=close; }
  return out;
}

async function candles(symbol, interval='1h', outputsize=250){
  if(process.env.MARKET_PROVIDER==='twelvedata' && process.env.TWELVE_DATA_API_KEY){
    const r=await axios.get('https://api.twelvedata.com/time_series',{params:{symbol,interval,outputsize,apikey:process.env.TWELVE_DATA_API_KEY,format:'JSON'}});
    if(r.data?.values) return r.data.values.reverse().map(x=>({time:new Date(x.datetime).getTime(),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0)}));
  }
  return demoCandles(symbol,outputsize);
}

async function news(symbol){
  if(process.env.FINNHUB_API_KEY){
    const r=await axios.get('https://finnhub.io/api/v1/company-news',{params:{symbol,from:new Date(Date.now()-3*864e5).toISOString().slice(0,10),to:new Date().toISOString().slice(0,10),token:process.env.FINNHUB_API_KEY}});
    return (r.data||[]).slice(0,30).map(n=>({headline:n.headline,summary:n.summary,url:n.url,source:n.source,time:n.datetime*1000,sentiment:0}));
  }
  return [
    {headline:`Macro watch: ${symbol} reacts to rates, yields and risk sentiment`,summary:'Demo headline. Connect FINNHUB_API_KEY for live news.',source:'ForexBot demo',time:Date.now(),sentiment:0},
    {headline:'Central-bank expectations remain a key volatility driver',summary:'Demo headline for development mode.',source:'ForexBot demo',time:Date.now()-3600000,sentiment:0}
  ];
}

async function calendar(){
  if(process.env.FINNHUB_API_KEY){
    const r=await axios.get('https://finnhub.io/api/v1/calendar/economic',{params:{from:new Date().toISOString().slice(0,10),to:new Date(Date.now()+7*864e5).toISOString().slice(0,10),token:process.env.FINNHUB_API_KEY}});
    return (r.data?.economicCalendar||[]).map(e=>({event:e.event,country:e.country,currency:e.currency,time:e.time,impact:e.impact||'medium',actual:e.actual,estimate:e.estimate,previous:e.prev}));
  }
  return [
    {event:'US Initial Jobless Claims',country:'United States',currency:'USD',time:new Date(Date.now()+18*3600000).toISOString(),impact:'high',estimate:'—',previous:'—'},
    {event:'BoE Interest Rate Decision',country:'United Kingdom',currency:'GBP',time:new Date(Date.now()+24*3600000).toISOString(),impact:'high',estimate:'—',previous:'—'},
    {event:'Euro Area CPI',country:'Euro Area',currency:'EUR',time:new Date(Date.now()+48*3600000).toISOString(),impact:'high',estimate:'—',previous:'—'}
  ];
}
module.exports={SYMBOLS,candles,news,calendar};
