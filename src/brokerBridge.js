const axios=require('axios');
const db=require('./db');

function status(){
  return {
    type:'mt5-http',
    configured:!!(process.env.MT5_BRIDGE_URL&&process.env.MT5_BRIDGE_TOKEN),
    mode:String(process.env.BROKER_BRIDGE_MODE||'demo').toLowerCase(),
    liveDispatchSupported:false,
    urlConfigured:!!process.env.MT5_BRIDGE_URL
  };
}
async function health(){
  if(!process.env.MT5_BRIDGE_URL)return {...status(),reachable:false,reason:'MT5_BRIDGE_URL not configured'};
  try{
    const r=await axios.get(String(process.env.MT5_BRIDGE_URL).replace(/\/$/,'')+'/health',{headers:{authorization:`Bearer ${process.env.MT5_BRIDGE_TOKEN||''}`},timeout:8000});
    return {...status(),reachable:true,bridge:r.data};
  }catch(e){return {...status(),reachable:false,reason:e.response?.data?.error||e.message};}
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
module.exports={status,health,dispatchDemo};
