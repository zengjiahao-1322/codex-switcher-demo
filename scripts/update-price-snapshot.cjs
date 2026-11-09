'use strict';
// Release-time operation only. Packaging and CI read the saved snapshot offline.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const vendors=['openai','anthropic','google','deepseek','x-ai','qwen','moonshotai','z-ai'];
const output=path.resolve(process.argv[2]||path.join(__dirname,'../data/price-snapshot.json'));
const raw=execFileSync(process.platform==='win32'?'curl.exe':'curl',['--fail','--location','--silent','--show-error','--max-time','30','https://openrouter.ai/api/v1/models'],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
const data=JSON.parse(raw);if(!Array.isArray(data.data))throw Error('OpenRouter response missing data');
const models=data.data.filter(m=>vendors.includes(m.id.split('/')[0])&&!m.id.includes(':')).map(m=>({id:m.id,pricing:m.pricing}));
if(!models.length)throw Error('No supported model prices');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({source:'openrouter',fetchedAt:new Date().toISOString(),version:1,models,error:null,errorAt:null},null,2)+'\n');console.log(JSON.stringify({output,models:models.length,responseBytes:Buffer.byteLength(raw)}));
