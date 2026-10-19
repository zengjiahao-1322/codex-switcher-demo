'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),net=require('node:net'),assert=require('node:assert/strict');
const target=process.argv[2]||process.platform,archive=path.resolve('dist',target==='darwin'?'codex-switcher-macos-universal.zip':'codex-switcher-windows-x64.zip');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'switcher-package-'));let child,closed;
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})});
(async()=>{try{
 cp.execFileSync(process.platform==='win32'?'tar.exe':'tar',['-xf',archive,'-C',root]);
 const app=target==='darwin'?path.join(root,'Codex Switcher.app','Contents','Resources'):path.join(root,'Codex Switcher'),node=target==='darwin'?path.join(app,'runtime',process.arch,'node'):path.join(app,'runtime','node.exe'),home=path.join(root,'home'),bridge=path.join(root,'private');fs.mkdirSync(home);fs.mkdirSync(bridge);
 fs.writeFileSync(path.join(home,'config.toml'),'model="package-smoke"\n');const env={...process.env,BRIDGE_HOME:bridge,BRIDGE_CODEX_HOME:home,BRIDGE_HERMES_HOME:path.join(root,'no-hermes'),BRIDGE_DISCOVERY_DIR:path.join(root,'discovery'),BRIDGE_PORT:String(await freePort())};
 child=cp.spawn(node,[path.join(app,'main.cjs'),'--no-open'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});closed=new Promise(r=>child.once('close',r));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Packaged service did not start')),20000);let text='';child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('BRIDGE_READY')){clearTimeout(timer);resolve()}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Packaged service exited '+code))})});
 const u=new URL(JSON.parse(fs.readFileSync(path.join(bridge,'running.json'))).url),api=async(name)=>{const response=await fetch(u.origin+'/api/'+name,{method:'POST',headers:{Authorization:'Bearer '+u.hash.slice(1),'Content-Type':'application/json'},body:'{}'});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value};
 assert.equal((await fetch(u.origin+'/')).status,200);assert.equal((await api('accounts')).items.length,0);await api('clients');
 const vsix=await api('companionPackage');const response=await fetch(u.origin+vsix.url);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>1000);
 assert.equal(fs.readFileSync(path.join(home,'config.toml'),'utf8'),'model="package-smoke"\n');
 if(target==='darwin'){
  cp.execFileSync('/usr/bin/plutil',['-lint',path.resolve(app,'..','Info.plist')]);
  cp.execFileSync('/usr/bin/lipo',[path.join(app,'bin','mac-process-context'),'-verify_arch','arm64','x86_64']);
  for(const arch of ['arm64','x64'])assert.ok(fs.statSync(path.join(app,'runtime',arch,'node')).mode&0o111);
 }
 console.log('PASS extracted '+target+' package: service, UI, clients, empty account store, VSIX download, config preserved');
}finally{if(child){child.kill();await closed}await fs.promises.rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100})}})().catch(e=>{console.error(e.message);process.exitCode=1});
