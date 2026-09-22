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


## AWS Windows / RDP autostart

The bridge folder includes a safe Windows Scheduled Task installer. It does **not** store the XM password in Task Scheduler; the existing `.env` remains the only place for MT5 credentials.

From an **Administrator PowerShell** opened inside `bridge\mt5`:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -StartNow
```

The installer discovers Python and `terminal64.exe`, validates that `.env` exists, and creates a scheduled task named **ForexBot MT5 Bridge** for the current Windows user. At the next Windows logon the supervisor will:

1. start XM MetaTrader 5 if it is not already running;
2. wait for the MT5 terminal process;
3. start `uvicorn main:app` on `127.0.0.1:8765`;
4. restart the bridge after an unexpected bridge-process exit; and
5. write a local supervisor log to `bridge\mt5\logs\autostart.log`.

If discovery finds the wrong MT5 installation, install with explicit paths:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Mt5Path "C:\Path\To\XM MT5\terminal64.exe" -PythonExe "C:\Path\To\python.exe" -StartNow
```

Verify the task, MT5 process, local port, authenticated bridge health, and recent supervisor log with:

```powershell
powershell -ExecutionPolicy Bypass -File .\verify-autostart.ps1
```

To remove only the scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
```

### Important reboot behavior

MetaTrader 5 is a desktop application. The default task therefore runs **at Windows logon**, not in a non-interactive Windows service session. After an EC2 reboot, log in to the Windows instance once; MT5 and the bridge will then start automatically and continue running if the RDP window is disconnected without signing out.

The scripts intentionally do **not** enable Windows automatic logon or store a Windows password. If completely unattended boot-before-login is ever required, treat that as a separate security decision rather than embedding Windows credentials in these scripts.

If the public bridge URL uses Cloudflare Tunnel, Tailscale, ngrok, or another tunnel/reverse proxy, configure that tunnel independently as a Windows service or startup task. The ForexBot task supervises MT5 + FastAPI only and does not store tunnel tokens in command-line arguments.

## Security
Never commit the real `.env` file. Never paste the XM password into chat, GitHub, browser JavaScript, or Railway. Only the bridge token belongs in Railway; the XM login/password/server stay on the Windows/VPS MT5 host.
