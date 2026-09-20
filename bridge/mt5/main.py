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

app=FastAPI(title="ForexBot MT5 Bridge",version="1.2.0")

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

def prepare(order:Order,adjust_entry:bool=False):
    account=ensure_mt5()
    side=order.side.upper()
    if side not in ("LONG","SHORT"):
        raise HTTPException(400,"side must be LONG or SHORT")
    broker_symbol=resolve_symbol(order.symbol)
    symbol_info=mt5.symbol_info(broker_symbol)
    tick=mt5.symbol_info_tick(broker_symbol)
    if symbol_info is None or tick is None:
        raise HTTPException(400,"Symbol quote unavailable")
    point=symbol_info.point or (10 ** (-symbol_info.digits))
    broker_min=max(0,float(symbol_info.trade_stops_level or 0)*point)
    spread=max(point,abs(float(tick.ask)-float(tick.bid)))
    safety_gap=max(broker_min+2*point,spread*1.5,10*point)
    original_entry=float(order.entry)
    original_stop=float(order.stop)
    original_target=float(order.target)
    stop_distance=abs(original_entry-original_stop)
    target_distance=abs(original_target-original_entry)
    if side=="LONG" and not(original_stop<original_entry<original_target):
        raise HTTPException(400,"Invalid LONG stop/entry/target ordering")
    if side=="SHORT" and not(original_target<original_entry<original_stop):
        raise HTTPException(400,"Invalid SHORT stop/entry/target ordering")
    entry=original_entry
    adjusted=False
    if side=="LONG":
        required=float(tick.ask)+safety_gap
        if entry<required:
            if not adjust_entry:
                raise HTTPException(409,f"Preview stale: BUY STOP entry {entry} is too close to current ask {tick.ask}. Refresh the preview.")
            entry=required; adjusted=True
        stop=entry-stop_distance; target=entry+target_distance
    else:
        required=float(tick.bid)-safety_gap
        if entry>required:
            if not adjust_entry:
                raise HTTPException(409,f"Preview stale: SELL STOP entry {entry} is too close to current bid {tick.bid}. Refresh the preview.")
            entry=required; adjusted=True
        stop=entry+stop_distance; target=entry-target_distance
    digits=int(symbol_info.digits)
    entry=round(entry,digits);stop=round(stop,digits);target=round(target,digits)
    volume,risk_cash=risk_volume(broker_symbol,side,entry,stop,order.riskPct,account.equity)
    request={
        "action":mt5.TRADE_ACTION_PENDING,
        "symbol":broker_symbol,
        "volume":volume,
        "type":mt5.ORDER_TYPE_BUY_STOP if side=="LONG" else mt5.ORDER_TYPE_SELL_STOP,
        "price":entry,
        "sl":stop,
        "tp":target,
        "deviation":20,
        "magic":MAGIC,
        "comment":order.clientOrderId[:31],
        "type_time":mt5.ORDER_TIME_GTC,
        "type_filling":mt5.ORDER_FILLING_RETURN,
    }
    check=mt5.order_check(request)
    if check is None or check.retcode!=0:
        raise HTTPException(400,f"MT5 order_check failed: {check or mt5.last_error()}")
    return account,broker_symbol,tick,volume,risk_cash,request,check,{"adjusted":adjusted,"originalEntry":original_entry,"entry":entry,"stop":stop,"target":target,"safetyGap":safety_gap,"spread":spread,"brokerMinDistance":broker_min}

@app.get("/health")
def health(authorization:str|None=Header(default=None)):
    auth(authorization)
    info=ensure_mt5()
    terminal=mt5.terminal_info()
    return {"ok":True,"mode":MODE,"accountConnected":True,"server":info.server,"currency":info.currency,"equity":info.equity,"balance":info.balance,"login":info.login,"tradeAllowed":info.trade_allowed,"tradeApiDisabled":getattr(terminal,"tradeapi_disabled",None)}

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
    account,broker_symbol,tick,volume,risk_cash,request,check,plan=prepare(order,adjust_entry=True)
    return {"ok":True,"canonicalSymbol":order.symbol,"brokerSymbol":broker_symbol,"mode":MODE,"accountLogin":account.login,"server":account.server,"equity":account.equity,"bid":tick.bid,"ask":tick.ask,"volumeLots":volume,"riskCash":risk_cash,"entry":plan["entry"],"stop":plan["stop"],"target":plan["target"],"adjusted":plan["adjusted"],"originalEntry":plan["originalEntry"],"safetyGap":plan["safetyGap"],"spread":plan["spread"],"brokerMinDistance":plan["brokerMinDistance"],"orderType":"BUY_STOP" if order.side.upper()=="LONG" else "SELL_STOP","orderCheck":getattr(check,"comment","ok")}

@app.post("/orders")
def orders(order:Order,authorization:str|None=Header(default=None),x_live_confirm:str|None=Header(default=None)):
    auth(authorization)
    if order.mode!=MODE:
        raise HTTPException(400,f"Requested mode {order.mode} does not match bridge mode {MODE}")
    if MODE=="live" and x_live_confirm!="CONFIRM_LIVE_TRADE":
        raise HTTPException(403,"Explicit live confirmation header is required")
    account,broker_symbol,tick,volume,risk_cash,request,check,plan=prepare(order,adjust_entry=False)
    result=mt5.order_send(request)
    if result is None or result.retcode not in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED):
        raise HTTPException(400,f"MT5 order_send failed: {result or mt5.last_error()}")
    return {"accepted":True,"orderId":str(result.order),"dealId":str(result.deal),"canonicalSymbol":order.symbol,"brokerSymbol":broker_symbol,"volumeLots":volume,"riskCash":risk_cash,"mode":MODE}

