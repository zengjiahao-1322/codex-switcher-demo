'use strict';
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
function scan(){
 const output=cp.execFileSync('/bin/ps',['-axo','pid=,ppid=,etime=,comm='],{encoding:'utf8',maxBuffer:8*1024*1024});
 const ancestry=output.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/);return m?[{pid:Number(m[1]),parentPid:Number(m[2]),elapsed:m[3],exe:m[4],name:path.basename(m[4])}]:[]});
 const helper=path.join(__dirname,'bin','mac-process-context');
 const processes=ancestry.filter(p=>p.name==='codex').map(p=>{
  let context={ok:false,error:'process_context_helper_missing'};
  if(fs.existsSync(helper)){try{context=JSON.parse(cp.execFileSync(helper,[String(p.pid)],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']}))}catch{context={ok:false,error:'process_access_denied_or_exited'}}}
  const [dayPart,timePart]=p.elapsed.includes('-')?p.elapsed.split('-'):['0',p.elapsed];const segments=timePart.split(':').map(Number);let seconds=0;for(const n of segments)seconds=seconds*60+n;seconds+=Number(dayPart)*86400;
  return {...p,context,startedAt:new Date(Date.now()-seconds*1000).toISOString()};
 });
 return {ancestry,processes};
}
module.exports={scan};
