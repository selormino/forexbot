import os, math, json, re
from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field
from dotenv import load_dotenv
import MetaTrader5 as mt5

load_dotenv()
TOKEN=os.getenv("BRIDGE_TOKEN","")
MODE=os.getenv("BRIDGE_MODE","demo").lower()
ALLOW_LIVE=os.getenv("ALLOW_LIVE","false").lower()=="true"
TERMINAL_PATH=os.getenv("MT5_TERMINAL_PATH") or None
MT5_LOGIN=os.getenv("MT5_LOGIN")
MT5_PASSWORD=os.getenv("MT5_PASSWORD")
MT5_SERVER=os.getenv("MT5_SERVER")
MAGIC=int(os.getenv("MT5_MAGIC","260919"))
try:
    SYMBOL_MAP=json.loads(os.getenv("MT5_SYMBOL_MAP","{}"))
except Exception:
    SYMBOL_MAP={}

app=FastAPI(title="ForexBot MT5 Bridge",version="1.1.0")

class Order(BaseModel):
    clientOrderId:str
    symbol:str
    side:str
    entry:float
    entryType:str="STOP_CONFIRMATION"
    stop:float
    target:float
    riskPct:float=Field(gt=0,le=2)
    sizingMode:str="BROKER_RISK_PERCENT"
    probability:float|None=None
    mode:str="demo"

def auth(authorization:str|None):
    if not TOKEN:
        raise HTTPException(503,"BRIDGE_TOKEN is not configured")
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(401,"Invalid bridge token")

def init_mt5():
    kwargs={}
    if MT5_LOGIN:
        try: kwargs["login"]=int(MT5_LOGIN)
        except ValueError: raise HTTPException(500,"MT5_LOGIN must be numeric")
    if MT5_PASSWORD: kwargs["password"]=MT5_PASSWORD
    if MT5_SERVER: kwargs["server"]=MT5_SERVER
    ok=mt5.initialize(TERMINAL_PATH,**kwargs) if TERMINAL_PATH else mt5.initialize(**kwargs)
    if not ok:
        raise HTTPException(503,f"MT5 initialize/login failed: {mt5.last_error()}")

def ensure_mt5():
    init_mt5()
    info=mt5.account_info()
    if info is None:
        raise HTTPException(503,"No logged-in MT5 account")
    if MODE=="demo" and info.trade_mode!=mt5.ACCOUNT_TRADE_MODE_DEMO:
        raise HTTPException(403,"Bridge is in demo mode but MT5 account is not demo")
    if MODE=="live" and not ALLOW_LIVE:
        raise HTTPException(403,"Live bridge mode is disabled")
    return info

def normalized(name:str):
    return re.sub(r"[^A-Z0-9]","",name.upper())

def resolve_symbol(canonical:str):
    mapped=SYMBOL_MAP.get(canonical,canonical)
    exact=mt5.symbol_info(mapped)
    if exact is not None:
        if not exact.visible: mt5.symbol_select(mapped,True)
        return mapped
    target=normalized(mapped)
    matches=[]
    for s in mt5.symbols_get() or []:
        n=normalized(s.name)
        if n==target or n.startswith(target) or target.startswith(n):
            matches.append(s.name)
    if len(matches)==1:
        mt5.symbol_select(matches[0],True)
        return matches[0]
    if len(matches)>1:
        raise HTTPException(400,f"Multiple MT5 symbols match {canonical}: {matches[:10]}. Set MT5_SYMBOL_MAP explicitly.")
    raise HTTPException(400,f"No MT5 symbol matches {canonical}. Use /symbols to discover the broker symbol and set MT5_SYMBOL_MAP.")

def normalize_volume(info,volume):
    step=info.volume_step or .01
    volume=max(info.volume_min,min(info.volume_max,volume))
    steps=math.floor((volume+1e-12)/step)
    return round(max(info.volume_min,steps*step),8)

def risk_volume(symbol,side,entry,stop,risk_pct,equity):
    info=mt5.symbol_info(symbol)
    if info is None:
        raise HTTPException(400,f"Unknown MT5 symbol {symbol}")
    if not info.visible and not mt5.symbol_select(symbol,True):
        raise HTTPException(400,f"Cannot select symbol {symbol}")
    order_type=mt5.ORDER_TYPE_BUY if side=="LONG" else mt5.ORDER_TYPE_SELL
    loss_one_lot=mt5.order_calc_profit(order_type,symbol,1.0,entry,stop)
    if loss_one_lot is None or loss_one_lot>=0:
        raise HTTPException(400,"Could not calculate stop-loss risk for this symbol")
    risk_cash=equity*(risk_pct/100.0)
    return normalize_volume(info,risk_cash/abs(loss_one_lot)),risk_cash

