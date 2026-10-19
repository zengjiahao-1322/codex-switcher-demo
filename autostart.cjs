'use strict';
// 当前用户“启动”文件夹中的快捷方式：登录后无窗口启动切换器服务（转换模式需要服务常驻）。可随时关闭，不需要管理员权限。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const NAME='Codex API Switcher Service.lnk',LEGACY='Codex API 切换器服务.lnk';
function startupDir(){return process.env.BRIDGE_STARTUP_DIR||path.join(process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),'Microsoft','Windows','Start Menu','Programs','Startup');}
const linkPath=()=>process.platform==='darwin'?path.join(process.env.BRIDGE_STARTUP_DIR||path.join(os.homedir(),'Library','LaunchAgents'),'com.codex-switcher.demo.plist'):path.join(startupDir(),fs.existsSync(path.join(startupDir(),LEGACY))?LEGACY:NAME);
function status(){return fs.existsSync(linkPath());}
function enable(projectDir=__dirname){
 if(process.platform==='darwin'){
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const data=require('./platform.cjs').dataHome();fs.mkdirSync(data,{recursive:true});fs.mkdirSync(path.dirname(linkPath()),{recursive:true});
  const args=[require('./platform.cjs').nodePath(projectDir),path.join(projectDir,'main.cjs'),'--no-open'];
  fs.writeFileSync(linkPath(),'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.codex-switcher.demo</string><key>ProgramArguments</key><array>'+args.map(s=>'<string>'+esc(s)+'</string>').join('')+'</array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>'+esc(path.join(data,'service.log'))+'</string><key>StandardErrorPath</key><string>'+esc(path.join(data,'service-error.log'))+'</string></dict></plist>');
  return true;
 }
 const vbs=path.join(projectDir,'launch-hidden.vbs');if(!fs.existsSync(vbs))throw Error('缺少 launch-hidden.vbs');fs.mkdirSync(startupDir(),{recursive:true});
 const script="$ErrorActionPreference='Stop';$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:BRIDGE_LNK);$s.TargetPath=(Join-Path $env:SystemRoot 'System32\\wscript.exe');$s.Arguments='\"'+$env:BRIDGE_VBS+'\"';$s.WorkingDirectory=$env:BRIDGE_DIR;$s.Description='Codex API Switcher Service';$s.Save()";
 cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,BRIDGE_LNK:linkPath(),BRIDGE_VBS:vbs,BRIDGE_DIR:projectDir},stdio:'pipe',windowsHide:true});
 if(!status())throw Error('自启动快捷方式创建失败');return true;
}
function disable(){fs.rmSync(linkPath(),{force:true});return !status();}
module.exports={status,enable,disable,linkPath};
