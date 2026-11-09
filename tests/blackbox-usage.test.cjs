'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),{DatabaseSync}=require('node:sqlite');
const {startBackend}=require('./backend-process.cjs'),{api,serve}=require('./config-blackbox-helpers.cjs'),{isRust}=require('./backend.cjs');
const rustOnly={skip:!isRust&&'用量后端仅Rust实现'};
const priceFixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/usage-prices.json'),'utf8'));
const iso=t=>new Date(t).toISOString();const recent=Date.now()-60000;
const source=(client,kind,id,t,name=id)=>({t:iso(t),client,kind,id,name});
const provider=(id,pricing={mode:'official'})=>({id,origin:'custom',name:id,model:'gpt-6.1-sol',models:['gpt-6.1-sol'],baseUrl:'http://127.0.0.1:9/v1',apiMode:'responses',apiKey:'fake-only',pricing});
const event=(t,type,payload)=>({timestamp:iso(t),type,payload});
function write(file,lines){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,lines.map(v=>JSON.stringify(v)).join('\n')+'\n');}
function codex(t,id,model='gpt-6.1-sol'){return [event(t,'session_meta',{id,cwd:'C:/fixture/project'}),event(t,'turn_context',{model,effort:'high',service_tier:'priority'}),event(t,'event_msg',{type:'user_message',message:'PRIVATE_USAGE_CANARY_7a1f'} )];}
const usage=(input=100,cached=20,output=30)=>({input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:7,output_tokens:output,reasoning_output_tokens:10,total_tokens:input+output});
const modern=(t,thread,response,u=usage())=>event(t,'token_usage_record',{thread_id:thread,response_id:response,usage:u});
async function fixture(t,{records=[],providers=[provider('p')],setup}={}){
 const f=await startBackend(t,{setup(ctx){const {root,bridge,environment}=ctx;environment.CLAUDE_CONFIG_DIR=path.join(root,'claude');fs.mkdirSync(environment.CLAUDE_CONFIG_DIR);
 const resources=path.join(root,'resources');fs.mkdirSync(path.join(resources,'web'),{recursive:true});environment.SWITCHER_WEB_ROOT=path.join(resources,'web');fs.mkdirSync(path.join(resources,'data'));
 fs.copyFileSync(path.join(__dirname,'../data/prices-overrides.json'),path.join(resources,'data/prices-overrides.json'));
 fs.writeFileSync(path.join(resources,'data/price-snapshot.json'),JSON.stringify({source:'snapshot',fetchedAt:iso(Date.now()),version:1,models:priceFixture.data}));
 fs.mkdirSync(path.join(bridge,'usage'),{recursive:true});write(path.join(bridge,'usage/sources.jsonl'),records.length?records:[source('codex','api','p',recent-1000)]);
 fs.writeFileSync(path.join(bridge,'providers.json'),JSON.stringify({hermesImported:true,providers}));if(setup)setup(ctx);}});return f;
}
function details(f,client='codex',extra={}){return api(f,'usageRequests',{client,range:'today',...extra});}
test('用量：现代与旧格式去重、归属、内容隐私、失败及估算耗时',rustOnly,async t=>{
 const f=await fixture(t,{records:[source('codex','official','acct',recent-50000,'主账号'),source('codex','api','p',recent-20000,'API旧名')],setup({home,bridge}){
 const p=path.join(home,'sessions/new.jsonl');write(p,[...codex(recent-15000,'thread'),modern(recent-12000,'thread','resp'),modern(recent-11900,'thread','resp'),event(recent-11000,'event_msg',{type:'token_count',info:{total_token_usage:usage(1000),last_token_usage:usage(999)}}),event(recent-10000,'event_msg',{type:'task_complete',error:{codex_error_info:'http_error',message:'fake error'}})]);
 const totals=[140,290,290,450,450,620];write(path.join(home,'sessions/legacy.jsonl'),[...codex(recent-45000,'old'),event(recent-44000,'event_msg',{type:'token_count',info:null}),...totals.map((n,i)=>event(recent-40000+i*100,'event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:n-30,output_tokens:30,total_tokens:n},last_token_usage:usage(13803)}}))]);
 write(path.join(home,'sessions/untracked.jsonl'),[...codex(recent-70000,'untracked'),modern(recent-60000,'untracked','early',usage(5,0,1))]);
 }});
 const result=await details(f);assert.equal(result.total,7);assert.equal(result.rows.filter(r=>r.source.key==='official:acct').length,4);assert.equal(result.rows.filter(r=>r.source.key==='api:p').length,2);assert.equal(result.rows.filter(r=>r.source.key==='untracked').length,1);
 const row=result.rows.find(r=>r.ok&&r.source.key==='api:p');assert.equal(row.input,80);assert.equal(row.cachedInput,20);assert.equal(row.cacheWrite,7);assert.equal(row.reasoning,10);assert.equal(row.durationMs,3000);assert.equal(row.effort,'high');assert.equal(row.tier,'priority');assert.equal(row.project,'C:/fixture/project');assert.ok(Math.abs(row.cost-(80e-6+20e-7+30*4e-6))<1e-12);
 assert.equal(result.rows.find(r=>!r.ok).error,'http_error: fake error');assert.equal(result.rows.find(r=>!r.ok).cost,null);assert.equal(result.rows.find(r=>!r.ok).currency,null);const summary=await api(f,'usage',{client:'codex',range:'today'});assert.equal(summary.totals.requests,7);assert.equal(summary.totals.failed,1);assert.equal(summary.totals.priced+summary.totals.unpriced,6);assert.equal(summary.sources.find(s=>s.key==='official:acct').subscription,true);assert.equal(summary.sources.find(s=>s.key==='api:p').name,'API旧名');assert.equal(summary.untracked.requests,1);
 const db=path.join(f.bridge,'usage/usage.sqlite');assert.equal(fs.readFileSync(db).includes(Buffer.from('PRIVATE_USAGE_CANARY_7a1f')),false);assert.equal(JSON.stringify(summary).includes('PRIVATE_USAGE_CANARY_7a1f'),false);assert.equal(JSON.stringify(result).includes('PRIVATE_USAGE_CANARY_7a1f'),false);
 assert.equal((await details(f,'codex',{result:'failed'})).total,1);assert.equal((await details(f,'codex',{source:'api:p',offset:1,limit:1})).rows.length,1);assert.equal((await details(f,'codex',{model:'absent'})).total,0);
 const store=JSON.parse(fs.readFileSync(path.join(f.bridge,'providers.json')));store.providers=[];fs.writeFileSync(path.join(f.bridge,'providers.json'),JSON.stringify(store));assert.equal((await details(f)).rows.find(r=>r.source.key==='api:p').source.name,'API旧名');
});
test('用量：追加和半行续读、同大小替换及zst替换不重复计数',rustOnly,async t=>{
 let file;const f=await fixture(t,{setup({home}){file=path.join(home,'sessions/inc.jsonl');write(file,[...codex(recent,'inc'),modern(recent+1000,'inc','a')]);}});
 assert.equal((await details(f)).total,1);const b=JSON.stringify(modern(recent+2000,'inc','b'));fs.appendFileSync(file,b.slice(0,35));assert.equal((await details(f)).total,1);fs.appendFileSync(file,b.slice(35)+'\n');assert.equal((await details(f)).total,2);
 let raw=fs.readFileSync(file,'utf8').replaceAll('"input_tokens":100','"input_tokens":333');fs.writeFileSync(file,raw);const replaced=await details(f);assert.equal(replaced.total,2);assert.ok(replaced.rows.every(r=>r.input===313));
 write(file,[...codex(recent,'inc'),modern(recent+3000,'inc','truncated',usage(200))]);assert.equal((await details(f)).total,1);assert.equal((await details(f)).rows[0].input,180);raw=fs.readFileSync(file,'utf8');
 fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(raw));fs.unlinkSync(file);assert.equal((await details(f)).total,1);assert.equal((await details(f)).rows[0].input,180);
});
test('用量：Claude多块去重、两档缓存和错误、倍率free与未定价',rustOnly,async t=>{
 const f=await fixture(t,{providers:[provider('p',{mode:'multiplier',multiplier:0.3,currency:'CNY'}),provider('free',{mode:'free'})],records:[source('claude','api','p',recent-1000),source('claude','api','free',recent+10000)],setup({environment}){
 const u={input_tokens:11,cache_read_input_tokens:13,cache_creation:{ephemeral_5m_input_tokens:5,ephemeral_1h_input_tokens:7},output_tokens:17};
 const a={type:'assistant',timestamp:iso(recent+1000),cwd:'C:/claude-project',message:{id:'same',model:'claude-sonnet-4-5-20250929',usage:u},content:'PRIVATE_USAGE_CANARY_7a1f'};
 write(path.join(environment.CLAUDE_CONFIG_DIR,'projects/a/transcript.jsonl'),[{type:'user',timestamp:iso(recent),message:{content:'PRIVATE_USAGE_CANARY_7a1f'}},a,{...a,uuid:'second',timestamp:iso(recent+1100)},{...a,timestamp:iso(recent+2000),message:{id:'unknown',model:'unknown-model',usage:u}},{...a,timestamp:iso(recent+3000),isApiErrorMessage:true,error:'unknown',apiErrorStatus:400,message:{id:'failed',model:'<synthetic>',usage:{}}},{...a,timestamp:iso(recent+11000),message:{id:'free',model:'missing-free',usage:u}}]);
 }});
 const all=await details(f,'claude');assert.equal(all.total,4);const a=all.rows.find(r=>r.model?.startsWith('claude-'));assert.equal(a.input,11);assert.equal(a.cachedInput,13);assert.equal(a.cacheWrite,12);assert.equal(a.durationMs,1000);assert.equal(a.currency,'CNY');assert.ok(Math.abs(a.cost-(11*3e-6+13*3e-7+5*3.75e-6+7*6e-6+17*15e-6)*0.3)<1e-12);assert.equal(all.rows.find(r=>r.model==='unknown-model').cost,null);assert.equal(all.rows.find(r=>r.model==='missing-free').cost,0);
 const s=await api(f,'usage',{client:'claude',range:'today'});assert.equal(s.totals.requests,4);assert.equal(s.totals.unpriced,1);assert.equal(s.totals.failed,1);assert.equal(s.totals.priced,2);const failed=all.rows.find(r=>!r.ok);assert.equal(failed.model,null);assert.equal(failed.cost,null);assert.equal(failed.currency,null);assert.ok(s.models.every(m=>m.model!==null&&m.model!=='<synthetic>'));const db=new DatabaseSync(path.join(f.bridge,'usage/usage.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT model FROM requests WHERE ok=0').get().model,null);db.close();assert.equal(s.totals.reasoning,0);assert.equal(fs.readFileSync(path.join(f.bridge,'usage/usage.sqlite')).includes(Buffer.from('PRIVATE_USAGE_CANARY_7a1f')),false);
});
test('用量：today/7d/30d边界、补零、排序与分页',rustOnly,async t=>{
 const f=await fixture(t);for(const range of ['today','7d','30d']){const empty=await api(f,'usage',{client:'codex',range});const from=Date.parse(empty.from);const file=path.join(f.home,'sessions',range+'.jsonl');write(file,[...codex(from-1000,range),modern(from-1,range,'before'),modern(from,range,'at')]);const r=await details(f,'codex',{range,model:'gpt-6.1-sol'});assert.ok(r.rows.some(r=>Date.parse(r.t)===from));assert.equal(r.rows.some(r=>Date.parse(r.t)===from-1),false);const summary=await api(f,'usage',{client:'codex',range});assert.ok(summary.series.length>0);assert.equal(summary.series.reduce((n,s)=>n+s.requests,0),summary.totals.requests);if(range!=='today')assert.equal(summary.series.length,range==='7d'?7:30);}
 assert.equal((await f.api('usage',{client:'wrong',range:'today'})).status,400);
});
test('价格与provider：格式校验/state回填、公开价格过滤和失败保留旧价格',rustOnly,async t=>{
 let fail=false;const server=await serve(t,(_,r)=>{if(fail){r.writeHead(503);r.end('{}');}else r.end(JSON.stringify(priceFixture));});
 const f=await fixture(t,{setup({environment}){environment.SWITCHER_TEST_PRICE_ORIGIN=server.url+'/models';}});
 const base={name:'Test price',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fake-only',model:'main',apiMode:'responses'};
 for(const [pricing,match]of [[{mode:'x'},/mode/],[{mode:'multiplier',multiplier:0,currency:'USD'},/倍率/],[{mode:'multiplier',multiplier:1,currency:'EUR'},/币种/]]){const v=await api(f,'providerAdd',{...base,pricing},400);assert.match(v.error,match);}
 assert.match((await api(f,'providerAdd',{...base,usageUrl:'file:///x'},400)).error,/http/);
 const p=await api(f,'providerAdd',{...base,pricing:{mode:'free'},usageUrl:'https://example.test/billing'});let state=await api(f,'state');assert.equal(state.providers.find(v=>v.id===p.id).pricing.mode,'free');
 await api(f,'providerUpdate',{id:p.id,pricing:{mode:'multiplier',multiplier:0.3,currency:'CNY'},usageUrl:null});state=await api(f,'state');assert.equal(state.providers.find(v=>v.id===p.id).pricing.currency,'CNY');assert.equal(state.providers.find(v=>v.id===p.id).usageUrl,null);
 const price=await api(f,'usagePrices',{});assert.equal(price.source,'openrouter');const stored=JSON.parse(fs.readFileSync(path.join(f.bridge,'usage/prices.json')));assert.equal(stored.models.length,2);fail=true;const bad=await api(f,'usagePrices',{});assert.ok(bad.error);assert.ok(bad.errorAt);const after=JSON.parse(fs.readFileSync(path.join(f.bridge,'usage/prices.json')));assert.deepEqual(after.models,stored.models);assert.equal(after.version,stored.version);
});
test('Windows用量：1GiB混合jsonl/zst含数据库写入和无变化调用性能',{skip:(!isRust||process.platform!=='win32')&&'本例采样Windows峰值工作集'},async t=>{
 let logicalBytes=0;const f=await fixture(t,{setup({home}){
 const dir=path.join(home,'sessions');fs.mkdirSync(dir,{recursive:true});
 const record=JSON.stringify(event(recent,'event_msg',{type:'token_count',info:{total_token_usage:usage(),last_token_usage:usage()}}))+'\n';const block=Buffer.from(record.repeat(Math.floor(1048576/Buffer.byteLength(record))));
 for(let i=0;i<16;i++){const file=path.join(dir,i+'.jsonl');const fd=fs.openSync(file,'w');const header=Buffer.from(codex(recent-2000,'performance-'+i).map(v=>JSON.stringify(v)).join('\n')+'\n');fs.writeSync(fd,header);logicalBytes+=header.length;for(let k=0;k<64;k++){fs.writeSync(fd,block);logicalBytes+=block.length;}fs.closeSync(fd);if(i%2){fs.writeFileSync(file+'.zst',zlib.zstdCompressSync(fs.readFileSync(file)));fs.unlinkSync(file);}}
 }});
 const start=performance.now();const first=await api(f,'usage',{client:'codex',range:'today'});const firstMs=performance.now()-start;
 const next=performance.now();const second=await api(f,'usage',{client:'codex',range:'today'});const unchangedMs=performance.now()-next;
 const {execFileSync}=require('node:child_process');const memory=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${f.child.pid} | Select-Object WorkingSet64,PeakWorkingSet64 | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}));
 const result={logicalBytes,firstMs,unchangedMs,requests:first.totals.requests,unchangedRequests:second.totals.requests,...memory,method:'Rust HTTP query with SQLite writes; repeated token_count corpus; OS cache not cleared'};
 t.diagnostic(JSON.stringify(result));assert.ok(logicalBytes>1070000000);assert.equal(first.totals.requests,16);assert.equal(second.totals.requests,16);assert.ok(firstMs<10000,JSON.stringify(result));assert.ok(unchangedMs<200,JSON.stringify(result));assert.ok(memory.PeakWorkingSet64<200*1024*1024,JSON.stringify(result));
});
test('价格：模型日期和别名、长上下文分档以及默认provider字段',rustOnly,async t=>{
 const f=await fixture(t,{setup({home,root}){
 write(path.join(home,'sessions/prices.jsonl'),[...codex(recent,'dated','gpt-6.1-sol-20261101'),modern(recent+1000,'dated','long',usage(1200,200,10)),event(recent+1100,'turn_context',{model:'fixture-model-alias'}),modern(recent+1200,'dated','aliased',usage(100,20,30))]);
 const file=path.join(root,'resources/data/prices-overrides.json');fs.writeFileSync(file,JSON.stringify({aliases:{'fixture-model-alias':{id:'openai/gpt-6.1-sol',source:'https://example.test/fixture-alias'}},prices:{},tiers:{},longContext:{}}));
 }});
 const rows=(await details(f)).rows;assert.equal(rows.length,2);assert.ok(Math.abs(rows.find(r=>r.model.includes('20261101')).cost-(1000*2e-6+200e-7+10*6e-6))<1e-12);assert.ok(rows.find(r=>r.model==='fixture-model-alias').cost>0);
 const added=await api(f,'providerAdd',{name:'default pricing',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fake',model:'main',apiMode:'responses'});const state=await api(f,'state');const p=state.providers.find(p=>p.id===added.id);assert.deepEqual(p.pricing,{mode:'official'});assert.equal(p.usageUrl,null);
});
test('来源：首次启动起点、Claude apply与restore分别追加记录',rustOnly,async t=>{
 const f=await fixture(t,{providers:[{...provider('direct'),apiMode:'anthropic_messages'}],setup({bridge}){fs.unlinkSync(path.join(bridge,'usage/sources.jsonl'));}});
 const file=path.join(f.bridge,'usage/sources.jsonl');const rows=()=>fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows().map(r=>r.client),['codex','claude']);assert.equal(rows()[1].id,'claude');assert.equal(rows()[1].name,'Claude 官方登录');
 await api(f,'claudeApply',{id:'direct',model:'gpt-6.1-sol'});assert.equal(rows().at(-1).id,'direct');assert.equal(rows().at(-1).kind,'api');
 await api(f,'claudeRestore',{});assert.equal(rows().at(-1).id,'claude');assert.equal(rows().at(-1).kind,'official');assert.equal(rows().length,4);
});
test('Claude长上下文门槛包含缓存读和两档缓存写',rustOnly,async t=>{
 const f=await fixture(t,{records:[source('claude','official','claude',recent-1000,'Claude 官方登录')],setup({environment,root}){
 const file=path.join(root,'resources/data/price-snapshot.json'),book=JSON.parse(fs.readFileSync(file));book.models.find(m=>m.id==='anthropic/claude-sonnet-4.5').pricing.overrides=[{min_prompt_tokens:1000,prompt:'0.000006',completion:'0.000030'}];fs.writeFileSync(file,JSON.stringify(book));
 const row=(n)=>({type:'assistant',timestamp:iso(recent+n),cwd:'C:/fixture',message:{id:'context-'+n,model:'claude-sonnet-4-5',usage:{input_tokens:900,cache_read_input_tokens:50,cache_creation:{ephemeral_5m_input_tokens:20,ephemeral_1h_input_tokens:n},output_tokens:10}}});
 write(path.join(environment.CLAUDE_CONFIG_DIR,'projects/context/transcript.jsonl'),[row(29),row(30)]);
 }});
 const result=await details(f,'claude');assert.equal(result.total,2);
 const below=result.rows.find(r=>r.cacheWrite===49),at=result.rows.find(r=>r.cacheWrite===50);
 assert.ok(Math.abs(below.cost-(900*3e-6+50*3e-7+20*3.75e-6+29*6e-6+10*15e-6))<1e-12);
 assert.ok(Math.abs(at.cost-(900*6e-6+50*3e-7+20*3.75e-6+30*6e-6+10*30e-6))<1e-12);
});
