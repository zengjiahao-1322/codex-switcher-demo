'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const activeJob=job=>['queued','preparing','switching','reopening'].includes(job?.status);
const alive=pid=>{if(!pid)return false;try{process.kill(pid,0);return true}catch{return false}};
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}};
const write=(file,data)=>{const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(tmp,file)};
const lockPath=home=>path.join(home,'operation.lock');
function switchJob(home){
 const file=path.join(home,'account-switch.json'),job=read(file);
 if(activeJob(job)&&!alive(job.pid)){job.status='error';job.message='上次账号切换已中断，可以重新选择来源并切换。';write(file,job)}
 return job;
}
function acquire(home){
 const file=lockPath(home);
 if(fs.existsSync(file)){const owner=read(file);if(!owner||alive(owner.pid))throw Error('另一项配置操作或账号切换正在进行，请稍后');fs.unlinkSync(file)}
 let fd;try{fd=fs.openSync(file,'wx',0o600)}catch(e){if(e.code==='EEXIST')throw Error('另一项配置操作或账号切换正在进行，请稍后');throw e}
 try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}))}finally{fs.closeSync(fd)}
}
function handoff(home,pid){write(lockPath(home),{pid})}
function release(home){const file=lockPath(home);if(read(file)?.pid===process.pid)fs.unlinkSync(file)}
function configHash(codexHome){return crypto.createHash('sha256').update(fs.readFileSync(path.join(codexHome,'config.toml'),'utf8')).digest('hex')}
function recordEffect(codexHome,bridgeHome,status,message){const effect={status,message,configHash:configHash(codexHome),at:new Date().toISOString()};write(path.join(bridgeHome,'effect.json'),effect);return effect}
function readEffect(codexHome,bridgeHome){const effect=read(path.join(bridgeHome,'effect.json'));if(!effect)return null;try{return effect.configHash===configHash(codexHome)?effect:null}catch{return null}}
module.exports={activeJob,switchJob,acquire,handoff,release,recordEffect,readEffect};
