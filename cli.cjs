// 命令行辅助（供 uninstall.ps1 使用）：
//   node cli.cjs status        显示 Codex 当前是否在使用本工具的配置
//   node cli.cjs restore       切回 Codex 官方登录
//   node cli.cjs cleanup       移除 Codex 配置中本工具写入的供应商定义与模型目录，并关闭开机自启（要求已切回官方）
const path=require('path'),os=require('os'),fs=require('fs'),toml=require('smol-toml');const core=require('./core.cjs'),autostart=require('./autostart.cjs');
const codexHome=require('./platform.cjs').codexHome(),bridgeHome=require('./platform.cjs').dataHome();
const operation=require('./switch-state.cjs');let locked=false;
const bridged=()=>{try{return toml.parse(fs.readFileSync(path.join(codexHome,'config.toml'),'utf8')).model_provider==='hermes_bridge'}catch{return false}};
try{
 if(['restore','cleanup'].includes(process.argv[2])){if(operation.activeJob(operation.switchJob(bridgeHome)))throw Error('账号切换正在进行，请稍后');operation.acquire(bridgeHome);locked=true}
 switch(process.argv[2]){
  case 'status':console.log(bridged()?'BRIDGED':'OFFICIAL');break;
  case 'restore':{const r=core.restoreOfficial(codexHome,bridgeHome);fs.rmSync(path.join(bridgeHome,'current.json'),{force:true});if(!r.alreadyOfficial)operation.recordEffect(codexHome,bridgeHome,'restart_required','配置已应用。请完整退出并重新打开桌面端，以载入账号与模型列表。');console.log(r.alreadyOfficial?'Codex already uses its official login.':'Restored Codex official login (model '+r.model+').');break}
  case 'cleanup':{const r=core.cleanupBridge(codexHome,path.join(bridgeHome,'model-catalog.json'));autostart.disable();console.log(r.changed?'Removed the switcher provider definition from Codex config.':'Codex config had nothing to clean.');break}
  default:console.log('usage: node cli.cjs status|restore|cleanup');process.exitCode=2;
 }
}catch(e){console.error('ERROR: '+e.message);process.exitCode=1}finally{if(locked)operation.release(bridgeHome)}
