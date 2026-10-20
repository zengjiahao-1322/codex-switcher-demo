'use strict';
const path = require('node:path'),
  fs = require('node:fs'),
  cp = require('node:child_process');
const { createAccounts, writeJson } = require('./accounts.cjs');
const { handoff, release, recordEffect } = require('./switch-state.cjs');
function powershell(script, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.PSModulePath;
  try {
    return cp
      .execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference='Stop';try {" +
            script +
            '} catch {[Console]::Error.WriteLine($_.Exception.Message);exit 1}',
        ],
        { encoding: 'utf8', windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      .trim();
  } catch (e) {
    throw Error(
      String(e.stderr || '').trim() || '桌面端操作失败（PowerShell 退出码 ' + e.status + '）。',
    );
  }
}
function desktopInfo() {
  if (process.platform === 'darwin') {
    const inventory = require('./client-status.cjs').scan();
    const running = inventory.ancestry.find((p) =>
      /\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(p.exe || ''),
    );
    if (running) return { exe: running.exe };
    for (const app of require('./platform.cjs').macApps())
      for (const name of ['Codex', 'ChatGPT']) {
        const exe = path.join(app, 'Contents', 'MacOS', name);
        if (fs.existsSync(exe)) return { exe };
      }
    return null;
  }
  return JSON.parse(
    powershell(
      "$p=Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object {$_.Path -like '*OpenAI.Codex*'} | Select-Object -First 1; if($p){@{exe=$p.Path} | ConvertTo-Json -Compress}else{$pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1;if($pkg){@{exe=(Join-Path $pkg.InstallLocation 'app\\ChatGPT.exe')} | ConvertTo-Json -Compress}else{'null'}}",
    ),
  );
}
function stopDesktop(exe, codexHome) {
  if (process.platform === 'darwin') return stopMacDesktop(exe, codexHome);
  const targetIds = codexHome
    ? require('./client-status.cjs').desktopTargets(exe, codexHome)
    : null;
  powershell(
    `
 $restricted=$env:SWITCHER_DESKTOP_IDS -ne '*';$allowed=@($env:SWITCHER_DESKTOP_IDS.Split(',') | Where-Object {$_} | ForEach-Object {[int]$_});
 $p=@(Get-Process | Where-Object {$_.Path -eq $env:SWITCHER_DESKTOP_EXE -and (-not $restricted -or $_.Id -in $allowed)});
 $desktopIds=@($p.Id);
 $backendIds=@(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object {$_.ParentProcessId -in $desktopIds} | Select-Object -ExpandProperty ProcessId);
 foreach($item in $p){if($item.MainWindowHandle -ne 0){[void]$item.CloseMainWindow()}};
 for($i=0;$i -lt 20;$i++){
   if(-not ($desktopIds.Count+$backendIds.Count)){break};
   $waiting=@(Get-Process -Id @($desktopIds+$backendIds) -ErrorAction SilentlyContinue);
   if(-not $waiting.Count){break};Start-Sleep -Milliseconds 100
 };
 Get-Process | Where-Object {($_.Path -eq $env:SWITCHER_DESKTOP_EXE -and (-not $restricted -or $_.Id -in $allowed)) -or $_.Id -in $backendIds} | Stop-Process -Force -ErrorAction SilentlyContinue;
 $remaining=@(Get-Process | Where-Object {($_.Path -eq $env:SWITCHER_DESKTOP_EXE -and (-not $restricted -or $_.Id -in $allowed)) -or $_.Id -in $backendIds});
 if($remaining.Count){throw 'Codex 桌面端仍在运行，请关闭桌面端后重试。'}
 `,
    { SWITCHER_DESKTOP_EXE: exe, SWITCHER_DESKTOP_IDS: targetIds ? targetIds.join(',') : '*' },
  );
}
function openWindowsDesktop() {
  powershell(
    "$pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1;Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$pkg.PackageFamilyName+'!App')",
  );
}
async function stopMacDesktop(exe, codexHome) {
  const status = require('./client-status.cjs'),
    roots = status.desktopTargets(exe, codexHome),
    inventory = status.scan(),
    ids = new Set(roots);
  for (let pass = 0; pass < 8; pass++)
    for (const p of inventory.ancestry) if (ids.has(p.parentPid)) ids.add(p.pid);
  const signal = (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  };
  for (const pid of roots) signal(pid, 'SIGTERM');
  // 客户端提前退出就继续，仍给正在保存状态的进程保留原有等待上限。
  for (let attempt = 0; attempt < 15; attempt++) {
    const remaining = [...ids].some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        if (e.code === 'ESRCH') return false;
        throw e;
      }
    });
    if (!remaining) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const pid of [...ids].reverse()) signal(pid, 'SIGKILL');
}
function openDesktop(exe, home) {
  if (process.platform === 'darwin') {
    cp.spawn(exe, [], {
      env: { ...process.env, CODEX_HOME: home },
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  return openWindowsDesktop();
}
async function runSwitch(
  job,
  {
    stop = stopDesktop,
    open = openDesktop,
    accounts = createAccounts(job),
    syncThreads = require('./thread-routing.cjs').synchronizeThreads,
  } = {},
) {
  // desktopExe 为 null 表示只有 IDE / CLI：应用配置并请求匹配窗口重载，
  // 不调用桌面端关闭与启动流程。两种模式共用账号准备和配置应用逻辑。
  const file = path.join(job.bridgeHome, 'account-switch.json');
  const api = job.kind === 'api',
    desktop = job.desktopExe !== null;
  let prepared,
    stoppedEditors = [],
    applied = false;
  const startedAt = new Date().toISOString(),
    started = performance.now(),
    steps = [];
  let currentStatus = 'preparing';
  const report = (status, message, details = {}) => {
    currentStatus = status;
    writeJson(file, {
      id: job.id,
      pid: process.pid,
      status,
      message,
      startedAt,
      elapsedMs: Math.round(performance.now() - started),
      steps,
      configurationApplied: applied,
      ...details,
      ...(['done', 'error'].includes(status) ? { finishedAt: new Date().toISOString() } : {}),
    });
  };
  // 每步只记录实际执行结果；桌面打开请求与窗口重载完成分别展示。
  const step = async (id, label, action) => {
    const item = { id, label, status: 'running' },
      begin = performance.now();
    steps.push(item);
    report(currentStatus, label + '…');
    try {
      const result = await action();
      item.status = 'done';
      return result;
    } catch (error) {
      item.status = 'error';
      throw error;
    } finally {
      item.durationMs = Math.round(performance.now() - begin);
    }
  };
  report('preparing', api ? '正在检查 API 和模型列表…' : '正在准备目标账号登录…');
  try {
    // 后台切换进程是新实例，先读取实际凭据存储，避免漏存 Mac 钥匙串账号。
    await step('prepare', api ? '检查 API 和准备模型' : '准备账号登录', async () => {
      await accounts.syncCurrent({ force: true });
      if (api) prepared = await require('./service.cjs').createService(job).prepareApi(job);
      else await accounts.prepare(job.id);
    });
    currentStatus = 'switching';
    if (desktop) await step('stop', '关闭目标桌面端', () => stop(job.desktopExe, job.codexHome));
    // 退出前官方客户端可能刚刷新令牌；应用目标配置前再保存一次最新登录。
    const result = await step('apply', '保存并应用目标配置', async () => {
      await accounts.syncCurrent({ force: true });
      const value = api
        ? (accounts.captureCurrent(), prepared.apply())
        : accounts.apply(job.id, job.model, job.catalog);
      applied = true;
      return value;
    });
    const target = require('smol-toml').parse(
      fs.readFileSync(path.join(job.codexHome, 'config.toml'), 'utf8'),
    );
    if (
      job.reloadEditors !== false &&
      require('./thread-routing.cjs').pendingThreads(
        job.codexHome,
        target.model_provider || 'openai',
        target.model,
      ).length
    )
      stoppedEditors = await step('editors', '释放共用配置的编辑器会话', () =>
        require('./client-status.cjs').stopEditorBackends(job.codexHome, job.bridgeHome),
      );
    recordEffect(
      job.codexHome,
      job.bridgeHome,
      'thread_sync_pending',
      '配置已写入，正在同步旧对话，尚未完成切换。',
    );
    // 新旧对话共用一次切换：先持久保存旧会话来源，再让客户端重新加载。
    const threadRouting = await step('threads', '同步并核对旧对话', () =>
      syncThreads({
        codexHome: job.codexHome,
        bridgeHome: job.bridgeHome,
        onProgress: ({ completed, total, phase }) =>
          report(
            'switching',
            (phase === 'verify' ? '正在核对旧对话持久结果' : '正在同步旧对话来源') +
              '（' +
              completed +
              '/' +
              total +
              '）…',
          ),
      }),
    );
    recordEffect(
      job.codexHome,
      job.bridgeHome,
      'restart_required',
      '配置已应用，桌面端尚未重新打开。',
    );
    if (desktop) {
      currentStatus = 'reopening';
      await step('reopen', '请求重新打开桌面端', () => open(job.desktopExe, job.codexHome));
    }
    let editorNote = '';
    let editorReload = null;
    if (job.reloadEditors !== false) {
      try {
        const reloaded = await step('reload', '发送编辑器重载请求', () =>
          require('./client-status.cjs').requestReload(job.codexHome, job.bridgeHome, {
            stoppedEditors,
          }),
        );
        editorReload = reloaded;
        if (reloaded.count || reloaded.detectedEditors || reloaded.connectedEditors) {
          editorNote = ' ' + reloaded.message;
        }
      } catch {
        editorNote = ' 编辑器重载请求未发送，可在客户端列表重试。';
      }
    } else {
      editorNote = ' 本次未重载编辑器；完成任务后请手动重载需要更新的窗口。';
    }
    const effect = desktop
      ? '已请求重新打开桌面端。'
      : '已同步新旧对话；未接入伴随扩展的编辑器窗口请执行“重载窗口”。';
    recordEffect(
      job.codexHome,
      job.bridgeHome,
      'reopen_requested',
      '配置已应用，' + effect + editorNote + ' CLI 请重新启动。',
    );
    report(
      'done',
      '已应用 ' +
        (api ? prepared.label + ' · ' + job.model : result.label + ' 的官方配置') +
        '。' +
        effect +
        editorNote +
        ' 已同步 ' +
        threadRouting.count +
        ' 条旧对话的设置。' +
        (api && !result.catalogCount
          ? ' 未生成模型目录，下拉可能仍显示官方列表；实际使用所选模型。'
          : ''),
      { editorReload, threadRouting, desktopRequested: desktop },
    );
    return { ...result, threadRouting };
  } catch (e) {
    if (applied)
      recordEffect(job.codexHome, job.bridgeHome, 'switch_incomplete', '切换未完成：' + e.message);
    report(
      'error',
      (applied ? '配置已应用，但旧对话同步或客户端重新加载未完成：' : '切换未完成：') + e.message,
    );
    throw e;
  } finally {
    prepared?.cleanup();
    release(job.bridgeHome);
  }
}
function scheduleSwitch(job) {
  const status = require('./client-status.cjs').clientStatus(job.codexHome, job.bridgeHome);
  const desktops = status.clients.filter((client) => client.kind === 'desktop');
  const matchingDesktop = desktops.some((client) => client.confirmed && client.shared);
  const matchingEditor = status.clients.some(
    (client) => ['ide', 'editor'].includes(client.kind) && client.confirmed && client.shared,
  );
  // 正在运行的独立桌面环境不跟着插件配置重启。只使用插件时也不额外打开桌面版。
  if (desktops.some((client) => !client.confirmed)) {
    throw Error('尚未读到桌面端的配置目录，请先在客户端列表核对进程读取错误。');
  }
  const info = matchingDesktop || (!desktops.length && !matchingEditor) ? desktopInfo() : null;
  job = { ...job, desktopExe: info?.exe || null };
  const file = path.join(job.bridgeHome, 'account-switch-job.json');
  writeJson(file, job);
  const worker = cp.spawn(process.execPath, [__filename, file], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  worker.unref();
  handoff(job.bridgeHome, worker.pid);
  const message = info
    ? '正在准备切换并重启 Codex 桌面端，准备失败时不会关闭桌面端。'
    : '正在准备切换；完成后将重载已连接、共用此目录的编辑器窗口。';
  writeJson(path.join(job.bridgeHome, 'account-switch.json'), {
    id: job.id,
    pid: worker.pid,
    status: 'queued',
    message,
  });
  return { message };
}
if (require.main === module) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  setTimeout(
    () =>
      runSwitch(job).catch(() => {
        process.exitCode = 1;
      }),
    1500,
  );
}
module.exports = { scheduleSwitch, runSwitch, desktopInfo, stopDesktop, powershell };