def prepare(order:Order):
    account=ensure_mt5()
    side=order.side.upper()
    if side not in ("LONG","SHORT"):
        raise HTTPException(400,"side must be LONG or SHORT")
    broker_symbol=resolve_symbol(order.symbol)
    symbol_info=mt5.symbol_info(broker_symbol)
    tick=mt5.symbol_info_tick(broker_symbol)
    if symbol_info is None or tick is None:
        raise HTTPException(400,"Symbol quote unavailable")
    if side=="LONG" and order.entry<=tick.ask:
        raise HTTPException(400,f"BUY STOP entry {order.entry} must be above current ask {tick.ask}; refresh the signal")
    if side=="SHORT" and order.entry>=tick.bid:
        raise HTTPException(400,f"SELL STOP entry {order.entry} must be below current bid {tick.bid}; refresh the signal")
    if side=="LONG" and not(order.stop<order.entry<order.target):
        raise HTTPException(400,"Invalid LONG stop/entry/target ordering")
    if side=="SHORT" and not(order.target<order.entry<order.stop):
        raise HTTPException(400,"Invalid SHORT stop/entry/target ordering")
    volume,risk_cash=risk_volume(broker_symbol,side,order.entry,order.stop,order.riskPct,account.equity)
    request={
        "action":mt5.TRADE_ACTION_PENDING,
        "symbol":broker_symbol,
        "volume":volume,
        "type":mt5.ORDER_TYPE_BUY_STOP if side=="LONG" else mt5.ORDER_TYPE_SELL_STOP,
        "price":order.entry,
        "sl":order.stop,
        "tp":order.target,
        "deviation":20,
        "magic":MAGIC,
        "comment":order.clientOrderId[:31],
        "type_time":mt5.ORDER_TIME_GTC,
        "type_filling":mt5.ORDER_FILLING_RETURN,
    }
    check=mt5.order_check(request)
    if check is None or check.retcode!=0:
        raise HTTPException(400,f"MT5 order_check failed: {check or mt5.last_error()}")
    return account,broker_symbol,tick,volume,risk_cash,request,check

@app.get("/health")
def health(authorization:str|None=Header(default=None)):
    auth(authorization)
    info=ensure_mt5()
    return {"ok":True,"mode":MODE,"accountConnected":True,"server":info.server,"currency":info.currency,"equity":info.equity,"balance":info.balance,"login":info.login,"tradeAllowed":info.trade_allowed}

@app.get("/symbols")
def symbols(q:str=Query(default=""),authorization:str|None=Header(default=None)):
    auth(authorization)
    ensure_mt5()
    term=q.upper().strip()
    rows=[]
    for s in mt5.symbols_get() or []:
        if term and term not in s.name.upper() and term not in (s.description or "").upper(): continue
        rows.append({"name":s.name,"description":s.description,"currencyProfit":s.currency_profit,"digits":s.digits,"volumeMin":s.volume_min,"volumeMax":s.volume_max,"volumeStep":s.volume_step})
        if len(rows)>=100: break
    return {"query":q,"symbols":rows}

@app.post("/preview")
def preview(order:Order,authorization:str|None=Header(default=None)):
    auth(authorization)
    if order.mode!=MODE:
        raise HTTPException(400,f"Requested mode {order.mode} does not match bridge mode {MODE}")
    account,broker_symbol,tick,volume,risk_cash,request,check=prepare(order)
    return {"ok":True,"canonicalSymbol":order.symbol,"brokerSymbol":broker_symbol,"mode":MODE,"accountLogin":account.login,"server":account.server,"equity":account.equity,"bid":tick.bid,"ask":tick.ask,"volumeLots":volume,"riskCash":risk_cash,"entry":order.entry,"stop":order.stop,"target":order.target,"orderType":"BUY_STOP" if order.side.upper()=="LONG" else "SELL_STOP","orderCheck":getattr(check,"comment","ok")}

@app.post("/orders")
def orders(order:Order,authorization:str|None=Header(default=None),x_live_confirm:str|None=Header(default=None)):
    auth(authorization)
    if order.mode!=MODE:
        raise HTTPException(400,f"Requested mode {order.mode} does not match bridge mode {MODE}")
    if MODE=="live" and x_live_confirm!="CONFIRM_LIVE_TRADE":
        raise HTTPException(403,"Explicit live confirmation header is required")
    account,broker_symbol,tick,volume,risk_cash,request,check=prepare(order)
    result=mt5.order_send(request)
    if result is None or result.retcode not in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED):
        raise HTTPException(400,f"MT5 order_send failed: {result or mt5.last_error()}")
    return {"accepted":True,"orderId":str(result.order),"dealId":str(result.deal),"canonicalSymbol":order.symbol,"brokerSymbol":broker_symbol,"volumeLots":volume,"riskCash":risk_cash,"mode":MODE}
