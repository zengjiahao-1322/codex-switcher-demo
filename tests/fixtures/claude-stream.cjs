'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {startBackend}=require('../backend-process.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,mode='responses') {
  let scenario={kind:'text'},times=[];const requests=[];
  const server=http.createServer(async(q,r)=>{
    let raw='';for await(const chunk of q)raw+=chunk;
    const body=JSON.parse(raw);requests.push({path:q.url,body});const s=scenario;
    if(s.kind==='http-error'){r.writeHead(429,{'content-type':'application/json'});r.end(JSON.stringify({error:{message:'fixture rate limit'}}));return;}
    if(!body.stream){r.setHeader('content-type','application/json');r.end(JSON.stringify(mode==='responses'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'stream-ok'}]}],usage:{input_tokens:12,output_tokens:5}}:{choices:[{message:{content:'stream-ok'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:5}}));return;}
    r.writeHead(200,{'content-type':'text/event-stream'});r.flushHeaders();
    const send=async(v,delay=0)=>{if(delay)await sleep(delay);if(r.destroyed)return;const value=typeof v==='string'?v:JSON.stringify(v);times.push({event:v,at:performance.now()});r.write('data: '+value+'\n\n');};
    const finish=async(reason='stop')=>{
      if(mode==='responses')await send({type:'response.completed',response:{status:reason==='length'?'incomplete':'completed',usage:{input_tokens:12,output_tokens:5,input_tokens_details:{cached_tokens:3}}}});
      else{await send({choices:[{delta:{},finish_reason:reason}]});await send({choices:[],usage:{prompt_tokens:12,completion_tokens:5,prompt_tokens_details:{cached_tokens:3}}});await send('[DONE]');}
      r.end();
    };
    const text=async(v,delay=0)=>send(mode==='responses'?{type:'response.output_text.delta',output_index:0,delta:v}:{choices:[{delta:{content:v},finish_reason:null}]},delay);
    if(s.kind==='text'){for(const v of ['流','式','-','o','k'])await text(v,300);await finish(s.reason);}
    else if(s.kind==='thinking'){await send(mode==='responses'?{type:'response.reasoning_summary_text.delta',output_index:0,delta:'think'}:{choices:[{delta:{reasoning_content:'think'},finish_reason:null}]});await text('answer');await finish();}
    else if(s.kind==='tools'){
      if(mode==='responses'){
        await send({type:'response.output_item.added',output_index:0,item:{type:'function_call',call_id:'call0',name:'Read'}});
        for(const delta of ['{"p', 'ath":', '"x"}'])await send({type:'response.function_call_arguments.delta',output_index:0,delta},15);
        await send({type:'response.output_item.done',output_index:0,item:{type:'function_call',call_id:'call0',name:'Read',arguments:'{"path":"x"}'}});
      }else{
        await send({choices:[{delta:{tool_calls:[{index:1,id:'call1',function:{name:'Write',arguments:'{"b":'}},{index:0,id:'call0',function:{name:'Read',arguments:'{"a":'}}]}}]});
        for(const value of [1,2])for(const index of [1,0])await send({choices:[{delta:{tool_calls:[{index,function:{arguments:value===1?'"x"':'}'}}]}}]},15);
      }
      await finish('tool_calls');
    }else if(s.kind==='disconnect'){await text('partial');await sleep(100);r.destroy();}
    else if(s.kind==='error'){await text('partial');await send(s.event||{error:{message:'fixture midstream failure'}});r.end();}
    else if(s.kind==='eof'){await text('partial');r.end();}
    else if(s.kind==='idle'){await sleep(10200);await text('after idle');await finish();}
    else if(s.kind==='timeout'){await sleep(300);if(!r.destroyed)r.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
  const f=await startBackend(t,{setup({root,bridge,environment}){
    for(const name of ['HOME','USERPROFILE','LOCALAPPDATA','APPDATA','CLAUDE_CONFIG_DIR']){environment[name]=path.join(root,name.toLowerCase());fs.mkdirSync(environment[name],{recursive:true});}
    environment.DISABLE_AUTOUPDATER='1';environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';environment.NO_PROXY='127.0.0.1,localhost';
    fs.writeFileSync(path.join(bridge,'providers.json'),JSON.stringify({providers:[{id:'stream',origin:'custom',name:'Stream fixture',apiMode:mode,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',apiKey:'fixture-only',model:'main',models:['main'],timeoutMs:20000}]}));
    fs.writeFileSync(path.join(bridge,'claude-current.json'),JSON.stringify({providerId:'stream',model:'main',mode:'adapter'}));
    fs.writeFileSync(path.join(bridge,'adapter.json'),JSON.stringify({port:Number(environment.BRIDGE_PORT),token:'fixture-only'}));
  }});
  return {...f,requests,server,set(s){scenario=s;times=[];},times:()=>times,request(body={}){return fetch(f.url.origin+'/v1/messages',{method:'POST',headers:{Authorization:'Bearer fixture-only','Content-Type':'application/json'},body:JSON.stringify({model:'main',messages:[{role:'user',content:'hi'}],max_tokens:32,stream:true,...body}),signal:AbortSignal.timeout(25000)});}};
}
async function collect(response){const rows=[];let buffer='';const decoder=new TextDecoder();for await(const bytes of response.body){buffer+=decoder.decode(bytes,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const raw=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(raw)rows.push({value:JSON.parse(raw),at:performance.now()});}}return rows;}
module.exports={fixture,collect};
