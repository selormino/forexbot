const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..','bridge','mt5');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

test('AWS MT5 autostart installer uses current-user logon task without storing credentials',()=>{
  const installer=read('install-autostart.ps1');
  assert.match(installer,/New-ScheduledTaskAction/);
  assert.match(installer,/New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(installer,/Register-ScheduledTask/);
  assert.match(installer,/New-ScheduledTaskPrincipal/);
  assert.match(installer,/does NOT enable Windows auto-logon/i);
  assert.doesNotMatch(installer,/MT5_PASSWORD\s*=/);
  assert.doesNotMatch(installer,/BRIDGE_TOKEN\s*=/);
});

test('MT5 supervisor starts terminal and supervises uvicorn as a native child process',()=>{
  const runner=read('run-autostart.ps1');
  assert.match(runner,/Start-Process -FilePath \$Terminal/);
  assert.match(runner,/while \(\$true\)/);
  assert.match(runner,/Start-Process -FilePath \$PythonExe/);
  assert.match(runner,/RedirectStandardError \$UvicornStderr/);
  assert.match(runner,/WaitForExit\(\)/);
  assert.match(runner,/Restarting in \$RestartDelaySec seconds/);
  assert.doesNotMatch(runner,/2>&1 \| Tee-Object/);
});

test('autostart verifier checks task, MT5, listener and authenticated bridge health',()=>{
  const verify=read('verify-autostart.ps1');
  assert.match(verify,/schtasks\.exe \/Query/);
  assert.match(verify,/Get-Process -Name "terminal64"/);
  assert.match(verify,/Get-NetTCPConnection -LocalPort \$Port/);
  assert.match(verify,/Invoke-RestMethod/);
  assert.match(verify,/Authorization = "Bearer \$token"/);
});


test('Cloudflare service installer uses a secure token prompt and automatic Windows service',()=>{
  const installer=read('install-cloudflare-service.ps1');
  assert.match(installer,/Read-Host "Tunnel token" -AsSecureString/);
  assert.match(installer,/service install \$plainToken/);
  assert.match(installer,/Set-Service -Name "cloudflared" -StartupType Automatic/);
  assert.match(installer,/Start-Service -Name "cloudflared"/);
  assert.doesNotMatch(installer,/CLOUDFLARE_TUNNEL_TOKEN\s*=/);
});

test('Cloudflare verifier checks service, local bridge, DNS and public authenticated health',()=>{
  const verify=read('verify-cloudflare-service.ps1');
  assert.match(verify,/Get-Service -Name "cloudflared"/);
  assert.match(verify,/Get-NetTCPConnection -LocalPort 8765/);
  assert.match(verify,/Resolve-DnsName \$PublicHostname/);
  assert.match(verify,/https:\/\/.*\/health/);
  assert.match(verify,/Authorization = "Bearer \$token"/);
});

test('Cloudflare uninstall script removes only the Windows connector service',()=>{
  const uninstall=read('uninstall-cloudflare-service.ps1');
  assert.match(uninstall,/service uninstall/);
  assert.match(uninstall,/Cloudflare Windows service removed/);
  assert.match(uninstall,/dashboard tunnel\/DNS configuration was not deleted/i);
});
