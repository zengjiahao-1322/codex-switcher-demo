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
const { createServer, isRust } = require('../tests/backend.cjs');
const { auth, accountId } = require('../tests/official-blackbox-helpers.cjs');
const slowId = accountId('ui-slow'),
  fastId = accountId('ui-fast');
const { createService } = require('../src/server/service.cjs');

// 运行发行包使用的同一份 HTML / CSS / ES 模块，验证刷新时的真实 DOM 状态。
// 此处仅控制测试浏览器，不接触用户桌面或个人账号。
const root = fs.mkdtempSync(
  path.join(process.env.SWITCHER_VERIFY_HOME || os.tmpdir(), 'switcher-ui-parity-'),
);
const report = { platform: process.platform, arch: process.arch, checks: [] };
const reports = process.env.SWITCHER_REPORT_DIR || path.resolve('verification');
const reportFile = path.join(reports, 'quota-ui.json');
let browser;
let server;
let releaseSlow;
let native;
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
    const providerId = require('../src/config/providers.cjs').add(bridgeHome, {
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
      { id: slowId, label: 'Slow account', email: 'slow@example.test', plan: 'plus' },
      { id: fastId, label: 'Fast account', email: 'fast@example.test', plan: 'plus' },
    ];
    const syncNative = () => {
      if (!native) return;
      native.write(
        path.join(bridgeHome, 'accounts/index.json'),
        accounts.map(({ quota, ...row }) => row),
      );
      for (const row of accounts)
        if (row.quota)
          native.write(path.join(bridgeHome, 'accounts', row.id, 'quota.json'), row.quota);
      if (officialMode) {
        native.write(path.join(codexHome, 'auth.json'), auth('ui-slow'));
        native.write(
          path.join(codexHome, 'config.toml'),
          'model="fixture-api"\ncli_auth_credentials_store="file"\n',
        );
      } else {
        native.write(
          path.join(codexHome, 'config.toml'),
          'model="fixture-api"\nmodel_provider="hermes_bridge"\n',
        );
        native.write(path.join(bridgeHome, 'current.json'), { providerId });
      }
    };
    if (isRust) {
      native = await require('../tests/browser-native-fixture.cjs').prepare(
        root,
        codexHome,
        bridgeHome,
      );
      for (const [id, user, remaining] of [
        [slowId, 'ui-slow', 80],
        [fastId, 'ui-fast', 65],
      ]) {
        native.write(path.join(bridgeHome, 'accounts', id, 'auth.json'), auth(user));
        native.data.profiles[id] = {
          methods: {
            'account/rateLimits/read': {
              ...(id === slowId ? { waitFile: 'release-slow' } : {}),
              result: {
                rateLimits: {
                  limitId: 'codex',
                  planType: 'plus',
                  primary: {
                    usedPercent: 100 - remaining,
                    windowDurationMins: 300,
                    resetsAt: 2000000000,
                  },
                },
              },
            },
          },
        };
      }
      native.save();
      syncNative();
      const release = releaseSlow;
      releaseSlow = () => {
        release();
        native.write(path.join(root, 'release-slow'), 'ready');
      };
    }
    let calls = 0;
    server = createServer(
      {
        token: 'fixture-ui-token',
        getState: async () => {
          const state = await service.state();
          if (officialMode) state.current.official = true;
          return state;
        },
        actions: {
          ...service.actions,
          accounts: async () => ({ items: accounts }),
          // 不访问 GitHub。
          checkUpdate: async () => ({
            current: { version: '0.1.3', build: 'fixture' },
            latest: null,
            checkedAt: null,
            status: 'idle',
          }),
          accountSwitch: async () => {
            switches++;
            return {};
          },
          accountQuota: async ({ id }) => {
            calls++;
            if (id === slowId) await slowGate;
            const row = accounts.find((account) => account.id === id);
            row.quota = {
              status: 'ok',
              checkedAt: new Date().toISOString(),
              buckets: [
                {
                  id: 'codex',
                  windows: [{ minutes: 300, remainingPercent: id === slowId ? 80 : 65 }],
                },
              ],
            };
            return { items: [{ id, ...row.quota }] };
          },
        },
      },
      { codexHome, bridgeHome, env: native?.env },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.SWITCHER_BROWSER_CHANNEL
        ? { channel: process.env.SWITCHER_BROWSER_CHANNEL }
        : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    if (isRust)
      page.on('request', (request) => {
        if (request.url().endsWith('/api/accountSwitch')) switches++;
      });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#fixture-ui-token`);
    await page.waitForFunction(
      () => document.querySelector('#source-list .source-card')?.disabled === false,
    );
    await page.locator('#model').fill('draft-kept-during-quota');
    await page.locator('#tab-accounts').click();
    await page
      .locator('#account-list .quota-summary')
      .getByText(/^5小时 65% · /)
      .waitFor();
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
    for (const selector of [
      '#source-list .source-card >> nth=0',
      '#model',
      '#probe',
      '#switch',
      '#fetch-models',
      '#account-add',
    ]) {
      assert.equal(
        await page.locator(selector).isEnabled(),
        true,
        `${selector} 不应被另一个账号刷新锁住`,
      );
    }
    assert.equal(await page.locator('#model').inputValue(), 'draft-kept-during-quota');
    await page.locator(`[data-source="account:${fastId}"]`).click();
    assert.equal(await page.locator('#switch').isEnabled(), true);
    assert.ok((await page.locator('#official-quota').innerText()).includes('剩余 65%'));
    report.checks.push('slow-account-does-not-lock-source-model-or-other-account');

    const quotaCalls = () =>
      isRust ? native.rpc().filter((x) => x.method === 'account/rateLimits/read').length : calls;
    const before = quotaCalls();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/accountQuota')),
      fastRow.getByRole('button', { name: '刷新额度', exact: true }).click(),
    ]);
    await page.waitForFunction(() =>
      document.getElementById('quota-refresh').textContent.includes('1 个账号'),
    );
    assert.equal(quotaCalls(), before + 1, '单账号刷新只应请求所点账号');
    report.checks.push('single-account-refresh-is-independent');
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    await page.screenshot({
      path: path.join(reports, 'quota-ui-waiting.png'),
      fullPage: true,
    });
    releaseSlow();
    await slowRow.getByText(/^5小时 80% · /).waitFor();
    await page.getByRole('button', { name: '刷新全部额度', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    report.checks.push('each-account-renders-own-result-without-script-errors');
    if (isRust)
      for (const account of accounts)
        account.quota = JSON.parse(
          fs.readFileSync(path.join(bridgeHome, 'accounts', account.id, 'quota.json')),
        );
    officialMode = true;
    accounts[0].current = true;
    accounts[0].quota.buckets[0].windows[0].remainingPercent = 10;
    syncNative();
    await page.reload();
    await page.locator('#quota-notice').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#quota-notice').innerText()).includes('10%'));
    // 一键换号：取消确认时不切换；确认后直接对备用账号发起切换。
    const swap = page.getByRole('button', { name: '换到「Fast account」', exact: true });
    page.once('dialog', (dialog) => dialog.dismiss());
    await swap.click();
    assert.equal(switches, 0, '取消确认时不切换');
    page.once('dialog', (dialog) => dialog.accept());
    await swap.click();
    await page.waitForTimeout(300);
    assert.equal(switches, 1, '确认后直接切换到备用账号');
    assert.equal(await page.locator('#provider').inputValue(), 'account:' + fastId);
    accounts[0].quota.status = 'error';
    syncNative();
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector('#source-list .source-card')?.disabled === false,
    );
    assert.equal(await page.locator('#quota-notice').isHidden(), true);
    accounts[0].quota.status = 'ok';
    accounts[0].quota.buckets[0].windows[0].resetsAt = Math.floor(Date.now() / 1000) - 60;
    syncNative();
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector('#source-list .source-card')?.disabled === false,
    );
    assert.equal(
      await page.locator('#quota-notice').isHidden(),
      true,
      '已重置窗口不能用旧比例提醒',
    );
    officialMode = false;
    accounts[0].quota.buckets[0].windows[0].resetsAt = null;
    syncNative();
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector('#source-list .source-card')?.disabled === false,
    );
    assert.equal(
      await page.locator('#quota-notice').isHidden(),
      true,
      'API 模式不应拿官方额度提醒',
    );
    report.checks.push('low-quota-one-click-swap-after-confirm-and-ignores-failed-read');
    // 账号说明（邮箱、套餐、到期、读取时间）很长时，手机宽度也只显示省略号，不能撑出横向滚动。
    accounts[1].email = 'a-very-long-mailbox-name-used-to-check-mobile-layout@example.test';
    accounts[1].subscriptionUntil = new Date(Date.now() + 86400000).toISOString();
    syncNative();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector('#source-list .source-card')?.disabled === false,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      '长账号说明撑出了横向滚动',
    );
    report.checks.push('long-account-details-fit-mobile-width');
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    releaseSlow?.();
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    native?.close();
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    report.checkedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log(JSON.stringify(report));
})();
