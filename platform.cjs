'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const mac=process.platform==='darwin';
const dataHome=()=>process.env.BRIDGE_HOME||(mac?path.join(os.homedir(),'Library','Application Support','CodexApiSwitcher'):path.join(__dirname,'private'));
const codexHome=()=>process.env.BRIDGE_CODEX_HOME||process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
const nodePath=(dir=__dirname)=>{const file=mac?path.join(dir,'runtime',process.arch,'node'):path.join(dir,'runtime','node.exe');return fs.existsSync(file)?file:process.execPath};
const openUrl=url=>cp.spawn(mac?'open':'explorer.exe',[url],{detached:true,stdio:'ignore',windowsHide:true}).unref();
function launch(open=false){cp.spawn(nodePath(),[path.join(__dirname,'main.cjs'),...(open?[]:['--no-open'])],{detached:true,stdio:'ignore',windowsHide:true}).unref()}
function macApps(){return [process.env.CODEX_DESKTOP_APP,...['/Applications',path.join(os.homedir(),'Applications')].map(dir=>path.join(dir,'Codex.app'))].filter(Boolean)}
module.exports={mac,dataHome,codexHome,nodePath,openUrl,launch,macApps};
