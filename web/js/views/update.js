import { $, api, setUpgrading } from '../api.js';
import { busy, status } from '../ui.js';

// 一键升级：后台检查发布信息（缓存 6 小时），有新构建时在顶部提示；下载、校验、替换都在后台完成。
let update = null,
  poll = null;
const time = (iso) => new Date(iso).toLocaleString('zh-CN');
const pollState = () =>
  api('state')
    .then((s) => renderUpdate(s.update))
    .catch(() => {
      clearInterval(poll);
      poll = null;
    });
export function renderUpdate(u) {
  update = u;
  const latest = u.latest,
    // 新旧按只增不减的发布序号判断，版本号相同时也能区分。
    target = latest && latest.version + '（第 ' + latest.sequence + ' 版）';
  // 发布说明按纯文本显示，去掉 Markdown 标题符号。
  const notes = latest?.notes ? '\n' + latest.notes.replace(/^#+\s*/gm, '') : '';
  const texts = {
    available: ['有新版本可用', target + notes],
    downloading: ['正在下载更新…', '下载并校验完成后会自动安装，期间可以继续使用。'],
    installing: ['正在安装更新', '切换器会自动重启并打开新页面，这个页面随后可以关闭。'],
    error: ['更新失败：' + u.error, u.error],
  };
  // 开发目录用 git 更新，不提示安装；检查失败但没有可装的新版本时，只在设置里说明，不占用首屏。
  const shown =
    !u.dev &&
    texts[u.status] &&
    (u.status !== 'error' || u.installationFailed || (latest && latest.build !== u.current.build));
  $('update-banner').hidden = !shown;
  if (shown) {
    $('update-title').textContent = texts[u.status][0];
    $('update-detail').textContent = texts[u.status][1];
    $('update-install').hidden = !['available', 'error'].includes(u.status);
    $('update-install').textContent = u.status === 'error' ? '重试' : '立即更新';
  }
  $('update-status').textContent = u.dev
    ? '这是开发目录，请用 git 更新，不使用一键升级。' +
      (latest ? ' 最新发布：' + target + ' · 检查于 ' + time(u.checkedAt) : '')
    : u.status === 'checking'
      ? '正在检查更新…'
      : u.status === 'error'
        ? '检查或安装更新失败：' + u.error
        : latest
          ? (u.status === 'available'
              ? '当前第 ' + u.current.sequence + ' 版，有新版本：' + target
              : '已是最新版本（第 ' + u.current.sequence + ' 版）') +
            ' · 检查于 ' +
            time(u.checkedAt)
          : '尚未检查更新。';
  // 下载和安装在后台进行，页面轮询状态直到完成或旧后台退出。
  const running = ['downloading', 'installing'].includes(u.status);
  setUpgrading(running);
  if (running && !poll) poll = setInterval(pollState, 1500);
  if (!running && poll) {
    clearInterval(poll);
    poll = null;
  }
}
export async function checkUpdate() {
  renderUpdate(await api('checkUpdate', {}));
}
$('update-check').onclick = () =>
  busy($('update-check'), checkUpdate, (text) => ($('update-status').textContent = text));
$('update-install').onclick = () =>
  busy($('update-install'), async () => {
    renderUpdate({ ...update, status: 'downloading' });
    try {
      status((await api('installUpdate', {})).message);
    } finally {
      // 后台立即回复；随后的状态（或拒绝原因）以后台记录为准。
      await pollState();
    }
  });
// 为检测到的每个编辑器重新安装本版伴随扩展，并重载所有已接入的窗口。
$('companions-update').onclick = () =>
  busy($('companions-update'), async () => {
    if (
      !confirm(
        '会为检测到的编辑器安装本版伴随扩展，并重载所有已接入的编辑器窗口；窗口里正在运行的 Codex 任务会中断。继续？',
      )
    )
      return;
    status('正在更新编辑器扩展…');
    const { results, reload } = await api('updateCompanions', {});
    status(
      [
        ...(results.length
          ? results.map((x) => (x.error ? x.name + '：失败 · ' + x.error : x.message))
          : ['没有检测到可以安装扩展的编辑器。']),
        reload.message,
      ].join('\n'),
    );
  });
