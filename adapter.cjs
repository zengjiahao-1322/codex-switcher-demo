'use strict';
/**
 * Stateless Responses -> Chat Completions / Anthropic Messages adapter for Codex.
 * Node >=22; no packages. Integration:
 *   const {handleResponses}=require('./adapter.cjs');
 *   await handleResponses(req,res,trustedProvider,optionalTrustedModel);
 * provider: {baseUrl,apiMode:'chat_completions'|'anthropic_messages',apiKey,model,timeoutMs?,maxTokens?}.
 * Chat: baseUrl + '/chat/completions'. Anthropic: baseUrl + '/v1/messages' (or '/messages' if baseUrl ends in /v1).
 * Never select provider credentials/baseUrl/model from the request.
 *
 * Shaped after real Codex requests (verification/codex-request-capture.json):
 *  - reasoning.summary / reasoning.effort, include (reasoning.encrypted_content), prompt_cache_key,
 *    client_metadata, parallel_tool_calls, store:false, text.verbosity: accepted and ignored.
 *    No reasoning items are ever returned, so Codex never sends encrypted reasoning back.
 *  - namespace tools are flattened to `<namespace>__<name>` functions and mapped back (function_call.namespace).
 *  - custom (freeform, e.g. apply_patch) tools become a function with one string argument `input`
 *    and are mapped back to custom_tool_call items.
 *  - built-in tools (web_search, image_generation, ...) cannot be adapted and are dropped
 *    (listed in the X-Bridge-Dropped-Tools header).
 *  - history items Codex may replay that carry no adaptable content (reasoning, web_search_call,
 *    compaction, ...) are skipped. Images in user messages are forwarded; images in tool outputs become a text note.
 * SSE is buffered (upstream non-streaming); while waiting, response.in_progress heartbeats keep Codex's
 * idle timer alive. Errors before the first heartbeat keep their HTTP status (so Codex can retry);
 * later errors are reported as response.failed. Upstream bodies are never exposed; redirects forbidden.
 */
const {randomUUID}=require('node:crypto');
const id=p=>p+'_'+randomUUID().replaceAll('-','');
function bad(message){throw Object.assign(new Error(message),{status:400});}
function object(x){return x!==null&&typeof x==='object'&&!Array.isArray(x);}
function args(s){try{const a=JSON.parse(s);if(!object(a))bad('Function arguments must encode an object');return a;}catch{bad('Function arguments must encode a JSON object');}}
const SKIPPED_ITEMS=new Set(['reasoning','web_search_call','image_generation_call','compaction','context_compaction','compaction_trigger','configuration_update','tool_search_call','tool_search_output','additional_tools','other']);
const NAME=/^[A-Za-z0-9_-]{1,64}$/;
// Chat/Anthropic tool names: [A-Za-z0-9_-]{1,64}. Real Codex MCP namespaces exceed this (e.g. mcp__codex_apps__…),
// so over-long or invalid names get a deterministic alias (truncated + hash); the same alias is derived for history items.
const alias=flat=>NAME.test(flat)?flat:String(flat).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,55)+'_'+require('node:crypto').createHash('sha256').update(String(flat)).digest('hex').slice(0,8);

