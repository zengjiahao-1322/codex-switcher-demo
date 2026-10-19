'use strict';
const path=require('node:path'),fs=require('node:fs'),cp=require('node:child_process');
const {createAccounts,writeJson}=require('./accounts.cjs');
const {handoff,release,recordEffect}=require('./switch-state.cjs');
function powershell(script,env={}){
 const childEnv={...process.env,...env};delete childEnv.PSModulePath;
 try{return cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';try {"+script+"} catch {[Console]::Error.WriteLine($_.Exception.Message);exit 1}"],{encoding:'utf8',windowsHide:true,env:childEnv,stdio:['ignore','pipe','pipe']}).trim()}
 catch(e){throw Error(String(e.stderr||'').trim()||'桌面端操作失败（PowerShell 退出码 '+e.status+'）。')}
}
function desktopInfo(){
 if(process.platform==='darwin'){
  const inventory=require('./client-status.cjs').scan();
  const running=inventory.ancestry.find(p=>/\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(p.exe||''));if(running)return {exe:running.exe};
  for(const app of require('./platform.cjs').macApps())for(const name of ['Codex','ChatGPT']){const exe=path.join(app,'Contents','MacOS',name);if(fs.existsSync(exe))return {exe}}
  throw Error('未找到 Codex 桌面应用，请先安装并打开 Codex.app。');
 }
 return JSON.parse(powershell("$p=Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object {$_.Path -like '*OpenAI.Codex*'} | Select-Object -First 1; if($p){@{exe=$p.Path} | ConvertTo-Json -Compress}else{$pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1;if(-not $pkg){throw 'ChatGPT desktop not found'};@{exe=(Join-Path $pkg.InstallLocation 'app\\ChatGPT.exe')} | ConvertTo-Json -Compress}"));
}
function stopDesktop(exe,codexHome){
 if(process.platform==='darwin')return stopMacDesktop(exe,codexHome);
 const targetIds=codexHome?require('./client-status.cjs').desktopTargets(exe,codexHome):null;
 powershell(`
 $restricted=$env:SWITCHER_DESKTOP_IDS -ne '*';$allowed=@($env:SWITCHER_DESKTOP_IDS.Split(',') | Where-Object {$_} | ForEach-Object {[int]$_});
 $p=@(Get-Process | Where-Object {$_.Path -eq $env:SWITCHER_DESKTOP_EXE -and (-not $restricted -or $_.Id -in $allowed)});
 $desktopIds=@($p.Id);
 $backendIds=@(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object {$_.ParentProcessId -in $desktopIds} | Select-Object -ExpandProperty ProcessId);
 foreach($item in $p){if($item.MainWindowHandle -ne 0){[void]$item.CloseMainWindow()}};
 Start-Sleep -Seconds 2;
 Get-Process | Where-Object {($_.Path -eq $env:SWITCHER_DESKTOP_EXE -and (-not $restricted -or $_.Id -in $allowed)) -or $_.Id -in $backendIds} | Stop-Process -Force -ErrorAction SilentlyContinue;
 $remaining=@(Get-Process | Where-Object {($_.Path -eq $env:SWITCHER_DESKTOP_EXE -and (-not $restricted -or $_.Id -in $allowed)) -or $_.Id -in $backendIds});
 if($remaining.Count){throw 'Codex 桌面端仍在运行，请关闭桌面端后重试。'}
 `,{SWITCHER_DESKTOP_EXE:exe,SWITCHER_DESKTOP_IDS:targetIds?targetIds.join(','):'*'});
}
function openWindowsDesktop(){powershell("$pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1;Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$pkg.PackageFamilyName+'!App')")}
async function stopMacDesktop(exe,codexHome){
 const status=require('./client-status.cjs'),roots=status.desktopTargets(exe,codexHome),inventory=status.scan(),ids=new Set(roots);
 for(let pass=0;pass<8;pass++)for(const p of inventory.ancestry)if(ids.has(p.parentPid))ids.add(p.pid);
 const signal=(pid,sig)=>{try{process.kill(pid,sig)}catch(e){if(e.code!=='ESRCH')throw e}};
 for(const pid of roots)signal(pid,'SIGTERM');await new Promise(r=>setTimeout(r,1500));
 for(const pid of [...ids].reverse())signal(pid,'SIGKILL');
}
function openDesktop(exe,home){if(process.platform==='darwin'){cp.spawn(exe,[],{env:{...process.env,CODEX_HOME:home},detached:true,stdio:'ignore'}).unref();return}return openWindowsDesktop()}
async function runSwitch(job,{stop=stopDesktop,open=openDesktop,accounts=createAccounts(job)}={}){
 const file=path.join(job.bridgeHome,'account-switch.json');
 const api=job.kind==='api';let prepared,applied=false;
 writeJson(file,{id:job.id,pid:process.pid,status:'preparing',message:api?'正在检测 API 并准备模型列表，桌面端仍在运行…':'正在准备目标账号登录，桌面端仍在运行…'});
 try{
  if(api)prepared=await require('./service.cjs').createService(job).prepareApi(job);else await accounts.prepare(job.id);
  writeJson(file,{id:job.id,pid:process.pid,status:'switching',message:'准备完成，正在关闭桌面端并应用配置…'});
  await stop(job.desktopExe,job.codexHome);
  const result=api?(accounts.captureCurrent(),prepared.apply()):accounts.apply(job.id,job.model,job.catalog);applied=true;
  recordEffect(job.codexHome,job.bridgeHome,'restart_required','配置已应用，桌面端尚未重新打开。');
  writeJson(file,{id:job.id,pid:process.pid,status:'reopening',message:'配置已应用，正在请求重新打开桌面端…'});
  await open(job.desktopExe,job.codexHome);
  let editorNote='';
  if(job.reloadEditors!==false){try{const reloaded=require('./client-status.cjs').requestReload(job.codexHome,job.bridgeHome);if(reloaded.count)editorNote=' '+reloaded.message}catch{editorNote=' 编辑器重载请求未发送，可在客户端列表重试。'}}
  recordEffect(job.codexHome,job.bridgeHome,'reopen_requested','配置已应用，已请求重新打开桌面端；请在新会话中确认账号与模型。'+editorNote+' CLI 与未接入伴随扩展的编辑器需自行重新启动。');
  writeJson(file,{id:job.id,status:'done',message:'已应用 '+(api?prepared.label+' · '+job.model:result.label+' 的官方配置')+'，并请求重新打开桌面端。'+editorNote+(api&&!result.catalogCount?' 未生成模型目录，下拉可能仍显示官方列表；实际使用所选模型。':'')});return result
 }
 catch(e){writeJson(file,{id:job.id,status:'error',message:(applied?'配置已应用，但重新打开失败：':'切换未完成：')+e.message});throw e}
 finally{prepared?.cleanup();release(job.bridgeHome)}
}
function scheduleSwitch(job){
 const {exe}=desktopInfo();job={...job,desktopExe:exe};
 const file=path.join(job.bridgeHome,'account-switch-job.json');writeJson(file,job);
 const worker=cp.spawn(process.execPath,[__filename,file],{detached:true,stdio:'ignore',windowsHide:true});worker.unref();
 handoff(job.bridgeHome,worker.pid);
 writeJson(path.join(job.bridgeHome,'account-switch.json'),{id:job.id,pid:worker.pid,status:'queued',message:'即将准备目标来源并重启 Codex 桌面端…'});
 return {message:'正在准备切换并重启 Codex 桌面端，准备失败时不会关闭桌面端。'};
}
if(require.main===module){const job=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));setTimeout(()=>runSwitch(job).catch(()=>{process.exitCode=1}),1500)}
module.exports={scheduleSwitch,runSwitch,desktopInfo,stopDesktop,powershell};
