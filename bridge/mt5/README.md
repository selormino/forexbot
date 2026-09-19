# ForexBot MT5 Bridge

This bridge runs on a Windows PC/VPS where XM MetaTrader 5 is installed. Keep the XM account credentials on that machine only. Do not put the MT5 password in the ForexBot browser or Railway.

## XM demo connection
1. Install XM MetaTrader 5 for Windows and confirm you can log into the account manually.
2. Install Python 3.11+ and run `pip install -r requirements.txt` from this folder.
3. Copy `.env.example` to `.env`.
4. Put your XM **demo** account values in `.env`:
   - `MT5_LOGIN` = account number
   - `MT5_PASSWORD` = trading password
   - `MT5_SERVER` = exact XM server shown in MT5
   - keep `BRIDGE_MODE=demo` and `ALLOW_LIVE=false`
   - set a long random `BRIDGE_TOKEN`
5. Start: `uvicorn main:app --host 0.0.0.0 --port 8765`.
6. Test locally with an Authorization bearer token against `GET /health`.
7. Use `GET /symbols?q=BTC` (and EUR, GOLD, ETH, etc.) to see XM's exact symbol names. If XM uses suffixes, set a JSON map such as `MT5_SYMBOL_MAP={"XAUUSD":"GOLD","BTCUSD":"BTCUSD","ETHUSD":"ETHUSD"}`.
8. Put the bridge behind HTTPS (Cloudflare Tunnel, Tailscale Funnel, or a reverse proxy). Do not expose raw port 8765 directly.
9. Set Railway variables `MT5_BRIDGE_URL` and matching `MT5_BRIDGE_TOKEN`.
10. ForexBot will call the bridge's `/preview` endpoint first. The preview validates the pending entry, SL, TP and XM lot size without placing an order. Only after you confirm will `/orders` submit the pending order.

## How manual execution works
ForexBot sends a BUY STOP or SELL STOP at the signal confirmation entry. Position size is calculated by the bridge from actual XM contract/tick values and the selected risk percentage. The browser never calculates broker lots itself.

## Live mode
Do not start with live money. After demo execution is verified end-to-end, live mode requires **both** bridge `BRIDGE_MODE=live` + `ALLOW_LIVE=true` and Railway `BROKER_BRIDGE_MODE=live` + `ALLOW_MANUAL_LIVE=true`. Every live order still requires an explicit click and confirmation.

## Security
Never commit the real `.env` file. Never paste the XM password into chat, GitHub, browser JavaScript, or Railway. Only the bridge token belongs in Railway; the XM login/password/server stay on the Windows/VPS MT5 host.
