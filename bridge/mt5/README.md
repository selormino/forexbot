# ForexBot MT5 Bridge

This bridge runs on a Windows machine or VPS where MetaTrader 5 is installed and already logged in to the Exness, XM, or other MT5 account you want ForexBot to use.

## Purpose
ForexBot on Railway sends an explicit manual order request to this bridge. The bridge:
- authenticates the request with a bearer token;
- verifies demo/live mode;
- uses the actual MT5 symbol contract/tick values to size the order by risk percentage;
- validates entry, SL and TP;
- places a BUY STOP or SELL STOP pending order at the ForexBot confirmation price;
- returns the MT5 ticket to ForexBot.

## Setup
1. Install MetaTrader 5 on a Windows machine/VPS and log in to your broker account.
2. Install Python 3.11+.
3. From this folder run `pip install -r requirements.txt`.
4. Copy `.env.example` values into the Windows environment or your process manager. Use a long random `BRIDGE_TOKEN`.
5. Start with `BRIDGE_MODE=demo` and `ALLOW_LIVE=false`.
6. Run: `uvicorn main:app --host 0.0.0.0 --port 8765`.
7. Put the bridge behind HTTPS (for example Cloudflare Tunnel, Tailscale Funnel, or a reverse proxy). Never expose raw port 8765 directly to the internet.
8. Set Railway variables on ForexBot: `MT5_BRIDGE_URL=https://your-bridge-host` and the matching `MT5_BRIDGE_TOKEN`.
9. Verify `/api/broker/status` in ForexBot shows configured and reachable.

For live manual orders, deliberately change both sides: bridge `BRIDGE_MODE=live` + `ALLOW_LIVE=true`, and ForexBot Railway `BROKER_BRIDGE_MODE=live` + `ALLOW_MANUAL_LIVE=true`. ForexBot still requires an explicit per-order click and confirmation. Autonomous live dispatch is not part of this bridge.

### Symbol names
Some brokers suffix symbols (for example `EURUSDm` or `XAUUSD.a`). If your broker does this, add symbol mapping before live use; do not assume ForexBot's canonical symbol is identical to the broker's MT5 symbol.
