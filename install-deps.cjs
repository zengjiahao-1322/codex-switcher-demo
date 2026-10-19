// Installs the two runtime dependencies into node_modules without npm: pinned versions, sha512 integrity verified,
// extracted with the tar.exe that ships with Windows 10/11.
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto'),os=require('os');
const DEPS=[
 {name:'yaml',version:'2.9.1',integrity:'sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw=='},
 {name:'smol-toml',version:'1.9.1',integrity:'sha512-j7WyPdf0CJoutMzMoPLF/bVXHtKZIT9Rb4eGeEbWw8X2t5oirjPgpL+OpaENZrILYaXqYwnVH+qgUwVbl+pUJQ=='}];
(async()=>{
 for(const d of DEPS){
  const target=path.join(__dirname,'node_modules',d.name);
  try{if(JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8')).version===d.version){console.log(d.name,d.version,'already installed');continue}}catch{}
  const url=`https://registry.npmjs.org/${d.name}/-/${d.name}-${d.version}.tgz`;const res=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!res.ok)throw Error(`download failed ${url}: HTTP ${res.status}`);
  const buf=Buffer.from(await res.arrayBuffer());const [alg,expected]=d.integrity.split('-');if(crypto.createHash(alg).update(buf).digest('base64')!==expected)throw Error(`integrity mismatch for ${d.name}`);
  const tgz=path.join(os.tmpdir(),`${d.name}-${d.version}-${process.pid}.tgz`);fs.writeFileSync(tgz,buf);
  fs.rmSync(target,{recursive:true,force:true});fs.mkdirSync(target,{recursive:true});
  try{cp.execFileSync(process.platform==='win32'?'tar.exe':'tar',['-xzf',tgz,'-C',target,'--strip-components=1'],{stdio:'pipe'})}finally{fs.rmSync(tgz,{force:true})}
  console.log(d.name,d.version,'installed (integrity verified)');
 }
})().catch(e=>{console.error('ERROR:',e.message);process.exit(1)});
