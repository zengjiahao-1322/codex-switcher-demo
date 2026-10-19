'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
test('ZIP packages preserve filenames and executable bits',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switcher-zip-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'test.zip');require('./zip.cjs').zip([{name:'Demo.app/Contents/MacOS/start',data:'#!/bin/sh\nexit 0\n',mode:0o100755},{name:'extension/package.json',data:'{"name":"test"}'}],file);
 cp.execFileSync(process.platform==='win32'?'tar.exe':'tar',['-xf',file,'-C',root]);assert.equal(fs.readFileSync(path.join(root,'extension','package.json'),'utf8'),'{"name":"test"}');if(process.platform!=='win32')assert.ok(fs.statSync(path.join(root,'Demo.app/Contents/MacOS/start')).mode&0o111);
});
test('macOS helper reads actual process home without exposing unrelated environment',{skip:process.platform!=='darwin'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switcher-mac-'));const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{env:{...process.env,CODEX_HOME:root,SWITCHER_PRIVATE_SENTINEL:'must-not-leak'},stdio:'ignore'});const closed=new Promise(r=>child.once('close',r));
 try{const text=cp.execFileSync(path.join(__dirname,'bin/mac-process-context'),[String(child.pid)],{encoding:'utf8'}),context=JSON.parse(text);assert.equal(context.ok,true);assert.equal(context.home,root);assert.equal(text.includes('must-not-leak'),false)}finally{child.kill();await closed;fs.rmSync(root,{recursive:true,force:true})}
});
