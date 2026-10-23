'use strict';
const path = require('node:path'),
  fs = require('node:fs'),
  cp = require('node:child_process');
const { createAccounts, writeJson } = require('../accounts/accounts.cjs');
const { handoff, release, recordEffect } = require('../config/switch-state.cjs');
const { log } = require('../diagnostics/event-log.cjs');
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
async function powershellAsync(script, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.PSModulePath;
  try {
    const { stdout } = await require('node:util').promisify(cp.execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop';try {" +
          script +
          '} catch {[Console]::Error.WriteLine($_.Exception.Message);exit 1}',
      ],
      { encoding: 'utf8', windowsHide: true, env: childEnv },
    );
    return stdout.trim();
  } catch (error) {
    throw Error(
      String(error.stderr || '').trim() ||
        '桌面端操作失败（PowerShell 退出码 ' + error.code + '）。',
    );
  }
}
function desktopInfo() {
  if (process.platform === 'darwin') {
    const inventory = require('./client-status.cjs').scan();
    const running = inventory.ancestry.find((p) =>
      require('../platform/platform.cjs').isCodexDesktop(p.exe),
    );
    if (running) return { exe: running.exe };
    for (const app of require('../platform/platform.cjs').macApps())
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
async function stopDesktop(exe, codexHome, { inventory: checkedInventory } = {}) {
  if (process.platform === 'darwin') return stopMacDesktop(exe, codexHome, checkedInventory);
  const clients = require('./client-status.cjs'),
    inventory = checkedInventory || (codexHome ? await clients.scanAsync({ force: true }) : null),
    targetIds = inventory ? clients.desktopTargets(exe, codexHome, { inventory }) : null,
    backendIds = inventory
      ? inventory.ancestry
          .filter((p) => /^codex\.exe$/i.test(p.name) && targetIds.includes(p.parentPid))
          .map((p) => p.pid)
      : null;
  await powershellAsync(
    `
 $restricted=$env:SWITCHER_DESKTOP_IDS -ne '*';$allowed=@($env:SWITCHER_DESKTOP_IDS.Split(',') | Where-Object {$_ -and $_ -ne '*'} | ForEach-Object {[int]$_});
 # 只查询目标 PID 或同名进程，不重复打开整张系统进程表读取路径。
 $candidates=if($restricted){if($allowed.Count){Get-Process -Id $allowed -ErrorAction SilentlyContinue}}else{Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($env:SWITCHER_DESKTOP_EXE)) -ErrorAction SilentlyContinue};
 $p=@($candidates | Where-Object {$_.Path -eq $env:SWITCHER_DESKTOP_EXE});
 $desktopIds=@($p | Select-Object -ExpandProperty Id);
 # 归属检查已经取得同一份进程树，不再为桌面后端启动第二次 CIM 查询。
 $backendIds=if($env:SWITCHER_BACKEND_IDS -eq '*'){@(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object {$_.ParentProcessId -in $desktopIds} | Select-Object -ExpandProperty ProcessId)}else{@($env:SWITCHER_BACKEND_IDS.Split(',') | Where-Object {$_} | ForEach-Object {[int]$_})};
 $tracked=@($p);
 if($backendIds.Count){$tracked+=@(Get-Process -Id $backendIds -ErrorAction SilentlyContinue)};
 $tracked=@($tracked | Sort-Object Id -Unique);
 foreach($item in $p){if($item.MainWindowHandle -ne 0){[void]$item.CloseMainWindow()}};
 # 等待已确认进程的退出信号；所有进程共用原有两秒保存时限，不反复枚举进程。
 $waiting=[Diagnostics.Stopwatch]::StartNew();
 foreach($item in $tracked){
   $remaining=2000-[int]$waiting.ElapsedMilliseconds;
   if(-not $item.HasExited -and $remaining -gt 0){[void]$item.WaitForExit($remaining)}
 };
 $tracked | Where-Object {-not $_.HasExited} | Stop-Process -Force -ErrorAction SilentlyContinue;
 # 强制停止返回后仍等待真实退出，不把停止命令返回当作已结束。
 $forced=[Diagnostics.Stopwatch]::StartNew();
 foreach($item in $tracked){
   $remaining=1000-[int]$forced.ElapsedMilliseconds;
   if(-not $item.HasExited -and $remaining -gt 0){[void]$item.WaitForExit($remaining)}
 };
 # Windows 可能在父进程释放句柄前保留已退出的 PID，不能把已退出对象误报为仍在运行。
 $remaining=@($tracked | Where-Object {-not $_.HasExited});
 if($remaining.Count){throw 'Codex 桌面端仍在运行，请关闭桌面端后重试。'}
 `,
    {
      SWITCHER_DESKTOP_EXE: exe,
      SWITCHER_DESKTOP_IDS: targetIds ? targetIds.join(',') : '*',
      SWITCHER_BACKEND_IDS: backendIds ? backendIds.join(',') : '*',
    },
  );
}
function openWindowsDesktop() {
  powershell(
    "$pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1;if(-not $pkg){throw '未找到 Codex 桌面应用'};Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$pkg.PackageFamilyName+'!App')",
  );
}
async function stopMacDesktop(exe, codexHome, checkedInventory) {
  const status = require('./client-status.cjs'),
    inventory = checkedInventory || status.scan({ force: true }),
    roots = status.desktopTargets(exe, codexHome, { inventory }),
    ids = new Set(roots);
  for (let pass = 0; pass < 8; pass++)
    for (const p of inventory.ancestry) if (ids.has(p.parentPid)) ids.add(p.pid);
  await require('../platform/process-stop.cjs').stopProcesses([...ids]);
}
async function openDesktop(exe, home) {
  if (process.platform === 'darwin') {
    await new Promise((resolve, reject) => {
      const child = cp.spawn(exe, [], {
        env: { ...process.env, CODEX_HOME: home },
        detached: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  } else openWindowsDesktop();
  // 启动命令返回不等于应用已打开；等待同一配置目录的新桌面主进程。
  const status = require('./client-status.cjs');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const process = status
      .scan({ force: true })
      .processes.find(
        (p) =>
          status.sameHome(p.exe, exe) && p.context?.ok && status.sameHome(p.context.home, home),
      );
    if (process) return { pid: process.pid, startedAt: process.startedAt };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error('未检测到 Codex 桌面主进程重新启动，请查看系统是否阻止打开应用。');
}
async function runSwitch(
  job,
  {
    stop = stopDesktop,
    open = openDesktop,
    accounts = createAccounts(job),
    syncThreads = require('../diagnostics/thread-routing.cjs').synchronizeThreads,
    clients = async ({ force = false } = {}) => {
      const status = require('./client-status.cjs'),
        inventory = await status.scanAsync({ force });
      return { ...status.clientStatus(job.codexHome, job.bridgeHome, { inventory }), inventory };
    },
  } = {},
) {
  // desktopExe 为 null 表示只有 IDE / CLI：应用配置并请求匹配窗口重载，
  // 不调用桌面端关闭与启动流程。两种模式共用账号准备和配置应用逻辑。
  const file = path.join(job.bridgeHome, 'account-switch.json');
  const api = job.kind === 'api',
    desktop = job.desktopExe !== null,
    resume = job.resumeThreads === true,
    follow = require('../config/thread-follow.cjs');
  let prepared,
    stoppedEditors = [],
    desktopStarted = null,
    editorReload = null,
    reloadAttempted = false,
    applied = resume,
    threads = null,
    previousProvider,
    mode,
    releaseInventory,
    hasSharedEditors = false;
  const startedAt = new Date().toISOString(),
    started = performance.now(),
    steps = [];
  let currentStatus = 'preparing';
  const report = (status, message, details = {}) => {
    currentStatus = status;
    const elapsedMs = Math.round(performance.now() - started);
    writeJson(file, {
      id: job.id,
      pid: process.pid,
      status,
      message,
      startedAt,
      elapsedMs,
      steps,
      configurationApplied: applied,
      threadFollow: mode,
      previousProvider,
      ...(threads ? { threads } : {}),
      ...details,
      ...(['done', 'error'].includes(status) ? { finishedAt: new Date().toISOString() } : {}),
    });
    if (['done', 'error'].includes(status))
      log(job.bridgeHome, 'switch.end', {
        job: job.id,
        status,
        elapsedMs,
        configurationApplied: applied,
        threads,
        reload: editorReload?.targets
          ? require('./client-status.cjs').reloadResults(job.bridgeHome, editorReload.targets)
          : [],
      });
  };
  // 每步只记录实际执行结果；桌面打开请求与窗口重载完成分别展示。
  const step = async (id, label, action) => {
    const item = { id, label, status: 'running' },
      begin = performance.now();
    steps.push(item);
    report(currentStatus, label + '…');
    let failure;
    try {
      const result = await action();
      item.status = 'done';
      return result;
    } catch (error) {
      item.status = 'error';
      failure = { message: error.message, code: error.code ?? null, kind: error.kind ?? null };
      throw error;
    } finally {
      item.durationMs = Math.round(performance.now() - begin);
      log(job.bridgeHome, 'switch.step', {
        job: job.id,
        id,
        status: item.status,
        durationMs: item.durationMs,
        ...(failure ? { error: failure } : {}),
      });
    }
  };
  const checkEditors = (detected) => {
    if (detected.some((c) => c.kind === 'ide' && !c.confirmed && (!c.home || c.shared)))
      throw Error(
        '无法确认部分 Codex 插件后端的配置目录，尚未切换。请展开“影响范围与其他客户端”查看进程读取错误。',
      );
    const missing = detected.filter(
      (c) => c.kind === 'ide' && c.confirmed && c.shared && !c.editorId,
    );
    if (missing.length)
      throw Error(
        '检测到 ' +
          missing.length +
          ' 个共用配置的 Codex 后端未关联到编辑器窗口（PID ' +
          missing.map((c) => c.pid).join(', ') +
          '）。请在“影响范围与其他客户端”核对连接与进程归属；这不等于没有安装伴随扩展。配置尚未修改，客户端未关闭。',
      );
  };
  const logClients = (phase, status) =>
    log(job.bridgeHome, 'switch.clients', {
      job: job.id,
      phase,
      clients: require('./client-status.cjs').diagnosticClients(status, status.inventory),
    });
  log(job.bridgeHome, 'switch.start', {
    job: job.id,
    kind: resume ? 'resume' : api ? 'api' : 'official',
    target: resume ? '当前来源' : job.target,
    threadFollow: job.threadFollow,
    reloadEditors: job.reloadEditors !== false,
    desktop,
  });
  report('preparing', api ? '正在检查 API 和模型列表…' : '正在准备目标账号登录…');
  try {
    mode = follow.selectedMode(job.bridgeHome, job.threadFollow);
    previousProvider = resume ? job.previousProvider : follow.provider(job.codexHome);
    // 后台切换进程是新实例，先读取实际凭据存储，避免漏存 Mac 钥匙串账号。
    await step('prepare', api ? '检查 API 和准备模型' : '准备账号登录', async () => {
      await accounts.syncCurrent({ force: true });
      const checks = await Promise.allSettled([
        resume
          ? Promise.resolve()
          : api
            ? require('../server/service.cjs').createService(job).prepareApi(job)
            : accounts.prepare(job.id),
        (async () => {
          // 进程归属检查与登录校验互不依赖；全部通过后才允许关闭和写入。
          if (job.reloadEditors === false) return;
          const checked = await clients();
          logClients('check', checked);
          checkEditors(checked.clients);
        })(),
      ]);
      if (api && !resume && checks[0].status === 'fulfilled') prepared = checks[0].value;
      // 失败时也等另一项收尾，避免释放切换锁后仍有旧校验在更新凭证。
      for (const check of checks) if (check.status === 'rejected') throw check.reason;
      if (job.reloadEditors !== false) {
        // 登录校验可能耗时数秒。关闭前重新核对一次，所有关闭操作共用此刻的进程表。
        const latest = await clients({ force: true });
        logClients('recheck', latest);
        checkEditors(latest.clients);
        releaseInventory = latest.inventory;
        hasSharedEditors = latest.clients.some((c) => c.kind === 'ide' && c.confirmed && c.shared);
      }
    });
    currentStatus = 'switching';
    // 桌面端与编辑器后端是两组独立进程；同时释放它们，完成后才写入目标凭证。
    const desktopStop = desktop
        ? step('stop', '关闭目标桌面端', () =>
            stop(job.desktopExe, job.codexHome, { inventory: releaseInventory }),
          )
        : Promise.resolve(null),
      editorStop = hasSharedEditors
        ? step('editors', '释放共用配置的编辑器会话', () =>
            require('./client-status.cjs').stopEditorBackends(job.codexHome, job.bridgeHome, {
              inventory: releaseInventory,
            }),
          )
        : Promise.resolve([]),
      [desktopResult, editorResult] = await Promise.allSettled([desktopStop, editorStop]);
    // 即使桌面关闭失败，也要保存已停止的编辑器，供失败恢复重新连接。
    if (editorResult.status === 'fulfilled') stoppedEditors = editorResult.value;
    if (desktopResult.status === 'rejected') throw desktopResult.reason;
    if (editorResult.status === 'rejected') throw editorResult.reason;
    // 退出前官方客户端可能刚刷新令牌；应用目标配置前再保存一次最新登录。
    const result = await step('apply', '保存并应用目标配置', async () => {
      if (resume) return { label: '当前来源' };
      await accounts.syncCurrent({ force: true });
      const value = api
        ? (accounts.captureCurrent(), prepared.apply())
        : accounts.apply(job.id, job.model, job.catalog);
      applied = true;
      return value;
    });
    recordEffect(
      job.codexHome,
      job.bridgeHome,
      'thread_sync_pending',
      '配置已写入，正在同步旧对话，尚未完成切换。',
    );
    // 新旧对话共用一次切换：先持久保存旧会话来源，再让客户端重新加载。
    threads = await step('threads', mode === 'off' ? '保留旧对话设置' : '同步并核对旧对话', () =>
      mode === 'off'
        ? Promise.resolve({ updated: 0, skipped: 0, failed: 0 })
        : syncThreads({
            codexHome: job.codexHome,
            bridgeHome: job.bridgeHome,
            mode,
            previousProvider,
            targetModels: job.targetModels,
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
      desktopStarted = await step('reopen', '重新打开并确认桌面主进程', () =>
        open(job.desktopExe, job.codexHome),
      );
    }
    let editorNote = '';
    if (hasSharedEditors) {
      reloadAttempted = true;
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
      } catch (error) {
        throw Error('编辑器重载请求未发送：' + error.message);
      }
    } else if (job.reloadEditors === false) {
      editorNote = ' 本次未重载编辑器；完成任务后请手动重载需要更新的窗口。';
    } else {
      editorNote = ' 无共用配置的编辑器后端需要重载。';
    }
    const effect = desktop
      ? desktopStarted
        ? '已确认桌面主进程重新启动。'
        : '已请求重新打开桌面端。'
      : '未接入伴随扩展的编辑器窗口请执行“重载窗口”。';
    recordEffect(
      job.codexHome,
      job.bridgeHome,
      'reopen_requested',
      '配置已应用，' + effect + editorNote + ' CLI 请重新启动。',
    );
    report(
      'done',
      '已应用 ' +
        (resume
          ? '当前来源（继续同步）'
          : api
            ? prepared.label + ' · ' + job.model
            : result.label + ' 的官方配置') +
        '。' +
        effect +
        editorNote +
        (mode === 'off'
          ? ' 本次保留旧对话原有设置。'
          : ' 已核对 ' + threads.updated + ' 条旧对话，跳过 ' + threads.skipped + ' 条。') +
        (api && !resume && !result.catalogCount
          ? ' 未生成模型目录，下拉可能仍显示官方列表；实际使用所选模型。'
          : ''),
      { editorReload, threads, desktopRequested: desktop, desktopStarted },
    );
    return { ...result, threads };
  } catch (e) {
    threads = e.threads || threads;
    let recoveryNote = '';
    // 同步失败也要恢复已主动停止的插件，不能留下失去后端的面板；切换仍按失败回报。
    if (stoppedEditors.length && !reloadAttempted) {
      try {
        editorReload = await step('recoverEditors', '恢复已停止的编辑器插件', () =>
          require('./client-status.cjs').requestReload(job.codexHome, job.bridgeHome, {
            stoppedEditors,
          }),
        );
        recoveryNote =
          ' 已向 ' + editorReload.count + ' 个已停止的插件窗口发送恢复请求，旧对话切换仍未完成。';
      } catch (recoveryError) {
        recoveryNote = ' 插件恢复请求未发送：' + recoveryError.message;
      }
    }
    if (applied)
      recordEffect(
        job.codexHome,
        job.bridgeHome,
        'switch_incomplete',
        '切换未完成：' + e.message + recoveryNote,
      );
    report(
      'error',
      (applied ? '配置已应用，但旧对话同步或客户端重新加载未完成：' : '切换未完成：') +
        e.message +
        recoveryNote,
      { editorReload, desktopStarted },
    );
    throw e;
  } finally {
    prepared?.cleanup();
    release(job.bridgeHome);
  }
}
function desktopForClients(status, lookup = desktopInfo) {
  const desktops = status.clients.filter((client) => client.kind === 'desktop');
  const matchingDesktop = desktops.some((client) => client.confirmed && client.shared);
  const matchingEditor = status.clients.some(
    (client) => ['ide', 'editor'].includes(client.kind) && client.confirmed && client.shared,
  );
  // 正在运行的独立桌面环境不跟着插件配置重启。只使用插件时也不额外打开桌面版。
  if (desktops.some((client) => !client.confirmed)) {
    throw Error('尚未读到桌面端的配置目录，请先在客户端列表核对进程读取错误。');
  }
  // 桌面壳可能还没有 Codex 后端，直接使用已确认归属的壳进程路径，不能被 IDE 窗口遮蔽。
  const selectedDesktop = desktops.find((client) => client.confirmed && client.shared);
  return selectedDesktop?.desktopExecutable
    ? { exe: selectedDesktop.desktopExecutable }
    : matchingDesktop || (!desktops.length && !matchingEditor)
      ? lookup()
      : null;
}
function scheduleSwitch(job) {
  const status = require('./client-status.cjs').clientStatus(job.codexHome, job.bridgeHome);
  const info = desktopForClients(status);
  job = { ...job, desktopExe: info?.exe || null };
  const file = path.join(job.bridgeHome, 'account-switch-job.json');
  writeJson(file, job);
  const worker = cp.spawn(process.execPath, [__filename, file], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
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
  // 父进程完成锁交接和排队状态写入后再放行，不靠固定延迟避免状态覆盖。
  worker.send({ type: 'start' });
  return { message };
}
if (require.main === module) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const start = () => {
    runSwitch(job).catch(() => {
      process.exitCode = 1;
    });
  };
  if (process.send)
    process.once('message', (message) => {
      process.disconnect();
      if (message.type === 'start') start();
    });
  else start();
}
module.exports = {
  scheduleSwitch,
  runSwitch,
  desktopInfo,
  desktopForClients,
  stopDesktop,
  powershell,
};
