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
const { createServer } = require('../server.cjs');
const { createService } = require('../service.cjs');

// 验证真实页面；仅使用独立本机配置，不触碰用户账号和正在执行的任务。
const root = fs.mkdtempSync(
  path.join(process.env.SWITCHER_VERIFY_HOME || os.tmpdir(), 'switcher-web-entry-'),
);
const home = path.join(root, 'home'),
  bridge = path.join(root, 'bridge');
fs.mkdirSync(home);
fs.mkdirSync(bridge);
fs.writeFileSync(
  path.join(home, 'config.toml'),
  'model="fixture-api"\nmodel_provider="hermes_bridge"\n',
);
const service = createService({ codexHome: home, bridgeHome: bridge });
const providerId = require('../providers.cjs').add(bridge, {
  name: 'Web entry fixture',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiMode: 'responses',
  model: 'fixture-api',
  apiKey: 'fixture-key',
});
fs.writeFileSync(path.join(bridge, 'current.json'), JSON.stringify({ providerId }));
let browser, server, port;
const switchRequests = [];
const probeRequests = [];
const report = { platform: process.platform, checks: [] };
async function start(token) {
  server = createServer({
    token,
    getState: service.state,
    actions: {
      ...service.actions,
      accounts: async () => ({ items: [] }),
      // 这里只替代重启客户端这一步，页面传参和配置读写仍使用实际代码。
      desktopSwitch: async (input) => {
        switchRequests.push(input);
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
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('provider').options.length > 0);
  assert.ok((await page.locator('#summary').innerText()).includes('fixture-api'));
  assert.equal(await page.locator('#provider').isEnabled(), true);
  assert.equal((await page.locator('#status').innerText()).includes('凭证已过期'), false);
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
    await loaded(page, base + '/');
    report.checks.push('fresh-browser-direct-url');
    await page.goto('about:blank');
    await loaded(page, base + '/#expired-shortcut-token');
    assert.equal(new URL(page.url()).hash, '');
    report.checks.push('old-shortcut-link');
    const second = await context.newPage();
    await loaded(second, base + '/');
    await second.reload();
    await second.waitForFunction(() => document.getElementById('provider').options.length > 0);
    report.checks.push('new-tab-and-refresh');
    const local = await context.newPage();
    await loaded(local, 'http://localhost:' + port + '/');
    report.checks.push('localhost-address');
    await new Promise((resolve) => server.close(resolve));
    await start('fixture-session-after-restart');
    // 不刷新页面，直接使用旧标签页里的按钮，确认请求自行恢复访问。
    const recovered = page.waitForResponse(
      (response) => response.url().endsWith('/api/threads') && response.status() === 200,
    );
    await page.locator('#threads-refresh').evaluate((button) => button.click());
    await recovered;
    assert.equal(await page.evaluate(async () => (await fetch('/api/state')).status), 200);
    report.checks.push('old-tab-recovers-after-service-restart');
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
    report.checks.push('only-API-probe-without-speed-apply-or-config-writes');
    const applied = page.waitForResponse(
      (r) => r.url().endsWith('/api/desktopSwitch') && r.status() === 200,
    );
    await page.locator('#switch').click();
    await applied;
    assert.equal(Object.hasOwn(switchRequests.at(-1), 'fast'), false);
    await loaded(page, base + '/');
    report.checks.push('source-switch-does-not-set-speed');
    await page.screenshot({ path: path.resolve('verification/web-entry.png'), fullPage: true });
    const failed = await context.newPage();
    await failed.route('**/api/accounts', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fixture load failure' }),
      }),
    );
    await failed.goto(base + '/');
    await failed.waitForFunction(
      () => document.getElementById('summary').textContent === '本机配置读取失败',
    );
    assert.ok((await failed.locator('#status').innerText()).includes('fixture load failure'));
    report.checks.push('load-error-does-not-stay-loading');
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
    fs.writeFileSync(path.resolve('verification/web-entry.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})();
