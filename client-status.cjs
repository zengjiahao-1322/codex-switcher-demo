'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {powershell}=require('./desktop-account.cjs');
const {writeJson,readJson}=require('./accounts.cjs');
const canonical=p=>{let value=path.resolve(p);try{value=fs.realpathSync.native(value)}catch{}value=value.replace(/[\\/]+$/,'');return process.platform==='win32'?value.toLowerCase():value};
const sameHome=(a,b)=>!!a&&!!b&&canonical(a)===canonical(b);
let cached;
function scan(){
 if(cached&&Date.now()-cached.at<2500)return cached.value;
 const value=process.platform==='darwin'?require('./mac-processes.cjs').scan():JSON.parse(powershell(fs.readFileSync(path.join(__dirname,'process-context.ps1'),'utf8')));cached={at:Date.now(),value};return value;
}
function ancestryOf(p,all){const found=[],seen=new Set();let id=p.parentPid;while(id&&!seen.has(id)){seen.add(id);const parent=all.find(x=>x.pid===id);if(!parent)break;found.push(parent);id=parent.parentPid}return found}
function configLayers(home,cwd,profile,overrides={}){
 const layers=[];
 const add=(file,source)=>{if(!fs.existsSync(file)||layers.some(l=>sameHome(l.file,file)))return;try{const c=require('smol-toml').parse(fs.readFileSync(file,'utf8'));const values={};for(const k of ['model','model_provider','model_catalog_json'])if(c[k]!==undefined)values[k]=c[k];layers.push({file,source,values})}catch{layers.push({file,source,error:'配置无法解析'})}};
 if(home){add(path.join(home,'config.toml'),'用户配置');if(profile&&/^[\w.-]+$/.test(profile))add(path.join(home,profile+'.config.toml'),'启动配置档')}
 if(cwd){const dirs=[];let d=path.resolve(cwd);for(let i=0;i<30;i++){dirs.unshift(d);const parent=path.dirname(d);if(parent===d)break;d=parent}for(const dir of dirs)add(path.join(dir,'.codex','config.toml'),'项目配置（是否加载取决于信任与客户端）')}
 if(Object.keys(overrides).length)layers.push({source:'启动参数',values:overrides});return layers;
}
function records(bridgeHome){const dir=path.join(bridgeHome,'clients');if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>readJson(path.join(dir,n))).filter(x=>x&&Date.now()-x.seenAt<15000)}
function heartbeat(bridgeHome,input){
 const id=String(input.id||'');if(!/^[\w-]{8,80}$/.test(id))throw Error('客户端编号无效');
 const file=path.join(bridgeHome,'clients',id+'.json'),prior=readJson(file,{});
 const row={id,pid:Number(input.pid),name:String(input.name||'VS Code'),workspace:String(input.workspace||''),home:input.home?String(input.home):null,windowKey:input.windowKey?String(input.windowKey):null,remote:input.remote?String(input.remote):null,wsl:!!input.wsl,seenAt:Date.now(),command:prior.command||null,lastAck:prior.lastAck||null};
 if(input.ack&&row.command?.id===input.ack){row.lastAck={id:input.ack,at:Date.now(),status:input.ackStatus||'accepted'};row.command=null}
 writeJson(file,row);return {command:row.command};
}
function snapshot(codexHome,bridgeHome,{inventory=scan()}={}){
 const all=inventory.ancestry,windows=records(bridgeHome).filter(w=>all.some(p=>p.pid===w.pid));
 const effect=require('./switch-state.cjs').readEffect(codexHome,bridgeHome);
 const clients=inventory.processes.map(p=>{
  const ancestors=ancestryOf(p,all),auxiliary=ancestors.some(a=>/^node_repl(?:\.exe)?$/i.test(a.name||'')||/[\\/]runtimes[\\/]cua_node[\\/]/i.test(a.exe||'')),desktop=!auxiliary&&ancestors.some(a=>/OpenAI\.Codex|\/Codex\.app\/Contents\/MacOS\//i.test(a.exe||'')),editor=ancestors.find(a=>/^(Code|Code - Insiders|Cursor|Windsurf)(?:\.exe| Helper(?: \(Plugin\))?)?$/i.test(a.name||''));
  const context=p.context||{},tool=/codex-bridge-validate-|[\\/]accounts[\\/](login|[a-f0-9]{20})([\\/]|$)/i.test(context.cwd||'');
  const kind=tool?'tool':auxiliary?'auxiliary':desktop?'desktop':editor||/openai\.chatgpt[-\\/]/i.test(p.exe||'')?'ide':'cli';
  const companion=windows.find(w=>!w.remote&&!w.wsl&&(w.pid===p.parentPid||ancestors.some(a=>a.pid===w.pid)||(w.windowKey&&w.windowKey===context.windowKey)));
  const shared=sameHome(context.home,codexHome),layers=configLayers(context.home,context.cwd,context.profile,context.overrides);
  const stale=shared&&!!effect&&Date.parse(p.startedAt)<Date.parse(effect.at);
  return {id:'process-'+p.pid,pid:p.pid,kind,name:kind==='auxiliary'?'自动化工具辅助后台':kind==='desktop'?'Codex 桌面端':kind==='ide'?(editor?.name?.replace('.exe','')||'编辑器')+' · Codex':kind==='tool'?'切换器校验进程':'Codex CLI / app-server',home:context.home||null,homeSource:context.homeSource||null,confirmed:!!context.ok,shared,startedAt:p.startedAt,stale,cwd:context.cwd||null,profile:context.profile||null,layers,overridden:layers.some(l=>['启动配置档','启动参数'].includes(l.source)&&Object.keys(l.values||{}).length),editorId:companion?.id||null,error:context.error||null};
 }).filter(p=>p.kind!=='tool');
 for(const w of windows){
  const matching=clients.filter(c=>c.editorId===w.id);
  const direct=process.platform==='darwin'&&matching.length&&w.home&&!w.remote&&!w.wsl,shared=matching.some(x=>x.shared)||(direct&&sameHome(w.home,codexHome));
  clients.push({id:'editor-'+w.id,editorId:w.id,pid:w.pid,kind:'editor',name:w.name,workspace:w.workspace,remote:w.remote,wsl:w.wsl,home:matching.find(x=>x.confirmed)?.home||w.home,confirmed:matching.some(x=>x.confirmed)||!!direct,shared:!!shared,stale:matching.some(x=>x.stale),canReload:!!shared&&!w.remote&&!w.wsl,commandPending:!!w.command,lastAck:w.lastAck,layers:matching[0]?.layers||[],cwd:w.workspace});
 }
 return {home:codexHome,clients:clients.filter(c=>c.kind!=='auxiliary'),auxiliary:clients.filter(c=>c.kind==='auxiliary'),desktop:clients.some(c=>c.kind==='desktop'),ide:clients.filter(c=>c.kind==='ide').length,other:clients.filter(c=>c.kind==='cli').length,connectedEditors:windows.length,checkedAt:new Date().toISOString()};
}
function requestReload(codexHome,bridgeHome,{id}={}){
 const status=snapshot(codexHome,bridgeHome),targets=status.clients.filter(c=>c.kind==='editor'&&c.canReload&&(!id||c.editorId===id));
 if(id&&!targets.length)throw Error('该窗口未连接伴随扩展，或未确认共用当前配置目录。');
 for(const c of targets){const file=path.join(bridgeHome,'clients',c.editorId+'.json'),row=readJson(file);row.command={id:crypto.randomUUID(),type:'reload',at:Date.now()};writeJson(file,row)}
 return {count:targets.length,message:targets.length?'已向 '+targets.length+' 个共用配置的编辑器窗口发送重载请求。':'没有已连接且确认共用配置的编辑器窗口。'};
}
function clientStatus(codexHome,bridgeHome){return snapshot(codexHome,bridgeHome)}
function desktopTargets(exe,codexHome){const inventory=scan(),allowed=new Set();for(const p of inventory.processes){if(!sameHome(p.context?.home,codexHome))continue;for(const a of ancestryOf(p,inventory.ancestry))if(a.exe&&sameHome(a.exe,exe))allowed.add(a.pid)}for(let pass=0;pass<5;pass++)for(const p of inventory.ancestry)if(allowed.has(p.parentPid)&&p.exe&&sameHome(p.exe,exe))allowed.add(p.pid);return [...allowed]}
module.exports={clientStatus,snapshot,heartbeat,requestReload,sameHome,configLayers,desktopTargets,scan};
