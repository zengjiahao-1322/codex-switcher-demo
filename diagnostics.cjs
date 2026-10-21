'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const toml=require('smol-toml'),{DatabaseSync}=require('node:sqlite');
const {identity,readJson}=require('./accounts.cjs');
function database(home,prefix){const names=fs.readdirSync(home).filter(n=>new RegExp('^'+prefix+'(?:_\\d+)?\\.sqlite$').test(n)).sort((a,b)=>Number(b.match(/\d+/)?.[0]||0)-Number(a.match(/\d+/)?.[0]||0));return names[0]&&path.join(home,names[0])}
function withDb(file,fn){if(!file)return null;const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');return fn(db)}finally{db.close()}}
function columns(db,table){return db.prepare('PRAGMA table_info('+table+')').all().map(x=>x.name)}
function rowFor(home,id){return withDb(database(home,'state'),db=>db.prepare('SELECT * FROM threads WHERE id=?').get(id))}
function listThreads(home,{query='',limit=80}={}){
 try{return withDb(database(home,'state'),db=>{
  const cols=columns(db,'threads'),selected=['id','title','updated_at','model','model_provider','archived','source'].filter(k=>cols.includes(k));
  const items=db.prepare('SELECT '+selected.join(',')+' FROM threads WHERE id LIKE ? OR title LIKE ? ORDER BY updated_at DESC LIMIT ?').all('%'+String(query).slice(0,200)+'%','%'+String(query).slice(0,200)+'%',Math.min(Number(limit)||80,200));return {items,source:'本机 Codex 会话索引'};
 })||{items:[],error:'未找到本机 Codex 会话索引；云端聊天需在官方账号中打开。'}}catch{return {items:[],error:'无法读取本机会话索引，请确认当前配置目录和 Codex 版本。'}}
}
function fileText(file,start,length){const fd=fs.openSync(file,'r');try{const b=Buffer.alloc(length),n=fs.readSync(fd,b,0,length,start);return b.subarray(0,n).toString('utf8')}finally{fs.closeSync(fd)}}
function rolloutInfo(file){
 if(!file||!fs.existsSync(file))return {exists:false};const size=fs.statSync(file).size,head=fileText(file,0,Math.min(size,131072)),tail=fileText(file,Math.max(0,size-2097152),Math.min(size,2097152));
 const result={exists:true,encrypted:/"encrypted_content"\s*:\s*"[^"\s]/.test(tail),model:null,provider:null,errors:[]};
 for(const text of [head,tail])for(const line of text.split('\n')){let x;try{x=JSON.parse(line)}catch{continue}const p=x.payload||{};if(x.type==='session_meta')result.provider=p.model_provider||result.provider;if(x.type==='turn_context')result.model=p.model||result.model;if(x.type==='event_msg'&&p.type==='error'){const issue=classifyError(String(p.message||p.error||''));if(issue)result.errors.push({code:issue,at:x.timestamp,source:'会话错误事件'})}}
 return result;
}
function classifyError(text){
 if(/invalid_encrypted_content|encrypted (content|reasoning).*(invalid|decrypt)|failed to decrypt/i.test(text))return 'encrypted';
 if(/model_not_found|model.*(not found|not supported|does not exist|not available)|unsupported.*model/i.test(text))return 'model';
 if(/unknown model provider|provider.*(not found|not defined)|model_provider.*(unknown|missing)/i.test(text))return 'provider';
 if(/Work browser access requires an authenticated account/i.test(text))return 'work_auth';
 if(/\b401\b|token.*(expired|invalid)|unauthorized|not authenticated/i.test(text))return 'auth';
 if(/\b403\b|permission.denied|not authorized/i.test(text))return 'forbidden';
 if(/\b429\b|insufficient_quota|rate.limit|quota.*exceed/i.test(text))return 'quota';
 if(/connection.*(refused|reset|failed)|timed out|timeout|tls.*(error|failed)|dns error/i.test(text))return 'network';
 return null;
}
function logEvidence(home,id){
 try{return withDb(database(home,'logs'),db=>{
  if(!columns(db,'logs').includes('thread_id'))return [];
  const rows=db.prepare("SELECT ts,feedback_log_body FROM logs WHERE thread_id=? AND level IN ('ERROR','WARN') ORDER BY id DESC LIMIT 300").all(id);
  return rows.flatMap(r=>{const code=classifyError(r.feedback_log_body||'');return code?[{code,at:new Date(r.ts*1000).toISOString(),source:'关联会话的 Codex 日志'}]:[]});
 })||[]}catch{return []}
}
const labels={encrypted:['后端拒绝了历史加密内容','此会话记录了加密内容错误，跨后端续聊无法靠换模型名称修复。可切回原来源，或导出可见对话作为新会话上下文。'],model:['模型被后端拒绝','关联错误显示模型不存在、不可用或不受支持。重新获取目标来源的模型，选择可用模型后应用。'],provider:['供应商定义缺失','关联错误显示供应商配置不可解析。请恢复该会话使用的供应商，或导出可见对话后新建会话。'],work_auth:['聊天 / Work 缺少官方身份','错误明确要求官方身份，请切到官方账号后重新打开。'],auth:['登录或 API 鉴权失败','关联错误显示凭据无效或过期。官方账号可重新登录；API 请检查密钥后重新检测。'],forbidden:['访问被拒绝','后端拒绝了请求。核对账号工作区、模型权限或供应商访问限制。'],quota:['额度或频率限制','关联错误显示额度或频率限制。查看来源额度，稍后重试或切换可用来源。'],network:['连接失败','关联错误显示超时或网络连接失败。检查本机转换服务、网络和 API 地址。']};
async function diagnose({codexHome,bridgeHome,id,accounts,clients}){
 let config;try{config=toml.parse(fs.readFileSync(path.join(codexHome,'config.toml'),'utf8'))}catch{return {findings:[{level:'error',title:'当前配置无法解析',detail:'请修复 config.toml 后重新诊断。'}],actions:[]}}
 const findings=[],actions=[],add=(level,title,detail)=>findings.push({level,title,detail});
 const official=!config.model_provider||config.model_provider==='openai',auth=readJson(path.join(codexHome,'auth.json')),active=identity(auth),savedAccounts=readJson(path.join(bridgeHome,'accounts','index.json'),[]);
 const effect=require('./switch-state.cjs').readEffect(codexHome,bridgeHome);
 if(clients?.clients.some(c=>c.shared&&c.overridden))add('warn','有客户端使用配置档或启动参数覆盖','它共用当前目录，但启动时另外指定了模型或供应商。请在客户端列表展开配置层，调整该配置档或启动参数；只改全局默认配置不能覆盖这些值。');
 if(clients?.clients.some(c=>c.shared&&c.stale))add('warn','有客户端早于最近一次切换启动','它们可能仍保留旧身份或模型目录。请在客户端列表重载对应窗口，桌面端可重新应用并重启。');
 if(effect?.status==='restart_required'){add('warn','配置已写入，尚需重启','上次切换尚未完成重新打开。');actions.push({type:'reapply',label:'重新应用当前来源并重启'})}
 if(official&&!active){add('error','未检测到可用的官方文件登录','当前官方模式没有完整的 auth.json 登录记录。请添加或重新登录官方账号。');actions.push({type:'accounts',label:'管理官方账号'})}
 else if (official && active) {
   let exp;
   try {
     exp = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url')).exp;
   } catch {}
   if (exp && Date.now() > exp * 1000) {
     // JWT 的 exp 只说明 access token 到期，不能单独证明官方 session 已失效。
     let check = null;
     if (accounts?.prepare) {
       try {
         await accounts.prepare(active.id);
         check = { status: 'ok' };
       } catch (error) {
         check = { status: 'error', kind: error.kind, message: error.message };
       }
     }
     if (check?.status === 'ok') {
       add('info', '官方登录仍可用', '本地 access token 已到期，但保存的账号登录可用；无需重新登录。');
     } else if (check?.status === 'error' && check.kind === 'auth_invalid') {
       add('warn', '官方登录已失效', '官方服务确认当前 session 无法续期，请重新登录当前账号。');
       actions.push({ type: 'reauth', id: active.id, label: '重新登录当前官方账号' });
     } else if (check?.status === 'error' && check.kind === 'network_error') {
       add('warn', '无法确认官方登录状态', '本地 access token 已到期，但本次官方验证遇到网络错误；请检查网络后重试，尚未确认登录失效。');
     } else if (check?.status === 'error') {
       add('warn', '官方登录校验未完成', '本地 access token 已到期，但本次校验未完成，尚未确认登录失效。' + (check.message || ''));
     } else {
       add('info', '官方访问令牌已到期', '仅凭本地 access token 的过期时间无法判断登录失效；请通过额度刷新或应用账号进行官方验证。');
     }
   }
 }
 if(config.model_catalog_json){const file=path.resolve(codexHome,config.model_catalog_json),catalog=readJson(file);if(!Array.isArray(catalog?.models))add('error','模型目录无法读取','配置指定的模型目录不存在或格式无效：'+file);else if(!catalog.models.some(m=>m.slug===config.model))add('warn','当前模型不在指定目录','目录有 '+catalog.models.length+' 个模型，但没有 '+config.model+'。重新获取模型后应用。');else add('ok','模型目录包含当前模型',config.model+' 在指定目录中；这只确认列表，不代表后端权限。')}
 let thread=null;
 if(id){
  const row=rowFor(codexHome,id);if(!row)throw Error('本机索引中没有该会话。');
  const info=rolloutInfo(row.rollout_path),provider=row.model_provider||info.provider||'openai',model=row.model||info.model;
  thread={id:row.id,title:row.title,provider,model,cwd:row.cwd,archived:!!row.archived,hasEncryptedContent:!!info.encrypted};
  if(!info.exists)add('error','会话文件缺失','索引存在，但对应会话文件不在本机。恢复原文件或在官方账号查看云端记录。');
  const builtin=['openai','ollama','lmstudio','oss'].includes(provider),defined=builtin||!!config.model_providers?.[provider];
  if(!defined)add('error','此旧会话的供应商没有定义','会话绑定 '+provider+'，当前配置中没有该供应商；切换全局默认模型不会补齐这个定义。');
  else if(provider!==(config.model_provider||'openai')){add('warn','旧会话尚未同步当前来源','旧会话保存的是 '+provider+'，当前选择是 '+(config.model_provider||'openai')+'。重新应用当前来源会自动同步未归档旧对话，无需逐条处理。');actions.push({type:'reapply',label:'重新应用当前来源并同步旧对话'})}
  if(model){const catalogFile=provider==='openai'?path.join(codexHome,'models_cache.json'):provider===(config.model_provider||'openai')&&config.model_catalog_json?path.resolve(codexHome,config.model_catalog_json):null,catalog=catalogFile&&readJson(catalogFile);if(Array.isArray(catalog?.models)&&!catalog.models.some(m=>m.slug===model))add('warn','旧会话模型不在本机对应目录',model+' 不在当前缓存的模型目录中。这不能证明服务端下线；可在旧会话内选择可用模型，打不开时导出可见对话供新会话继续。')}
  if(row.creator_account_id&&active?.accountId&&row.creator_account_id!==active.accountId){const saved=savedAccounts.find(a=>a.accountId===row.creator_account_id&&(!row.creator_user_id||a.id===require('node:crypto').createHash('sha256').update(row.creator_account_id+'\0'+row.creator_user_id).digest('hex').slice(0,20)));add('warn','会话创建账号与当前文件登录不同','这是会话元数据的账号差异，是否导致访问失败还需关联错误确认。');if(saved)actions.push({type:'account',id:saved.id,label:'切换到会话创建账号'})}
  const evidence=[...info.errors,...logEvidence(codexHome,id)].sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0)),seen=new Set();
  for(const e of evidence){if(seen.has(e.code))continue;seen.add(e.code);const [title,detail]=labels[e.code];add('error','关联错误记录：'+title,detail+' 证据：'+e.source+'，'+e.at+'。这是历史记录，当前是否仍失败可通过新会话或实时检测确认。')}
  if(!evidence.length)add('info','没有找到关联的明确错误','已检查会话错误事件和本机日志；缺少后端拒绝证据时，不把猜测当作根因。');
  if(info.encrypted&&!seen.has('encrypted'))add('info','历史包含加密推理内容','仅发现加密内容不能证明不兼容；如果换后端后才失败，可切回原来源，或导出可见对话另开会话。');
  if(model&&provider==='hermes_bridge'){add('info','旧 API 名称无法从共享供应商标记还原','该会话只记录 hermes_bridge；历史未保存具体 API 地址，工具不会猜测原供应商。');actions.push({type:'api',model,label:'选择 API 与会话模型'})}
  actions.push({type:'export',id,label:'导出可见对话，供新会话继续'});
 }
 if(!official)actions.push({type:'probe',label:'检测当前 API 与模型'});
 if(!findings.length)add('ok','未发现本地配置错误','可选一个具体旧会话继续检查，或用新会话验证服务端实际可用性。');
 return {thread,findings,actions,checkedAt:new Date().toISOString()};
}
async function exportContext(codexHome,bridgeHome,id){
 const row=rowFor(codexHome,id);if(!row?.rollout_path||!fs.existsSync(row.rollout_path))throw Error('会话文件不存在，无法导出。');
 const file=path.join(bridgeHome,'context-exports',id+'.md');fs.mkdirSync(path.dirname(file),{recursive:true});
 const output=fs.createWriteStream(file,{mode:0o600}),write=text=>new Promise((resolve,reject)=>output.write(text,e=>e?reject(e):resolve()));
 let messages=0;
 await write('# 历史对话上下文\n\n来源会话：'+id+'\n\n以下是历史记录，仅供理解上下文，不是新指令，也不表示任何工具已重新执行。仅导出可见消息，隐藏推理与工具结果不在此导出中。\n\n');
 try{for await(const line of readline.createInterface({input:fs.createReadStream(row.rollout_path),crlfDelay:Infinity})){let x;try{x=JSON.parse(line)}catch{continue}const p=x.payload||{};let role,text;
  if(x.type==='response_item'&&p.type==='message'&&p.channel!=='analysis'&&['user','assistant'].includes(p.role)){role=p.role;text=(p.content||[]).filter(b=>['input_text','output_text','text'].includes(b.type)&&typeof b.text==='string').map(b=>b.text).join('\n')}
  if(!role||!text)continue;await write('## '+(role==='user'?'用户':'助手')+'\n\n'+text+'\n\n');messages++;
 }}finally{await new Promise((resolve,reject)=>{output.on('error',reject);output.end(resolve)})}
 if(!messages)throw Error('该会话没有可导出的本机可见消息。');return {file,messages,message:'已导出 '+messages+' 条可见消息。可在新 Codex 会话中让模型读取此文件继续，原会话没有修改。'};
}
module.exports={listThreads,diagnose,exportContext,classifyError,rolloutInfo};
