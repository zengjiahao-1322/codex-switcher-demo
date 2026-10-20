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
        const file = path.join(home, 'config.toml');
        fs.writeFileSync(
          file,
          require('../core.cjs').configureSpeed(fs.readFileSync(file, 'utf8'), input.fast),
        );
        return { message: 'fixture switch applied' };
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
    // 验证开关随“应用”提交，刷新后从配置恢复，关闭时同样提交 false。
    for (const fast of [true, false]) {
      await page.locator('#fast').setChecked(fast);
      const applied = page.waitForResponse(
        (response) => response.url().endsWith('/api/desktopSwitch') && response.status() === 200,
      );
      await page.locator('#switch').click();
      await applied;
      assert.equal(switchRequests.at(-1).fast, fast);
      await loaded(page, base + '/');
      assert.equal(await page.locator('#fast').isChecked(), fast);
      assert.ok(
        (await page.locator('#summary').innerText()).includes(fast ? 'Fast 已配置' : '标准速度'),
      );
    }
    report.checks.push('fast-toggle-submit-and-refresh');
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
