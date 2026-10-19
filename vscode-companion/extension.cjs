'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
function post(connection,route,data){return new Promise((resolve,reject)=>{const u=new URL(connection.url);const q=http.request(new URL('/api/'+route,u.origin),{method:'POST',headers:{Authorization:'Bearer '+u.hash.slice(1),'content-type':'application/json'}},r=>{let text='';r.on('data',d=>text+=d);r.on('end',()=>{try{const j=JSON.parse(text);r.statusCode===200?resolve(j):reject(Error(j.error))}catch(e){reject(e)}})});q.setTimeout(3000,()=>q.destroy(Error('switcher unavailable')));q.on('error',reject);q.end(JSON.stringify(data))})}
function activate(context){
 const vscode=require('vscode'),id=crypto.randomUUID();let busy=false,stopped=false;
 const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,20);status.text='$(plug) Codex Switcher';status.command='codexSwitcher.connect';status.tooltip='Connect to the local Codex switcher';status.show();context.subscriptions.push(status);
 const report=()=>{
  const folders=vscode.workspace.workspaceFolders||[],remote=folders.find(f=>f.uri.scheme==='vscode-remote')?.uri.authority||vscode.env.remoteName||null;
  const wsl=!!vscode.workspace.getConfiguration('chatgpt').get('runCodexInWindowsSubsystemForLinux',false);
  return{id,pid:process.pid,name:vscode.env.appName,workspace:folders.map(f=>f.uri.fsPath).join(' | '),windowKey:process.env.VSCODE_IPC_HOOK_CLI||null,home:remote||wsl?null:path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex')),remote,wsl};
 };
 const connection=()=>JSON.parse(fs.readFileSync(vscode.workspace.getConfiguration('codexSwitcher').get('connectionFile')||path.join(os.homedir(),'.codex-api-switcher','connection.json'),'utf8'));
 async function tick(){if(busy||stopped)return;busy=true;try{
  const c=connection(),data=report(),r=await post(c,'clientHeartbeat',data);status.tooltip='Connected to '+new URL(c.url).origin+' · '+(data.home||'separate remote/WSL environment');
  if(r.command?.type==='reload'){
   if(data.remote||data.wsl){await post(c,'clientHeartbeat',{...data,ack:r.command.id,ackStatus:'different_environment'});return}
   await post(c,'clientHeartbeat',{...data,ack:r.command.id,ackStatus:'reload_requested'});
   await context.workspaceState.update('codexSwitcher.lastReload',r.command.id);
   setTimeout(()=>vscode.commands.executeCommand('workbench.action.reloadWindow'),200);
  }
 }catch{status.tooltip='Local switcher is not running. Open the switcher, then connect this window.'}finally{busy=false}}
 context.subscriptions.push(vscode.commands.registerCommand('codexSwitcher.connect',tick));
 const timer=setInterval(tick,2000);context.subscriptions.push({dispose(){stopped=true;clearInterval(timer)}});tick();
}
exports.activate=activate;
