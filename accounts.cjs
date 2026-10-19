'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {findCodex}=require('./runtime.cjs'),{switchJob}=require('./switch-state.cjs');
function readJson(file,fallback=null){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file)}
function claims(token){try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url'))}catch{return {}}}
function identity(auth){
 if(!auth?.tokens?.access_token||!auth.tokens.account_id)return null;
 const access=claims(auth.tokens.access_token),id=claims(auth.tokens.id_token||''),a=access['https://api.openai.com/auth']||id['https://api.openai.com/auth']||{};
 const accountId=auth.tokens.account_id,userId=a.chatgpt_user_id||a.user_id||access.sub||id.sub||'';
 return {id:crypto.createHash('sha256').update(accountId+'\0'+userId).digest('hex').slice(0,20),accountId,email:id.email||access['https://api.openai.com/profile']?.email||'',plan:a.chatgpt_plan_type||'unknown'};
}
function quotaBuckets(result){
 const buckets=result.rateLimitsByLimitId&&Object.keys(result.rateLimitsByLimitId).length?Object.entries(result.rateLimitsByLimitId):result.rateLimits?[['codex',result.rateLimits]]:[];
 return buckets.map(([id,b])=>({id:b.limitId||id,name:b.limitName||b.limitId||id,plan:b.planType||null,windows:['primary','secondary'].filter(key=>b[key]).map(key=>{const w=b[key],used=typeof w.usedPercent==='number'?Math.max(0,Math.min(100,w.usedPercent)):null;return{key,usedPercent:used,remainingPercent:used===null?null:100-used,minutes:w.windowDurationMins??null,resetsAt:w.resetsAt??null}}),credits:b.credits?{unlimited:!!b.credits.unlimited,balance:b.credits.balance??null}:null}));
}
function createAccounts({codexHome,bridgeHome,codexExe,spawnProcess=spawn}){
 const root=path.join(bridgeHome,'accounts'),indexFile=path.join(root,'index.json'),liveFile=path.join(codexHome,'auth.json');
 const load=()=>readJson(indexFile,[]),authFile=id=>path.join(root,id,'auth.json');
 let login=null,session=null;
 function remember(auth,{pendingLogin=false}={}){
  const info=identity(auth);if(!info)return null;
  const rows=load(),index=rows.findIndex(a=>a.id===info.id),old=rows[index];
  const row={...old,...info,label:old?.label||info.email||'ChatGPT 账号',savedAt:new Date().toISOString(),pendingLogin};
  writeJson(authFile(info.id),auth);if(index<0)rows.push(row);else rows[index]=row;writeJson(indexFile,rows);return row;
 }
 function captureCurrent(){
  const auth=readJson(liveFile),info=identity(auth);if(!info)return null;
  const old=load().find(a=>a.id===info.id);if(old?.pendingLogin)return old;
  // A running desktop may still hold the token from before a saved-login refresh.
  const saved=old&&readJson(authFile(info.id));
  if(saved&&Date.parse(saved.last_refresh)>Date.parse(auth.last_refresh))return old;
  if(old&&JSON.stringify(readJson(authFile(info.id)))===JSON.stringify(auth))return old;
  return remember(auth);
 }
 function status(){
  captureCurrent();const current=identity(readJson(liveFile));
  return {items:load().map(row=>({...row,current:row.id===current?.id,quota:readJson(path.join(root,row.id,'quota.json'))})),login:login?{...login}:null,switchJob:switchJob(bridgeHome)};
 }
 function apply(id,model,catalog){
  const selected=load().find(a=>a.id===id);if(!selected)throw Error('请选择一个已保存的官方账号');
  captureCurrent();const auth=readJson(authFile(id));
  require('./core.cjs').applyOfficial(codexHome,model,catalog);writeJson(liveFile,auth);
  remember(auth);fs.rmSync(path.join(bridgeHome,'current.json'),{force:true});return {id,email:selected.email,label:selected.label};
 }
 function rename(id,label){const rows=load(),row=rows.find(a=>a.id===id);if(!row)throw Error('账号不存在');row.label=String(label).trim()||row.email||'ChatGPT 账号';writeJson(indexFile,rows)}
 function remove(id){writeJson(indexFile,load().filter(a=>a.id!==id));fs.rmSync(authFile(id),{force:true})}
 function openSession(home,onNotification=()=>{}){
  fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,'config.toml'),'cli_auth_credentials_store = "file"\n[features]\nplugins = false\nremote_plugin = false\n[analytics]\nenabled = false\n');
  const env={...process.env,CODEX_HOME:home};for(const k of Object.keys(env))if(k.startsWith('CODEX_')&&k!=='CODEX_HOME')delete env[k];
  const child=spawnProcess(codexExe||findCodex(),['app-server'],{cwd:home,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let seq=0,buffer='',closed=false;
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('官方登录进程已结束'))}pending.clear()};
  const close=()=>{if(closed)return;closed=true;fail();child.stdin.end();child.kill()};
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('官方登录服务响应超时，请重试'))},45000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n')});
  child.stderr.resume();child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let msg;try{msg=JSON.parse(line)}catch{continue}
   const p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(Object.assign(Error('官方服务未能完成 '+(msg.error.code||'请求')),{code:msg.error.code})):p.resolve(msg.result)}
   else if(msg.method)onNotification(msg);
  }});
  child.stdin.on('error',fail);child.on('error',fail);child.on('exit',()=>{fail();if(!closed)onNotification({method:'process/exit'})});
  const ready=async()=>{await rpc('initialize',{clientInfo:{name:'codex-api-switcher',title:'Codex API 切换器',version:'1.0.0'}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n')};
  return {rpc,ready,close};
 }
 async function quota(id){
  captureCurrent();if(!load().some(a=>a.id===id))throw Error('账号不存在，请重新选择');
  const file=path.join(root,id,'quota.json'),previous=readJson(file,{});let check;
  try{
   check=openSession(path.dirname(authFile(id)));await check.ready();
   const account=await check.rpc('account/read',{refreshToken:false});
   if(account.account?.type!=='chatgpt')throw Error('未读到官方登录');
   const result=await check.rpc('account/rateLimits/read',{}),buckets=quotaBuckets(result);
   if(!buckets.length)throw Error('官方服务未返回额度');
   const value={status:'ok',checkedAt:new Date().toISOString(),buckets};writeJson(file,value);return {id,...value};
  }catch(e){
   const value={...previous,status:'error',attemptedAt:new Date().toISOString(),error:e.code===-32601?'当前 Codex 版本不支持额度查询，请更新后重试。':'额度读取失败，请检查网络或重新登录后重试。'};
   writeJson(file,value);return {id,...value};
  }finally{check?.close()}
 }
 async function prepare(id){
  captureCurrent();const row=load().find(a=>a.id===id);if(!row)throw Error('账号不存在，请重新选择');
  const auth=readJson(authFile(id)),live=identity(readJson(liveFile));
  if(!identity(auth))throw Error('登录记录不完整，请重新登录 '+row.label);
  if(live?.id===id&&!row.pendingLogin){
   const exp=claims(auth.tokens.access_token).exp;
   if(exp&&exp*1000<=Date.now())throw Error(row.label+' 的当前登录已过期，请先点“重新登录”；本次未关闭桌面端。');
   return row;
  }
  const check=openSession(path.dirname(authFile(id)));
  try{
   await check.ready();const result=await check.rpc('account/read',{refreshToken:true});
   if(result.account?.type!=='chatgpt')throw Error('未读到 ChatGPT 登录');
   const refreshed=readJson(authFile(id));if(identity(refreshed)?.id!==id)throw Error('返回的账号与所选账号不一致');
   return remember(refreshed,{pendingLogin:row.pendingLogin});
  }catch{throw Error('无法准备 '+row.label+' 的官方登录，请重试或点“重新登录”；本次未关闭桌面端。')}
  finally{check.close()}
 }
 function finishLogin(message){login={...login,...message};session?.close();session=null}
 async function startLogin({id}={}){
  if(['starting','waiting'].includes(login?.status))throw Error('请先完成或取消当前登录');
  const target=id?load().find(a=>a.id===id):null;if(id&&!target)throw Error('账号不存在');
  const home=path.join(root,'login');fs.mkdirSync(home,{recursive:true});fs.rmSync(path.join(home,'auth.json'),{force:true});
  login={status:'starting',targetId:id||null};
  const active=session=openSession(home,msg=>{
   if(session!==active)return;
   if(msg.method==='process/exit'){finishLogin({status:'error',message:'登录已结束，请重新登录'});return}
   if(msg.method!=='account/login/completed')return;
   if(!msg.params.success){finishLogin({status:'error',message:'登录未完成，请重试'});return}
   try{
    const auth=readJson(path.join(home,'auth.json')),info=identity(auth);if(!info)throw Error('登录成功但未读到官方账号，请重试');
    if(id&&info.id!==id)throw Error('登录的是其他账号或工作区，原账号未替换，请重新选择正确账号');
    const pendingLogin=identity(readJson(liveFile))?.id===info.id;
    const row=remember(auth,{pendingLogin});fs.rmSync(path.join(home,'auth.json'),{force:true});
    finishLogin({status:'done',accountId:row.id,message:(id?'已更新 ':'已添加 ')+row.label+'；在上方选择此账号并重启后使用。'});
   }catch(e){fs.rmSync(path.join(home,'auth.json'),{force:true});finishLogin({status:'error',message:e.message})}
  });
  try{await active.ready();const result=await active.rpc('account/login/start',{type:'chatgpt',appBrand:'chatgpt'});login={...login,status:'waiting',loginId:result.loginId,authUrl:result.authUrl,message:id?'请在官方页面重新登录 '+target.label+'，完成后会更新原账号。':'请在官方页面登录要添加的账号，完成后会自动加入列表。'};return {...login}}
  catch(e){finishLogin({status:'error',message:e.message});throw e}
 }
 async function cancelLogin(){const active=session;session=null;try{if(active&&login?.loginId)await active.rpc('account/login/cancel',{loginId:login.loginId})}finally{active?.close();login={...login,status:'cancelled',message:'已取消登录'}}}
 return {status,captureCurrent,apply,prepare,rename,remove,startLogin,cancelLogin,quota};
}
module.exports={createAccounts,identity,readJson,writeJson,quotaBuckets};

