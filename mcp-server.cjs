// Codex 内的 API 切换工具（MCP，stdio）。由 `codex mcp add api_switcher -- runtime\node.exe mcp-server.cjs` 注册。
// 与网页共用 service.cjs。密钥不经过对话：新增/修改密钥请用 open_api_manager 打开本机管理页面。
// stdout 只输出 MCP 协议消息（每行一个 JSON-RPC 消息）。
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');const {createService,OFFICIAL}=require('./service.cjs');
const platform=require('./platform.cjs'),codexHome=platform.codexHome(),bridgeHome=platform.dataHome();
const hermesHome=process.env.BRIDGE_HERMES_HOME||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Hermes Agent CN Desktop','data','hermes-home');
const launch=open=>platform.launch(open);
const svc=createService({codexHome,bridgeHome,hermesHome,projectDir:__dirname,startService:async()=>launch(false)});
const accessText={direct:'直连',adapter:'经本机转换',failed:'上次检测未通过',unknown:'未检测',official:'官方登录'};
const describe=p=>`${p.inUse?'▶ ':'  '}${p.name}｜${accessText[p.access?.mode]||'未检测'}｜默认模型 ${p.model||'（无）'}${p.local?'｜本机代理':''}${p.id===OFFICIAL?'':`｜id ${p.id}`}`;
const str={type:'string'};
const TOOLS=[
 {name:'list_api_configs',description:'列出 Codex API 切换器中的全部 API 配置（含 Codex 官方登录），标明当前正在使用的配置、接入方式（直连/经本机转换）和默认模型。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'current_api_config',description:'查看 Codex 当前使用的 API 配置与模型。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'list_models',description:'获取某个配置可用的模型列表（只读，不调用模型）。config 为配置名称或 id；“官方”表示 Codex 官方登录。',inputSchema:{type:'object',properties:{config:str},required:['config'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'test_api_config',description:'检测某个配置与模型能否用于 Codex（会向该供应商发一次很小的请求，可能计费），返回直连或经本机转换。',inputSchema:{type:'object',properties:{config:str,model:{type:'string',description:'可选，默认用该配置的默认模型'}},required:['config'],additionalProperties:false}},
 {name:'switch_api_config',description:'把 Codex 切换到指定 API 配置与模型（未检测过会先自动检测，失败则不切换）。配置写入后请完整重启桌面端以载入账号和模型列表，已有对话沿用原设置。config 为“官方”时切回 Codex 官方登录。',inputSchema:{type:'object',properties:{config:str,model:{type:'string',description:'可选，默认用该配置的默认模型'}},required:['config'],additionalProperties:false}},
 {name:'switch_to_official',description:'切回 Codex 官方登录（ChatGPT 账号）。可指定官方模型。配置写入后请完整重启桌面端。',inputSchema:{type:'object',properties:{model:{type:'string'}},additionalProperties:false}},
 {name:'delete_api_config',description:'删除一个 API 配置（含其保存的密钥，不可撤销）。官方登录与 Codex 正在使用的配置不能删除。仅在用户明确要求删除时调用。',inputSchema:{type:'object',properties:{config:str},required:['config'],additionalProperties:false},annotations:{destructiveHint:true}},
 {name:'open_api_manager',description:'在浏览器中打开 Codex API 切换器管理页面，用于新增配置、填写或修改 API 密钥（密钥不要在对话中传递）。',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
async function findConfig(key){const id=svc.findByIdOrName(String(key||'').trim());const s=await svc.state();return s.providers.find(p=>p.id===id)}
async function call(name,args={}){
 switch(name){
  case 'list_api_configs':{const s=await svc.state();return `共 ${s.providers.length} 个配置（▶ 为 Codex 当前配置）：\n`+s.providers.map(describe).join('\n')+(s.adapter.ready?'':'\n\n提示：本机转换服务未运行，“经本机转换”的配置切换时会自动启动它。')}
  case 'current_api_config':{const s=await svc.state();return `Codex 当前配置：${s.current.name}，模型 ${s.current.model||'（默认）'}${s.current.viaAdapter?'（经本机转换服务）':''}。`}
  case 'list_models':{const p=await findConfig(args.config);const r=await svc.actions.models({id:p.id});return `「${p.name}」${r.message}\n`+r.models.join('\n')}
  case 'test_api_config':{const p=await findConfig(args.config);const r=await svc.actions.probe({id:p.id,model:args.model||p.model});return `「${p.name}」模型 ${args.model||p.model}：${r.message}`}
  case 'switch_api_config':{const p=await findConfig(args.config);return (await svc.actions.switch({id:p.id,model:args.model||p.model})).message}
  case 'switch_to_official':return (await svc.actions.switch({id:OFFICIAL,model:args.model})).message;
  case 'delete_api_config':{const p=await findConfig(args.config);return `「${p.name}」`+(await svc.actions.providerRemove({id:p.id})).message}
  case 'open_api_manager':launch(true);return '已在浏览器中打开 Codex API 切换器。请在页面的「API 配置」中新增或修改配置与密钥。';
  default:throw Object.assign(Error('Unknown tool: '+name),{rpc:-32602});
 }
}
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
async function handle(msg){
 if(!msg||msg.jsonrpc!=='2.0'||typeof msg.method!=='string')return;const id=msg.id,reply=result=>id!==undefined&&send({jsonrpc:'2.0',id,result}),fail=(code,message)=>id!==undefined&&send({jsonrpc:'2.0',id,error:{code,message}});
 try{switch(msg.method){
  case 'initialize':return reply({protocolVersion:msg.params?.protocolVersion||'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'codex-api-switcher',title:'Codex API 切换器',version:'1.0.0'},instructions:'管理并切换 Codex 使用的 API 配置。切换会写入本机配置；桌面端需要完整重启以载入账号和模型列表。不要在对话中索取或传递 API 密钥；需要新增或修改密钥时调用 open_api_manager。'});
  case 'ping':return reply({});
  case 'tools/list':return reply({tools:TOOLS});
  case 'tools/call':{const {name,arguments:args}=msg.params||{};if(!TOOLS.some(t=>t.name===name))return fail(-32602,'Unknown tool: '+name);try{return reply({content:[{type:'text',text:await call(name,args||{})}]})}catch(e){return reply({content:[{type:'text',text:'失败：'+String(e.message||e).slice(0,500)}],isError:true})}}
  default:if(msg.method.startsWith('notifications/'))return;return fail(-32601,'Method not found: '+msg.method);
 }}catch(e){fail(-32603,String(e.message||e).slice(0,300))}
}
let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{buf+=d;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n).trim();buf=buf.slice(n+1);if(!line)continue;let msg;try{msg=JSON.parse(line)}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue}handle(msg)}});
process.stdin.on('end',()=>process.exit(0));
process.on('uncaughtException',e=>{try{fs.appendFileSync(path.join(bridgeHome,'mcp-error.log'),new Date().toISOString()+' '+String(e?.stack||e).slice(0,2000)+'\n')}catch{}});