def _ticket(value:str):
    try:
        return int(value)
    except Exception:
        raise HTTPException(400,"Invalid MT5 ticket")

def _weighted_price(deals):
    total=sum(abs(float(getattr(d,"volume",0) or 0)) for d in deals)
    if total<=0:
        return None
    return sum(float(d.price)*abs(float(getattr(d,"volume",0) or 0)) for d in deals)/total

def _deal_money(deals):
    fields=("profit","swap","commission","fee")
    return sum(sum(float(getattr(d,f,0) or 0) for f in fields) for d in deals)

def _state_name(state):
    mapping={
        getattr(mt5,"ORDER_STATE_STARTED",-100):"STARTED",
        getattr(mt5,"ORDER_STATE_PLACED",-101):"PENDING",
        getattr(mt5,"ORDER_STATE_CANCELED",-102):"CANCELLED",
        getattr(mt5,"ORDER_STATE_PARTIAL",-103):"PARTIAL",
        getattr(mt5,"ORDER_STATE_FILLED",-104):"FILLED",
        getattr(mt5,"ORDER_STATE_REJECTED",-105):"REJECTED",
        getattr(mt5,"ORDER_STATE_EXPIRED",-106):"EXPIRED",
        getattr(mt5,"ORDER_STATE_REQUEST_ADD",-107):"REQUEST_ADD",
        getattr(mt5,"ORDER_STATE_REQUEST_MODIFY",-108):"REQUEST_MODIFY",
        getattr(mt5,"ORDER_STATE_REQUEST_CANCEL",-109):"REQUEST_CANCEL",
    }
    return mapping.get(state,str(state))

@app.get("/orders/{ticket}")
def order_status(ticket:str,authorization:str|None=Header(default=None)):
    auth(authorization)
    ensure_mt5()
    t=_ticket(ticket)
    active=mt5.orders_get(ticket=t) or ()
    if active:
        o=active[0]
        return {"ticket":str(t),"status":"PENDING","state":_state_name(o.state),"symbol":o.symbol,"volume":o.volume_current,"entry":o.price_open,"stop":o.sl,"target":o.tp,"positionId":str(getattr(o,"position_id",0) or "")}

    history=mt5.history_orders_get(ticket=t) or ()
    if not history:
        return {"ticket":str(t),"status":"UNKNOWN"}

    o=history[-1]
    state=_state_name(o.state)
    position_id=int(getattr(o,"position_id",0) or 0)
    if state in ("CANCELLED","EXPIRED","REJECTED"):
        return {"ticket":str(t),"status":state,"state":state,"symbol":o.symbol,"entry":o.price_open,"stop":o.sl,"target":o.tp,"positionId":str(position_id or "")}

    deals=mt5.history_deals_get(position=position_id) if position_id else ()
    deals=deals or ()
    entry_values={getattr(mt5,"DEAL_ENTRY_IN",0),getattr(mt5,"DEAL_ENTRY_INOUT",2)}
    exit_values={getattr(mt5,"DEAL_ENTRY_OUT",1),getattr(mt5,"DEAL_ENTRY_OUT_BY",3)}
    entries=[d for d in deals if getattr(d,"entry",None) in entry_values]
    exits=[d for d in deals if getattr(d,"entry",None) in exit_values]
    positions=mt5.positions_get(symbol=o.symbol) or ()
    open_positions=[p for p in positions if position_id and (int(getattr(p,"identifier",0) or 0)==position_id or int(getattr(p,"ticket",0) or 0)==position_id)]
    fill_price=_weighted_price(entries) or (float(getattr(o,"price_open",0) or 0) or None)

    if open_positions:
        p=open_positions[0]
        return {"ticket":str(t),"status":"OPEN","state":state,"symbol":o.symbol,"positionId":str(position_id),"fillPrice":fill_price,"volume":p.volume,"stop":p.sl,"target":p.tp,"profit":float(getattr(p,"profit",0) or 0)+float(getattr(p,"swap",0) or 0)}

    if exits:
        return {"ticket":str(t),"status":"CLOSED","state":state,"symbol":o.symbol,"positionId":str(position_id or ""),"fillPrice":fill_price,"closePrice":_weighted_price(exits),"profit":_deal_money(deals)}

    return {"ticket":str(t),"status":"FILLED" if state in ("FILLED","PARTIAL") else state,"state":state,"symbol":o.symbol,"positionId":str(position_id or ""),"fillPrice":fill_price,"profit":_deal_money(deals)}

@app.delete("/orders/{ticket}")
def cancel_order(ticket:str,authorization:str|None=Header(default=None),x_live_confirm:str|None=Header(default=None)):
    auth(authorization)
    ensure_mt5()
    if MODE=="live" and x_live_confirm!="CONFIRM_LIVE_TRADE":
        raise HTTPException(403,"Explicit live confirmation header is required")
    t=_ticket(ticket)
    active=mt5.orders_get(ticket=t) or ()
    if not active:
        snapshot=order_status(ticket,authorization)
        return {"ticket":str(t),"cancelled":False,**snapshot}
    request={"action":mt5.TRADE_ACTION_REMOVE,"order":t,"magic":MAGIC,"comment":"forexbot-expiry"}
    result=mt5.order_send(request)
    if result is None or result.retcode!=mt5.TRADE_RETCODE_DONE:
        raise HTTPException(400,f"MT5 cancel failed: {result or mt5.last_error()}")
    return {"ticket":str(t),"cancelled":True,"status":"CANCELLED","retcode":result.retcode}
