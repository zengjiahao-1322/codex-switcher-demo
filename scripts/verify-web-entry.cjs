'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('../.build-cache/browser-check/node_modules/playwright'));
}
const { createServer } = require('../src/server/server.cjs');
const { createService } = require('../src/server/service.cjs');

// 验证真实页面；仅使用独立本机配置，不触碰用户账号和正在执行的任务。
const root = fs.mkdtempSync(
  path.join(process.env.SWITCHER_VERIFY_HOME || os.tmpdir(), 'switcher-web-entry-'),
);
const reports = process.env.SWITCHER_REPORT_DIR || path.resolve('verification');
fs.mkdirSync(reports, { recursive: true });
const home = path.join(root, 'home'),
  bridge = path.join(root, 'bridge');
fs.mkdirSync(home);
fs.mkdirSync(bridge);
fs.writeFileSync(
  path.join(home, 'config.toml'),
  'model="fixture-api"\nmodel_provider="hermes_bridge"\n',
);
const service = createService({ codexHome: home, bridgeHome: bridge });
const providerId = require('../src/config/providers.cjs').add(bridge, {
  name: 'Web entry fixture',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiMode: 'responses',
  model: 'fixture-api',
  apiKey: 'fixture-key',
});
fs.writeFileSync(path.join(bridge, 'current.json'), JSON.stringify({ providerId }));
let browser, server, port;
let fixtureJob = null;
const switchRequests = [];
const probeRequests = [];
const report = { platform: process.platform, checks: [] };
function checked(...checks) {
  report.checks.push(...checks);
  console.log('PASS ' + checks.join(', '));
}
async function start(token) {
  server = createServer({
    token,
    getState: service.state,
    actions: {
      ...service.actions,
      accounts: async () => ({ items: [], switchJob: fixtureJob }),
      // 不访问 GitHub：固定返回有新构建，验证顶部更新提示。
      checkUpdate: async () => ({
        current: { version: '0.1.3', build: 'fixture-old' },
        latest: { version: '0.1.3', build: 'fixture-new', notes: 'fixture notes' },
        checkedAt: new Date().toISOString(),
        status: 'available',
      }),
      // 这里只替代重启客户端这一步，页面传参和配置读写仍使用实际代码。
      desktopSwitch: async (input) => {
        switchRequests.push(input);
        fixtureJob = {
          status: 'done',
          startedAt: new Date().toISOString(),
          elapsedMs: 1250,
          configurationApplied: true,
          threadFollow: 'all',
          threads: { updated: 3, skipped: 0, failed: 0 },
          steps: [{ id: 'apply', label: '保存并应用目标配置', status: 'done', durationMs: 250 }],
          editorReload: {
            results: [
              { name: 'VS Code A', status: 'reloaded' },
              { name: 'VS Code B', status: 'received' },
            ],
          },
          message: 'fixture switch applied',
        };
        return { message: 'fixture switch applied' };
      },
      probe: async (input) => {
        probeRequests.push(input);
        return {
          ok: true,
          mode: 'direct',
          message: 'API 连接检测通过。',
        };
      },
    },
  });
  await new Promise((resolve) => server.listen(port || 0, '127.0.0.1', resolve));
  port = server.address().port;
}
async function loaded(page, url) {
  // 启动器会打开页面；先离开旧文档，避免仅更换 hash 被浏览器当成页内跳转。
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#source-list .source-card'));
  assert.ok((await page.locator('#summary').innerText()).includes('fixture-api'));
  assert.equal(await page.locator('#source-list .source-card').first().isEnabled(), true);
  assert.equal((await page.locator('#status').innerText()).includes('凭证已过期'), false);
  // 样式表单独加载；类型不对时浏览器会忽略它，页面退回无样式。
  assert.equal(
    await page.locator('.status-card').evaluate((el) => getComputedStyle(el).borderTopLeftRadius),
    '14px',
  );
}
(async () => {
  try {
    await start('fixture-session-one');
    browser = await chromium.launch({
      headless: true,
      ...(process.env.SWITCHER_BROWSER_CHANNEL
        ? { channel: process.env.SWITCHER_BROWSER_CHANNEL }
        : {}),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const base = 'http://127.0.0.1:' + port;
    await page.goto(base + '/');
    await page.locator('#session-notice').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.workspace').isHidden(), true);
    checked('fresh-browser-direct-url-requires-launcher');
    await loaded(page, base + '/#fixture-session-one');
    assert.equal(new URL(page.url()).hash, '');
    checked('current-launch-token-establishes-session');
    await page.locator('#update-banner').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#update-detail').innerText()).includes('构建 fixture-new'));
    assert.equal(await page.locator('#update-install').isVisible(), true);
    checked('update-banner-shows-newer-build');
    const expiredContext = await browser.newContext();
    const expired = await expiredContext.newPage();
    await expired.goto(base + '/#expired-shortcut-token');
    await expired.locator('#session-notice').waitFor({ state: 'visible' });
    assert.equal(await expired.locator('.workspace').isHidden(), true);
    await expiredContext.close();
    checked('expired-shortcut-token-rejected');
    const second = await context.newPage();
    await loaded(second, base + '/');
    await second.reload();
    await second.waitForFunction(() => document.querySelector('#source-list .source-card'));
    checked('new-tab-and-refresh');
    const local = await context.newPage();
    await loaded(local, 'http://localhost:' + port + '/#fixture-session-one');
    checked('localhost-address');
    console.log('Restarting fixture server');
    await new Promise((resolve) => {
      server.close(resolve);
      // 模拟后台退出时同时断开已有连接，避免旧页面的活动请求卡住测试服务器关闭。
      server.closeAllConnections();
    });
    await start('fixture-session-after-restart');
    // 后台重启使旧 Cookie 失效；页面必须提示从启动器重新打开，不能读取主页重取权限。
    await page.locator('#threads-refresh').evaluate((button) => button.click());
    await page.locator('#session-notice').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.workspace').isHidden(), true);
    assert.equal(await page.evaluate(async () => (await fetch('/api/state')).status), 401);
    checked('old-tab-requires-launcher-after-service-restart');
    await loaded(page, base + '/#fixture-session-after-restart');
    // 页面只保留普通 API 检测，不再展示或提交独立加速选项。
    assert.equal(await page.locator('#fast').count(), 0);
    assert.equal(await page.locator('#probe-fast, #fast-hint').count(), 0);
    const configBefore = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const button = page.locator('#probe');
    assert.equal(await button.isVisible(), true);
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/probe') && r.status() === 200,
    );
    await button.click();
    await response;
    await page.waitForFunction(() =>
      document.getElementById('status').textContent.includes('API 连接检测通过'),
    );
    assert.equal(Object.hasOwn(probeRequests.at(-1), 'fast'), false);
    assert.equal(switchRequests.length, 0);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), configBefore);
    checked('only-API-probe-without-speed-apply-or-config-writes');
    const applied = page.waitForResponse(
      (r) => r.url().endsWith('/api/desktopSwitch') && r.status() === 200,
    );
    await page.locator('#switch').click();
    await applied;
    assert.equal(Object.hasOwn(switchRequests.at(-1), 'fast'), false);
    await page.locator('#switch-progress').waitFor({ state: 'visible' });
    await page.locator('#switch-progress-title').click();
    assert.ok((await page.locator('#switch-steps').innerText()).includes('0.3 秒'));
    assert.ok((await page.locator('#switch-windows').innerText()).includes('已同步 3 条'));
    assert.ok((await page.locator('#switch-windows').innerText()).includes('尚未验证实际请求'));
    assert.ok((await page.locator('#switch-windows').innerText()).includes('等待扩展重新连接'));
    fixtureJob = {
      ...fixtureJob,
      status: 'error',
      threads: undefined,
      editorReload: undefined,
      steps: [{ id: 'threads', label: '同步并核对旧对话', status: 'error', durationMs: 500 }],
    };
    await loaded(page, base + '/');
    assert.ok((await page.locator('#switch-progress-title').innerText()).includes('切换未完成'));
    assert.ok((await page.locator('#switch-steps').innerText()).includes('失败'));
    checked('switch-step-timing-failure-and-separate-window-reload-results');
    checked('source-switch-does-not-set-speed');
    console.log('Capturing verified page');
    await page.screenshot({
      path: path.join(reports, 'web-entry.png'),
      fullPage: true,
      timeout: 15000,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      '手机宽度不应出现横向滚动',
    );
    await page.screenshot({
      path: path.join(reports, 'web-entry-mobile.png'),
      fullPage: true,
      timeout: 15000,
    });
    checked('mobile-width-without-horizontal-scroll');
    // 使用独立会话建立当前启动凭证，避免前面 127.0.0.1/localhost 页面
    // 的 Cookie 在不同平台浏览器实现中互相影响错误页面验收。
    const failedContext = await browser.newContext();
    const failed = await failedContext.newPage();
    await failed.route('**/api/accounts', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fixture load failure' }),
      }),
    );
    const failedAccounts = failed.waitForResponse(
      (response) => response.url().endsWith('/api/accounts') && response.status() === 500,
    );
    await failed.goto(base + '/#fixture-session-after-restart');
    await failedAccounts;
    await failed.waitForFunction(() =>
      document.getElementById('summary').textContent.includes('本机配置读取失败'),
    );
    assert.ok((await failed.locator('#status').innerText()).includes('fixture load failure'));
    checked('load-error-does-not-stay-loading');
    assert.deepEqual(errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    report.errorStack = error.stack;
    process.exitCode = 1;
  } finally {
    await browser?.close();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    report.checkedAt = new Date().toISOString();
    report.fixtureDirectory = root;
    fs.writeFileSync(path.join(reports, 'web-entry.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})();
