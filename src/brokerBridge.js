const axios=require('axios');
const db=require('./db');

const base=()=>String(process.env.MT5_BRIDGE_URL||'').replace(/\/$/,'');
const headers=()=>({authorization:`Bearer ${process.env.MT5_BRIDGE_TOKEN||''}`,'content-type':'application/json'});
function status(){
  return {
    type:'mt5-http',
    configured:!!(process.env.MT5_BRIDGE_URL&&process.env.MT5_BRIDGE_TOKEN),
    mode:String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase(),
    liveDispatchSupported:String(process.env.ALLOW_MANUAL_LIVE||'false')==='true',
    autoDemoStrict:process.env.AUTO_DEMO_STRICT==='true',
    urlConfigured:!!process.env.MT5_BRIDGE_URL
  };
}
async function health(){
  if(!process.env.MT5_BRIDGE_URL)return {...status(),reachable:false,reason:'MT5_BRIDGE_URL not configured'};
  try{
    const r=await axios.get(base()+'/health',{headers:headers(),timeout:8000});
    const b=r.data||{};return {...status(),reachable:true,bridge:{ok:b.ok,mode:b.mode,accountConnected:b.accountConnected,server:b.server,currency:b.currency,tradeAllowed:b.tradeAllowed,tradeApiDisabled:b.tradeApiDisabled??null}};
  }catch(e){return {...status(),reachable:false,reason:e.response?.data?.detail||e.response?.data?.error||e.message};}
}
function payloadForIntent(intent,bridgeMode){
  return {clientOrderId:`forexbot-${intent.id}`,symbol:intent.symbol,timeframe:intent.timeframe,side:intent.side,entry:intent.entry,entryType:'STOP_CONFIRMATION',stop:intent.stop,target:intent.target,riskPct:intent.risk_pct||Number(process.env.RISK_PER_TRADE_PCT||0.5),sizingMode:intent.sizing_mode||'BROKER_RISK_PERCENT',probability:intent.probability,mode:bridgeMode};
}
async function previewIntent(id,{manual=false}={}){
  const bridgeMode=String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase();
  if(!process.env.MT5_BRIDGE_URL||!process.env.MT5_BRIDGE_TOKEN)throw new Error('MT5 bridge is not configured');
  const intent=db.prepare('SELECT * FROM execution_intents WHERE id=?').get(id);
  if(!intent)throw new Error('Execution intent not found');
  if(intent.status!=='PENDING')throw new Error('Intent is not pending');
  if(manual&&!intent.manual)throw new Error('Intent is not manual');
  if(!manual&&intent.manual)throw new Error('Automatic preview cannot use a manual intent');
  const r=await axios.post(base()+'/preview',payloadForIntent(intent,bridgeMode),{headers:headers(),timeout:12000});
  const p=r.data||{};
  if(Number.isFinite(Number(p.entry))&&Number.isFinite(Number(p.stop))&&Number.isFinite(Number(p.target))){
    const reason=manual
      ?(p.adjusted?'Manual user-selected signal; broker preview adjusted entry/SL/TP to a safe pending-order distance':'Manual user-selected signal; broker preview validated entry/SL/TP')
      :(p.adjusted?'Automatic STRICT demo signal; broker preview adjusted entry/SL/TP safely':'Automatic STRICT demo signal; broker preview validated entry/SL/TP');
    db.prepare("UPDATE execution_intents SET entry=?,stop=?,target=?,reason=?,updated_at=? WHERE id=?")
      .run(Number(p.entry),Number(p.stop),Number(p.target),reason,Date.now(),id);
  }
  return {intentId:id,...p};
}
const previewManual=id=>previewIntent(id,{manual:true});
const previewAuto=id=>previewIntent(id,{manual:false});

