'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {isRust,rustBinary}=require('./backend.cjs');
test('Windows Rust实际zip含离线价格簿和override，打包时不联网',{skip:(!isRust||process.platform!=='win32')&&'Windows Rust zip验收'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-package-'));t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const entries=require('../scripts/rust-release.cjs').entries('Codex Switcher/',10200,'win32','x64',path.dirname(rustBinary()));const zip=path.join(root,'package.zip');require('../src/shared/zip.cjs').zip(entries,zip);
 // 用系统自带的 bsdtar：GitHub 的 Windows 机器上 PATH 里先找到的是 Git 带的 GNU tar，它会把 C: 当成远程主机。
 const tar=path.join(process.env.SystemRoot,'System32','tar.exe');
const {execFileSync}=require('node:child_process');const listing=execFileSync(tar,['-tf',zip],{windowsHide:true,encoding:'utf8'}).trim().split(/\r?\n/);
 for(const name of ['data/prices-overrides.json','data/price-snapshot.json']){assert.ok(listing.includes('Codex Switcher/'+name));const raw=execFileSync(tar,['-xOf',zip,'Codex Switcher/'+name],{windowsHide:true,encoding:'utf8'});assert.deepEqual(JSON.parse(raw),JSON.parse(fs.readFileSync(path.join(__dirname,'..',name))));}
});
