const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// Locates the Codex CLI binary bundled with the Codex desktop app (newest build under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe),
// without pinning a version hash. CODEX_EXE overrides the lookup (e.g. a standalone codex.exe).
function findCodex(root=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'OpenAI','Codex','bin')){
 if(process.env.CODEX_EXE&&arguments.length===0){if(fs.existsSync(process.env.CODEX_EXE))return process.env.CODEX_EXE;throw Error('CODEX_EXE 指向的文件不存在：'+process.env.CODEX_EXE)}
 if(process.platform==='darwin'&&arguments.length===0){
  for(const app of require('./platform.cjs').macApps())for(const name of ['codex','bin/codex','resources/codex']){const file=path.join(app,'Contents','Resources',name);if(fs.existsSync(file))return file}
  const extensions=path.join(os.homedir(),'.vscode','extensions');
  if(fs.existsSync(extensions))for(const dir of fs.readdirSync(extensions).filter(n=>n.startsWith('openai.chatgpt-')).reverse())for(const arch of process.arch==='arm64'?['macos-aarch64','darwin-arm64']:['macos-x86_64','darwin-x64']){const file=path.join(extensions,dir,'bin',arch,'codex');if(fs.existsSync(file))return file}
  try{const file=require('node:child_process').execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim();if(file)return fs.realpathSync(file)}catch{}
  throw Error('未找到 Codex。请安装并打开 Codex.app，或设置 CODEX_EXE。');
 }
 let files=[];try{files=fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>path.join(root,x.name,'codex.exe')).filter(x=>fs.existsSync(x))}catch{}
 files.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);if(!files.length)throw Error('找不到 Codex 桌面内置 CLI，请安装或打开 Codex 后重试（或设置环境变量 CODEX_EXE）。');return files[0]}
module.exports={findCodex};
