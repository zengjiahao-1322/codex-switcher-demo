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

// 运行发行包使用的同一份 HTML / app.js，验证刷新时的真实 DOM 状态。
// 此处仅控制测试浏览器，不接触用户桌面或个人账号。
const root = fs.mkdtempSync(
  path.join(process.env.SWITCHER_VERIFY_HOME || os.tmpdir(), 'switcher-ui-parity-'),
);
const report = { platform: process.platform, arch: process.arch, checks: [] };
const reportFile = path.resolve('verification', 'quota-ui.json');
let browser;
let server;
let releaseSlow;
let officialMode = false,
  switches = 0;

(async () => {
  try {
    const codexHome = path.join(root, 'home');
    const bridgeHome = path.join(root, 'bridge');
    fs.mkdirSync(codexHome);
    fs.mkdirSync(bridgeHome);
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      'model="fixture-api"\nmodel_provider="hermes_bridge"\n',
    );
    const providerId = require('../providers.cjs').add(bridgeHome, {
      name: 'UI fixture API',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiMode: 'responses',
      model: 'fixture-api',
      apiKey: 'fixture-key',
    });
    fs.writeFileSync(path.join(bridgeHome, 'current.json'), JSON.stringify({ providerId }));
    const service = createService({ codexHome, bridgeHome });
    const slowGate = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    const accounts = [
      { id: 'fixture-slow', label: 'Slow account', email: 'slow@example.test', plan: 'plus' },
      { id: 'fixture-fast', label: 'Fast account', email: 'fast@example.test', plan: 'plus' },
    ];
    let calls = 0;
    server = createServer({
      token: 'fixture-ui-token',
      getState: async () => {
        const state = await service.state();
        if (officialMode) state.current.official = true;
        return state;
      },
      actions: {
        ...service.actions,
        accounts: async () => ({ items: accounts }),
        accountSwitch: async () => {
          switches++;
          return {};
        },
        accountQuota: async ({ id }) => {
          calls++;
          if (id === 'fixture-slow') await slowGate;
          const row = accounts.find((account) => account.id === id);
          row.quota = {
            status: 'ok',
            checkedAt: new Date().toISOString(),
            buckets: [
              {
                id: 'codex',
                windows: [{ minutes: 300, remainingPercent: id === 'fixture-slow' ? 80 : 65 }],
              },
            ],
          };
          return { items: [{ id, ...row.quota }] };
        },
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.SWITCHER_BROWSER_CHANNEL
        ? { channel: process.env.SWITCHER_BROWSER_CHANNEL }
        : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#fixture-ui-token`);
    await page.waitForFunction(() => document.getElementById('provider').disabled === false);
    await page.locator('#model').fill('draft-kept-during-quota');
    await page.locator('#account-manager > summary').click();
    await page.locator('#account-list').getByText('剩余 65%', { exact: true }).waitFor();
    const slowRow = page.locator('.prow').filter({ hasText: 'Slow account' });
    const fastRow = page.locator('.prow').filter({ hasText: 'Fast account' });
    assert.equal(
      await slowRow.getByRole('button', { name: '正在读取…', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await fastRow.getByRole('button', { name: '刷新额度', exact: true }).isEnabled(),
      true,
    );
    for (const id of ['provider', 'model', 'probe', 'switch', 'fetch-models', 'account-add']) {
      assert.equal(
        await page.locator('#' + id).isEnabled(),
        true,
        `${id} 不应被另一个账号刷新锁住`,
      );
    }
    assert.equal(await page.locator('#model').inputValue(), 'draft-kept-during-quota');
    await page.locator('#provider').selectOption('account:fixture-fast');
    assert.equal(await page.locator('#switch').isEnabled(), true);
    assert.ok((await page.locator('#official-quota').innerText()).includes('剩余 65%'));
    report.checks.push('slow-account-does-not-lock-source-model-or-other-account');

    const before = calls;
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/accountQuota')),
      fastRow.getByRole('button', { name: '刷新额度', exact: true }).click(),
    ]);
    await page.waitForFunction(() =>
      document.getElementById('quota-refresh').textContent.includes('1 个账号'),
    );
    assert.equal(calls, before + 1, '单账号刷新只应请求所点账号');
    report.checks.push('single-account-refresh-is-independent');
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    await page.screenshot({
      path: path.resolve('verification', 'quota-ui-waiting.png'),
      fullPage: true,
    });
    releaseSlow();
    await slowRow.getByText('剩余 80%', { exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新全部额度', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    report.checks.push('each-account-renders-own-result-without-script-errors');
    officialMode = true;
    accounts[0].current = true;
    accounts[0].quota.buckets[0].windows[0].remainingPercent = 10;
    await page.reload();
    await page.locator('#quota-notice').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#quota-notice').innerText()).includes('10%'));
    await page.getByRole('button', { name: '选择备用账号', exact: true }).click();
    assert.equal(await page.locator('#provider').inputValue(), 'account:fixture-fast');
    assert.equal(switches, 0, '额度提醒只选择账号，不自动应用或重启');
    accounts[0].quota.status = 'error';
    await page.reload();
    await page.waitForFunction(() => document.getElementById('provider').disabled === false);
    assert.equal(await page.locator('#quota-notice').isHidden(), true);
    accounts[0].quota.status = 'ok';
    accounts[0].quota.buckets[0].windows[0].resetsAt = Math.floor(Date.now() / 1000) - 60;
    await page.reload();
    await page.waitForFunction(() => document.getElementById('provider').disabled === false);
    assert.equal(
      await page.locator('#quota-notice').isHidden(),
      true,
      '已重置窗口不能用旧比例提醒',
    );
    officialMode = false;
    accounts[0].quota.buckets[0].windows[0].resetsAt = null;
    await page.reload();
    await page.waitForFunction(() => document.getElementById('provider').disabled === false);
    assert.equal(
      await page.locator('#quota-notice').isHidden(),
      true,
      'API 模式不应拿官方额度提醒',
    );
    report.checks.push('low-quota-selects-backup-without-switch-and-ignores-failed-read');
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    releaseSlow?.();
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    report.checkedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log(JSON.stringify(report));
})();
