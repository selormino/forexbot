const axios=require('axios');
const db=require('./db');

function status(){
  return {
    type:'mt5-http',
    configured:!!(process.env.MT5_BRIDGE_URL&&process.env.MT5_BRIDGE_TOKEN),
    mode:String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase(),
    liveDispatchSupported:String(process.env.ALLOW_MANUAL_LIVE||'false')==='true',
    urlConfigured:!!process.env.MT5_BRIDGE_URL
  };
}
async function health(){
  if(!process.env.MT5_BRIDGE_URL)return {...status(),reachable:false,reason:'MT5_BRIDGE_URL not configured'};
  try{
    const r=await axios.get(String(process.env.MT5_BRIDGE_URL).replace(/\/$/,'')+'/health',{headers:{authorization:`Bearer ${process.env.MT5_BRIDGE_TOKEN||''}`},timeout:8000});
    const b=r.data||{};return {...status(),reachable:true,bridge:{ok:b.ok,mode:b.mode,accountConnected:b.accountConnected,server:b.server,currency:b.currency,tradeAllowed:b.tradeAllowed}};
  }catch(e){return {...status(),reachable:false,reason:e.response?.data?.error||e.message};}
}
function payloadForIntent(intent,bridgeMode){
  return {clientOrderId:`forexbot-${intent.id}`,symbol:intent.symbol,timeframe:intent.timeframe,side:intent.side,entry:intent.entry,entryType:'STOP_CONFIRMATION',stop:intent.stop,target:intent.target,riskPct:intent.risk_pct||Number(process.env.RISK_PER_TRADE_PCT||0.5),sizingMode:intent.sizing_mode||'BROKER_RISK_PERCENT',probability:intent.probability,mode:bridgeMode};
}
async function previewManual(id){
  const bridgeMode=String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase();
  if(!process.env.MT5_BRIDGE_URL||!process.env.MT5_BRIDGE_TOKEN)throw new Error('MT5 bridge is not configured');
  const intent=db.prepare('SELECT * FROM execution_intents WHERE id=?').get(id);
  if(!intent)throw new Error('Execution intent not found');
  if(intent.status!=='PENDING')throw new Error('Intent is not pending');
  const r=await axios.post(String(process.env.MT5_BRIDGE_URL).replace(/\/$/,'')+'/preview',payloadForIntent(intent,bridgeMode),{headers:{authorization:`Bearer ${process.env.MT5_BRIDGE_TOKEN}`,'content-type':'application/json'},timeout:12000});
  return {intentId:id,...r.data};
}
async function symbols(query=''){
  if(!process.env.MT5_BRIDGE_URL||!process.env.MT5_BRIDGE_TOKEN)throw new Error('MT5 bridge is not configured');
  const r=await axios.get(String(process.env.MT5_BRIDGE_URL).replace(/\/$/,'')+'/symbols',{params:{q:query},headers:{authorization:`Bearer ${process.env.MT5_BRIDGE_TOKEN}`},timeout:12000});
  return r.data;
}
async function dispatchManual(id,{confirm}={}){
  const bridgeMode=String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase();
  if(!['demo','live'].includes(bridgeMode))throw new Error('Broker bridge mode must be demo or live');
  if(bridgeMode==='live'){
    if(process.env.ALLOW_MANUAL_LIVE!=='true')throw new Error('Manual live trading is disabled');
    if(confirm!=='CONFIRM_LIVE_TRADE')throw new Error('Live trade confirmation phrase is required');
  }
  if(!process.env.MT5_BRIDGE_URL||!process.env.MT5_BRIDGE_TOKEN)throw new Error('MT5 bridge is not configured');
  const intent=db.prepare('SELECT * FROM execution_intents WHERE id=?').get(id);
  if(!intent)throw new Error('Execution intent not found');
  if(intent.status!=='PENDING')throw new Error('Intent is not pending');
  if(!String(intent.reason||'').startsWith('Manual user-selected'))throw new Error('Only explicit manual intents can use this endpoint');
  const payload=payloadForIntent(intent,bridgeMode);
  const r=await axios.post(String(process.env.MT5_BRIDGE_URL).replace(/\/$/,'')+'/orders',payload,{headers:{authorization:`Bearer ${process.env.MT5_BRIDGE_TOKEN}`,'content-type':'application/json',...(bridgeMode==='live'?{'x-live-confirm':'CONFIRM_LIVE_TRADE'}:{})},timeout:12000});
  const brokerId=String(r.data?.orderId||r.data?.ticket||'');
  db.prepare("UPDATE execution_intents SET status=?,broker_order_id=?,reason=?,updated_at=? WHERE id=?")
    .run(bridgeMode==='live'?'LIVE_SENT':'DEMO_SENT',brokerId,`Manual ${bridgeMode} trade sent to configured MT5 bridge`,Date.now(),id);
  return {intentId:id,mode:bridgeMode,brokerOrderId:brokerId,response:r.data};
}
async function dispatchDemo(id){
  if(String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase()!=='demo')throw new Error('Only demo broker dispatch is enabled by this service');
  if(!process.env.MT5_BRIDGE_URL||!process.env.MT5_BRIDGE_TOKEN)throw new Error('MT5 bridge is not configured');
  const intent=db.prepare('SELECT * FROM execution_intents WHERE id=?').get(id);
  if(!intent)throw new Error('Execution intent not found');
  if(!['demo','bridge'].includes(intent.mode))throw new Error('Intent is not broker-bridge eligible');
  if(!['PENDING','APPROVED'].includes(intent.status))throw new Error('Intent is not dispatchable');
  const payload={clientOrderId:`forexbot-${intent.id}`,symbol:intent.symbol,timeframe:intent.timeframe,side:intent.side,entry:intent.entry,stop:intent.stop,target:intent.target,units:intent.units,probability:intent.probability,mode:'demo'};
  const r=await axios.post(String(process.env.MT5_BRIDGE_URL).replace(/\/$/,'')+'/orders',payload,{headers:{authorization:`Bearer ${process.env.MT5_BRIDGE_TOKEN}`,'content-type':'application/json'},timeout:12000});
  const brokerId=String(r.data?.orderId||r.data?.ticket||'');
  db.prepare("UPDATE execution_intents SET status='DEMO_SENT',broker_order_id=?,reason='Sent to configured MT5 demo bridge',updated_at=? WHERE id=?").run(brokerId,Date.now(),id);
  return {intentId:id,brokerOrderId:brokerId,response:r.data};
}
module.exports={status,health,previewManual,symbols,dispatchDemo,dispatchManual};