// Flatten Codex tools into plain functions; remember how to map names back.
function toolsFor(b){
 const functions=[],back=new Map(),dropped=[];
 const add=(t,namespace)=>{
  const flat=alias(namespace?namespace+'__'+t.name:t.name);if(['function','custom'].includes(t.type)&&back.has(flat))bad('Duplicate tool name after adaptation: '+flat);
  if(t.type==='function'){if(t.parameters!==undefined&&!object(t.parameters))bad('Function parameters must be an object schema');functions.push({name:flat,description:t.description||'',parameters:t.parameters||{type:'object',properties:{}},strict:t.strict===true});back.set(flat,{kind:'function',name:t.name,namespace});}
  else if(t.type==='custom'){const f=t.format;const grammar=f&&f.type==='grammar'&&typeof f.definition==='string'?`\n\nThe \`input\` argument is raw text that must follow this ${f.syntax||''} grammar exactly:\n${f.definition}`:'';functions.push({name:flat,description:(t.description||'')+grammar,parameters:{type:'object',properties:{input:{type:'string',description:'Raw tool input text'}},required:['input'],additionalProperties:false},strict:false});back.set(flat,{kind:'custom',name:t.name,namespace});}
  else dropped.push(t.type+(t.name?':'+t.name:''));
 };
 for(const t of b.tools||[]){if(!object(t)||typeof t.type!=='string')bad('Invalid tool');if(t.type==='namespace'){if(typeof t.name!=='string'||!Array.isArray(t.tools))bad('Invalid namespace tool');for(const inner of t.tools){if(!object(inner))bad('Invalid namespace tool');add(inner,t.name);}}else if(['function','custom'].includes(t.type)&&typeof t.name!=='string')bad('Tool name required');else add(t,null);}
 return {functions,back,dropped};
}
const flatName=(name,namespace)=>alias(namespace?namespace+'__'+name:name);
function outputText(o){if(typeof o==='string')return o;if(Array.isArray(o))return o.map(p=>object(p)&&typeof p.text==='string'?p.text:object(p)&&p.type==='input_image'?'[image omitted by bridge]':'').join('\n');if(object(o)&&typeof o.content==='string')return o.content;bad('Unsupported tool output');}
function partsFor(content){
 if(typeof content==='string')return [{type:'text',text:content}];
 if(!Array.isArray(content))bad('Message content must be text or parts');
 return content.map(p=>{if(!object(p))bad('Invalid content part');if(['input_text','output_text'].includes(p.type)&&typeof p.text==='string')return {type:'text',text:p.text};if(p.type==='refusal'&&typeof p.refusal==='string')return {type:'text',text:p.refusal};if(p.type==='input_image'){const url=typeof p.image_url==='string'?p.image_url:p.image_url?.url;if(typeof url!=='string'||!url)bad('Image part needs image_url');return {type:'image',url};}bad('Unsupported content part: '+p.type);});
}
function validate(b){
 if(!object(b))bad('Body must be a JSON object');
 if(b.instructions!=null&&typeof b.instructions!=='string')bad('instructions must be text');
 if(typeof b.input!=='string'&&!Array.isArray(b.input))bad('input must be text or an array');
 if(b.previous_response_id||b.conversation||b.background===true||b.store===true)bad('Stateful/background/stored responses are unsupported');
 if(b.text?.format&&b.text.format.type!=='text')bad('Structured output is unsupported');
 if(b.stream!==undefined&&typeof b.stream!=='boolean')bad('stream must be boolean');
 if(b.max_output_tokens!=null&&(!Number.isInteger(b.max_output_tokens)||b.max_output_tokens<1))bad('max_output_tokens must be a positive integer');
 if(b.tools!==undefined&&!Array.isArray(b.tools))bad('tools must be an array');
 if(b.tool_choice!==undefined&&!['auto','none','required'].includes(b.tool_choice)&&!(object(b.tool_choice)&&b.tool_choice.type==='function'&&typeof b.tool_choice.name==='string'))bad('Unsupported tool_choice');
}
// Neutral conversation: [{role:'system'|'user'|'assistant', parts}|{role:'assistant',calls}|{role:'tool',callId,text}]
function conversationFor(b){
 const out=[];if(b.instructions)out.push({role:'system',parts:[{type:'text',text:b.instructions}]});
 for(const item of typeof b.input==='string'?[{role:'user',content:b.input}]:b.input){
  if(!object(item))bad('Invalid input item');
  const type=item.type||'message';
  if(SKIPPED_ITEMS.has(type))continue;
  if(type==='function_call'||type==='custom_tool_call'){
   if(typeof item.call_id!=='string'||!item.call_id||typeof item.name!=='string')bad('Invalid tool call');
   let a;if(type==='function_call'){if(typeof item.arguments!=='string')bad('Invalid function call');args(item.arguments);a=item.arguments;}else{if(typeof item.input!=='string')bad('Invalid custom tool call');a=JSON.stringify({input:item.input});}
   const call={id:item.call_id,name:flatName(item.name,item.namespace),arguments:a};
   if(out.at(-1)?.calls)out.at(-1).calls.push(call);else out.push({role:'assistant',calls:[call]});
  }
  else if(type==='function_call_output'||type==='custom_tool_call_output'){if(typeof item.call_id!=='string'||!item.call_id)bad('Tool output needs call_id');out.push({role:'tool',callId:item.call_id,text:outputText(item.output)});}
  else if(type==='message'){
   if(!['user','assistant','system','developer'].includes(item.role))bad('Unsupported message role');
   out.push({role:item.role==='developer'?'system':item.role,parts:partsFor(item.content)});
  }
  else bad('Unsupported input item type: '+type);
 }
 return out;
}
function chatMessages(conv){return conv.map(m=>{
 if(m.calls)return {role:'assistant',content:null,tool_calls:m.calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:c.arguments}}))};
 if(m.role==='tool')return {role:'tool',tool_call_id:m.callId,content:m.text};
 const images=m.parts.some(p=>p.type==='image');
 if(!images||m.role!=='user')return {role:m.role,content:m.parts.map(p=>p.type==='text'?p.text:'[image omitted by bridge]').join('\n')};
 return {role:m.role,content:m.parts.map(p=>p.type==='text'?{type:'text',text:p.text}:{type:'image_url',image_url:{url:p.url}})};
});}
function anthropicImage(url){const m=/^data:([^;,]+);base64,(.*)$/s.exec(url);return m?{type:'image',source:{type:'base64',media_type:m[1],data:m[2]}}:{type:'image',source:{type:'url',url}};}
function anthropicPayload(conv){
 const system=conv.filter(m=>m.role==='system').map(m=>m.parts.map(p=>p.type==='text'?p.text:'').join('\n')).join('\n\n')||undefined;
 const messages=conv.filter(m=>m.role!=='system').map(m=>m.calls?{role:'assistant',content:m.calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:JSON.parse(c.arguments)}))}:m.role==='tool'?{role:'user',content:[{type:'tool_result',tool_use_id:m.callId,content:m.text}]}:{role:m.role,content:m.parts.map(p=>p.type==='text'?{type:'text',text:p.text}:anthropicImage(p.url)).filter(p=>p.type!=='text'||p.text)})
  .filter(m=>m.content.length).reduce((out,m)=>{if(out.at(-1)?.role===m.role)out.at(-1).content.push(...m.content);else out.push(m);return out;},[]);
 return {system,messages};
}
function outputFor(j,back){const m=j.choices?.[0]?.message;if(!object(m))throw new Error('Malformed upstream output');const output=[];
 if(m.content!=null&&typeof m.content!=='string'||m.function_call||m.audio)throw new Error('Unsupported visible upstream output');
 if(m.content)output.push({id:id('msg'),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:m.content,annotations:[]}]});
 for(const t of m.tool_calls||[]){
  if(typeof t.id!=='string'||!t.id||typeof t.function?.name!=='string'||typeof t.function.arguments!=='string')throw new Error('Malformed tool call');
  let a;try{a=JSON.parse(t.function.arguments||'{}');if(!object(a))throw new Error();}catch{throw new Error('Malformed upstream arguments');}
  const target=back.get(t.function.name)||{kind:'function',name:t.function.name,namespace:null};
  if(target.kind==='custom'){if(typeof a.input!=='string')throw new Error('Malformed custom tool input');output.push({id:id('ctc'),type:'custom_tool_call',status:'completed',call_id:t.id,name:target.name,input:a.input});}
  else output.push({id:id('fc'),type:'function_call',status:'completed',call_id:t.id,name:target.name,...(target.namespace?{namespace:target.namespace}:{}),arguments:t.function.arguments||'{}'});
 }
 return output;
}
function sseWriter(res){let n=0,started=false;const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:n++,...data})}\n\n`);
 return {get started(){return started},start(initial){if(started)return;started=true;res.statusCode=200;res.setHeader('content-type','text/event-stream; charset=utf-8');res.setHeader('cache-control','no-cache');res.setHeader('x-bridge-streaming','buffered');event('response.created',{response:initial});event('response.in_progress',{response:initial});},heartbeat(initial){event('response.in_progress',{response:initial});},event};
}
function emit(w,response){
 response.output.forEach((item,output_index)=>{
  const common={item_id:item.id,output_index};
  if(item.type==='message'){w.event('response.output_item.added',{output_index,item:{...item,status:'in_progress',content:[]}});item.content.forEach((part,content_index)=>{const at={...common,content_index};w.event('response.content_part.added',{...at,part:{...part,text:''}});w.event('response.output_text.delta',{...at,delta:part.text});w.event('response.output_text.done',{...at,text:part.text});w.event('response.content_part.done',{...at,part});});}
  else if(item.type==='function_call'){w.event('response.output_item.added',{output_index,item:{...item,status:'in_progress',arguments:''}});w.event('response.function_call_arguments.delta',{...common,delta:item.arguments});w.event('response.function_call_arguments.done',{...common,arguments:item.arguments});}
  else{w.event('response.output_item.added',{output_index,item:{...item,status:'in_progress',input:''}});w.event('response.custom_tool_call_input.delta',{...common,delta:item.input});w.event('response.custom_tool_call_input.done',{...common,input:item.input});}
  w.event('response.output_item.done',{output_index,item});
 });
 w.event('response.'+response.status,{response});
}
// options.onError(message): optional local diagnostics hook; receives the internal error text (never upstream bodies).
async function handleResponses(req,res,provider,model,options={}){
 const controller=new AbortController();let timedOut=false,heartbeat;
 const cancel=()=>{if(!res.writableEnded)controller.abort();};
 req.on('aborted',cancel);res.on('close',cancel);
 const timeout=Number.isFinite(provider.timeoutMs)&&provider.timeoutMs>0?provider.timeoutMs:600000;
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);timer.unref();
 const w=sseWriter(res);let stream=false,initial;
 try{
  let b=req.body;
  if(b===undefined){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>64*1024*1024)throw Object.assign(new Error('Request body too large'),{status:413});chunks.push(Buffer.from(c));}try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{bad('Malformed JSON');}}
  validate(b);
  if(!['chat_completions','anthropic_messages'].includes(provider.apiMode))bad('Unsupported provider apiMode');
  const {functions,back,dropped}=toolsFor(b);const conv=conversationFor(b);
  if(object(b.tool_choice)&&!back.has(alias(b.tool_choice.name)))bad('Selected tool is not defined');
  if(dropped.length)res.setHeader('x-bridge-dropped-tools',dropped.join(',').slice(0,500));
  const anthropic=provider.apiMode==='anthropic_messages';const useModel=model||provider.model;let payload;
  if(anthropic){
   payload={model:useModel,...anthropicPayload(conv),max_tokens:b.max_output_tokens||provider.maxTokens||32000,stream:false};
   if(functions.length&&b.tool_choice!=='none'){payload.tools=functions.map(f=>({name:f.name,description:f.description,input_schema:f.parameters}));if(b.tool_choice==='required')payload.tool_choice={type:'any'};else if(object(b.tool_choice))payload.tool_choice={type:'tool',name:alias(b.tool_choice.name)};}
  }else{
   payload={model:useModel,messages:chatMessages(conv),stream:false};
   if(functions.length){payload.tools=functions.map(f=>({type:'function',function:{name:f.name,description:f.description,parameters:f.parameters,...(f.strict?{strict:true}:{})}}));if(b.tool_choice)payload.tool_choice=typeof b.tool_choice==='string'?b.tool_choice:{type:'function',function:{name:alias(b.tool_choice.name)}};}
   if(b.max_output_tokens)payload.max_completion_tokens=b.max_output_tokens;
  }
  stream=b.stream===true;
  initial={id:id('resp'),object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',error:null,model:useModel,output:[],usage:null};
  // 等待上游期间：5 秒后开始 SSE，之后每 10 秒发送 in_progress 心跳。
  if(stream){let first=true;heartbeat=setInterval(()=>{if(res.writableEnded)return;if(!w.started)w.start(initial);else w.heartbeat(initial);if(first){first=false;clearInterval(heartbeat);heartbeat=setInterval(()=>{if(!res.writableEnded)w.heartbeat(initial)},10000);heartbeat.unref();}},5000);heartbeat.unref();}
  const base=provider.baseUrl.replace(/\/$/,'');
  const url=anthropic?(/\/v1$/.test(base)?base+'/messages':base+'/v1/messages'):base+'/chat/completions';
  const r=await fetch(url,{method:'POST',headers:anthropic?{'content-type':'application/json','x-api-key':provider.apiKey,'anthropic-version':'2023-06-01'}:{'content-type':'application/json',authorization:`Bearer ${provider.apiKey}`},body:JSON.stringify(payload),redirect:'error',signal:controller.signal});
  if(!r.ok){await r.body?.cancel();throw Object.assign(new Error('Upstream HTTP '+r.status),{status:r.status>=400?r.status:502,upstream:true});}
  let j=await r.json();
  const reason=anthropic?j.stop_reason:j.choices?.[0]?.finish_reason;
  const incomplete=['length','max_tokens','content_filter'].includes(reason);
  if(anthropic){
   if(!Array.isArray(j.content)||j.content.some(c=>!['text','tool_use','thinking','redacted_thinking'].includes(c.type)))throw new Error('Unsupported Anthropic output');
   const u=j.usage||{};j={choices:[{message:{content:j.content.filter(c=>c.type==='text').map(c=>c.text).join('')||null,tool_calls:j.content.filter(c=>c.type==='tool_use').map(c=>({id:c.id,function:{name:c.name,arguments:JSON.stringify(c.input??{})}}))}}],usage:{prompt_tokens:u.input_tokens||0,completion_tokens:u.output_tokens||0,total_tokens:(u.input_tokens||0)+(u.output_tokens||0)}};
  }
  const u=j.usage||{};
  const response={...initial,status:incomplete?'incomplete':'completed',incomplete_details:incomplete?{reason:reason==='content_filter'?'content_filter':'max_output_tokens'}:null,output:outputFor(j,back),usage:{input_tokens:u.prompt_tokens||0,output_tokens:u.completion_tokens||0,total_tokens:u.total_tokens||((u.prompt_tokens||0)+(u.completion_tokens||0))}};
  clearInterval(heartbeat);
  if(!stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(response));return;}
  w.start(initial);emit(w,response);res.end();
 }catch(e){
  clearInterval(heartbeat);
  try{options.onError?.(timedOut?'timeout':String(e.name==='AbortError'?'aborted':e.message).slice(0,300))}catch{}
  if(res.destroyed||res.writableEnded)return;
  const message=timedOut?'Upstream request timed out':e.upstream?e.message:e.status===400?e.message:'Upstream request failed or returned unsupported data';
  if(w.started){w.event('response.failed',{response:{...initial,status:'failed',error:{code:e.status===429?'rate_limit_exceeded':'server_error',message}}});res.end();return;}
  res.statusCode=timedOut?504:(e.status||502);res.setHeader('content-type','application/json');
  res.end(JSON.stringify({error:{message,type:e.status===400&&!e.upstream?'invalid_request_error':'api_error'}}));
 }finally{clearTimeout(timer);clearInterval(heartbeat);req.off('aborted',cancel);res.off('close',cancel);}
}
module.exports={handleResponses};