async function symbols(query=''){
  if(!process.env.MT5_BRIDGE_URL||!process.env.MT5_BRIDGE_TOKEN)throw new Error('MT5 bridge is not configured');
  const r=await axios.get(base()+'/symbols',{params:{q:query},headers:headers(),timeout:12000});
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
  if(!intent.manual||!String(intent.reason||'').startsWith('Manual user-selected'))throw new Error('Only explicit manual intents can use this endpoint');
  const payload=payloadForIntent(intent,bridgeMode);
  const r=await axios.post(base()+'/orders',payload,{headers:{...headers(),...(bridgeMode==='live'?{'x-live-confirm':'CONFIRM_LIVE_TRADE'}:{})},timeout:12000});
  const brokerId=String(r.data?.orderId||r.data?.ticket||'');
  db.prepare("UPDATE execution_intents SET status=?,broker_order_id=?,broker_status='PENDING',reason=?,broker_payload_json=?,broker_updated_at=?,updated_at=? WHERE id=?")
    .run(bridgeMode==='live'?'LIVE_SENT':'DEMO_SENT',brokerId,`Manual ${bridgeMode} trade sent to configured MT5 bridge`,JSON.stringify(r.data||{}),Date.now(),Date.now(),id);
  return {intentId:id,mode:bridgeMode,brokerOrderId:brokerId,response:r.data};
}
async function dispatchDemo(id){
  if(String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase()!=='demo')throw new Error('Only demo broker dispatch is enabled by this service');
  if(!process.env.MT5_BRIDGE_URL||!process.env.MT5_BRIDGE_TOKEN)throw new Error('MT5 bridge is not configured');
  const intent=db.prepare('SELECT * FROM execution_intents WHERE id=?').get(id);
  if(!intent)throw new Error('Execution intent not found');
  if(!['demo','bridge'].includes(intent.mode))throw new Error('Intent is not broker-bridge eligible');
  if(!['PENDING','APPROVED'].includes(intent.status))throw new Error('Intent is not dispatchable');
  const payload=payloadForIntent(intent,'demo');
  const r=await axios.post(base()+'/orders',payload,{headers:headers(),timeout:12000});
  const brokerId=String(r.data?.orderId||r.data?.ticket||'');
  db.prepare("UPDATE execution_intents SET status='DEMO_SENT',broker_order_id=?,broker_status='PENDING',reason='Sent to configured MT5 demo bridge',broker_payload_json=?,broker_updated_at=?,updated_at=? WHERE id=?")
    .run(brokerId,JSON.stringify(r.data||{}),Date.now(),Date.now(),id);
  return {intentId:id,brokerOrderId:brokerId,response:r.data};
}
async function previewAndDispatchDemo(id){
  const preview=await previewAuto(id);
  const sent=await dispatchDemo(id);
  return {preview,sent};
}
function mappedIntentStatus(brokerStatus,current){
  const s=String(brokerStatus||'').toUpperCase();
  if(s==='OPEN')return 'DEMO_FILLED';
  if(s==='CLOSED')return 'DEMO_CLOSED';
  if(['CANCELLED','EXPIRED','REJECTED'].includes(s))return 'DEMO_CANCELLED';
  if(s==='PENDING')return 'DEMO_SENT';
  return current;
}
async function cancelOrder(ticket){
  const r=await axios.delete(base()+'/orders/'+encodeURIComponent(ticket),{headers:headers(),timeout:12000});
  return r.data||{};
}
async function reconcileOne(intent){
  if(!intent.broker_order_id)return {id:intent.id,skipped:'No broker ticket'};
  try{
    const r=await axios.get(base()+'/orders/'+encodeURIComponent(intent.broker_order_id),{headers:headers(),timeout:12000});
    let b=r.data||{},cancelledForExpiry=false;
    if(!intent.manual&&String(b.status||'').toUpperCase()==='PENDING'&&intent.source_ts){
      const signal=db.prepare('SELECT status FROM signal_records WHERE symbol=? AND timeframe=? AND source_ts=? ORDER BY id DESC LIMIT 1')
        .get(intent.symbol,intent.timeframe,intent.source_ts);
      if(signal?.status==='EXPIRED'){
        b={...b,...await cancelOrder(intent.broker_order_id),status:'CANCELLED',reason:'Signal expired before broker entry'};
        cancelledForExpiry=true;
      }
    }
    const now=Date.now(),nextStatus=mappedIntentStatus(b.status,intent.status);
    db.prepare(`UPDATE execution_intents SET
      status=?,broker_status=?,broker_fill_price=?,broker_close_price=?,broker_profit=?,broker_position_id=?,
      broker_payload_json=?,broker_updated_at=?,reason=?,updated_at=? WHERE id=?`)
      .run(nextStatus,String(b.status||'UNKNOWN'),Number.isFinite(Number(b.fillPrice))?Number(b.fillPrice):null,
        Number.isFinite(Number(b.closePrice))?Number(b.closePrice):null,Number.isFinite(Number(b.profit))?Number(b.profit):null,
        b.positionId?String(b.positionId):null,JSON.stringify(b),now,
        cancelledForExpiry?'Automatic pending order cancelled because signal expired':intent.reason,now,intent.id);
    return {id:intent.id,ticket:intent.broker_order_id,status:b.status,intentStatus:nextStatus,cancelledForExpiry};
  }catch(e){
    const status=Number(e.response?.status||0),detail=e.response?.data?.detail||e.response?.data?.error||e.message;
    if(status===404){
      const now=Date.now();
      db.prepare(`UPDATE execution_intents SET status='BROKER_NOT_FOUND',broker_status='NOT_FOUND',reason=?,broker_updated_at=?,updated_at=? WHERE id=?`)
        .run('Broker no longer reports this historical ticket; reconciliation stopped for this intent',now,now,intent.id);
      return {id:intent.id,ticket:intent.broker_order_id,status:'NOT_FOUND',intentStatus:'BROKER_NOT_FOUND',terminal:true};
    }
    return {id:intent.id,ticket:intent.broker_order_id,error:detail};
  }
}
async function reconcile(limit=100){
  if(!process.env.MT5_BRIDGE_URL||!process.env.MT5_BRIDGE_TOKEN)return {checked:0,results:[],reason:'MT5 bridge not configured'};
  const rows=db.prepare(`SELECT * FROM execution_intents
    WHERE broker_order_id IS NOT NULL AND broker_order_id<>''
      AND status IN ('DEMO_SENT','DEMO_FILLED','LIVE_SENT')
    ORDER BY updated_at ASC LIMIT ?`).all(Math.max(1,Math.min(500,Number(limit)||100)));
  const results=[];
  for(const row of rows)results.push(await reconcileOne(row));
  return {checked:rows.length,results};
}
module.exports={status,health,previewManual,previewAuto,symbols,dispatchDemo,previewAndDispatchDemo,dispatchManual,reconcile,reconcileOne,cancelOrder};
