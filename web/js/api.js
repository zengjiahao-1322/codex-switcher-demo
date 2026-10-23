export const $ = (id) => document.getElementById(id);
// 启动器打开的网址带 #token：先换取 HttpOnly 会话 Cookie，再从地址栏去掉。
// 主页本身不授予权限，直接输入网址或后台重启后只能从快捷方式重新打开。
export const launchToken = location.hash.slice(1);
if (launchToken) history.replaceState(null, '', location.pathname + location.search);
export const sessionReady = launchToken
  ? fetch('/api/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: 'Bearer ' + launchToken },
    })
  : null;
export const SESSION_LOST = '本机会话已失效，请从桌面快捷方式重新打开切换器。';
const UPGRADED = '切换器已更新，请使用新打开的页面；这个页面可以关闭。';
export let sessionLost = false,
  upgrading = false;
// 升级期间旧后台会退出、新后台不认旧会话；此时断开是预期结果，不当作会话失效。
export function setUpgrading(value) {
  upgrading = value;
}
function lose() {
  // 定时刷新会继续调用接口；标记后不再请求，提示只显示一处。
  sessionLost = true;
  if (upgrading) {
    $('session-notice').textContent = UPGRADED;
    $('update-banner').hidden = true;
  }
  $('session-notice').hidden = false;
  document.querySelector('.workspace').hidden = true;
  throw Error(upgrading ? UPGRADED : SESSION_LOST);
}
export async function api(route, data) {
  if (sessionLost) throw Error(upgrading ? UPGRADED : SESSION_LOST);
  let r;
  try {
    await sessionReady;
    const options = {
      method: data ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: {
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    };
    r = await fetch('/api/' + route, options);
  } catch {
    if (upgrading) lose();
    throw Error('本机服务未连接，请重新打开桌面上的切换器快捷方式。');
  }
  if (r.status === 401) lose();
  const j = await r.json();
  // 页面文件每次从磁盘读取，后台只在启动时加载；代码更新后未重启，新页面会调用旧后台没有的接口。
  if (r.status === 404 && j.error === 'Unknown action')
    throw Error(
      '切换器后台仍是更新前的版本，缺少这个功能。请从桌面快捷方式重新打开切换器，会自动换成新版本。',
    );
  // 结构化 code 用于需要用户确认后重发的请求（未识别的程序、旧对话去向）。
  if (!r.ok) throw Object.assign(Error(j.error || '请求失败'), { code: j.code });
  return j;
}
