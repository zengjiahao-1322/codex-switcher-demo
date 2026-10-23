const { PROJECT_ROOT } = require('../paths.cjs');
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
function createServer({
  token,
  getState,
  actions = {},
  adapterToken,
  handleResponses,
  runtime,
  onFirstApiRequest,
}) {
  const downloads = new Map();
  let firstApiRequest = true;
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const host = req.headers.host;
    const localHosts = ['127.0.0.1:' + req.socket.localPort, 'localhost:' + req.socket.localPort];
    const cookieName = 'codex_switcher_' + req.socket.localPort;
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (!localHosts.includes(host)) return send(403, { error: 'Host rejected' });
    if (req.headers.origin && req.headers.origin !== 'http://' + host)
      return send(403, { error: 'Origin rejected' });
    const url = new URL(req.url, 'http://' + host);
    if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
      const key = url.pathname.slice(10),
        item = downloads.get(key);
      if (!item || Date.now() - item.at > 300000) return send(404, { error: 'Download expired' });
      downloads.delete(key);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename=\"codex-switcher-companion.vsix\"',
        'Content-Length': item.bytes.length,
      });
      res.end(item.bytes);
      return;
    }
    if (url.pathname === '/v1/responses' && handleResponses) {
      const a = Buffer.from(req.headers.authorization || ''),
        b = Buffer.from('Bearer ' + adapterToken);
      if (!adapterToken || a.length !== b.length || !crypto.timingSafeEqual(a, b))
        return send(401, { error: 'Proxy authentication required' });
      if (req.method !== 'POST') return send(405, { error: 'POST required' });
      try {
        return await handleResponses(req, res);
      } catch {
        if (!res.headersSent) return send(502, { error: 'Adapter request failed' });
        res.end();
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) {
      if (firstApiRequest) {
        firstApiRequest = false;
        onFirstApiRequest?.(url.pathname);
      }
      const supplied = Buffer.from(req.headers.authorization || ''),
        expected = Buffer.from('Bearer ' + token);
      // 浏览器使用已建立的 Cookie 会话；命令行与伴随扩展使用 Bearer 凭证。
      const cookie = (req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(cookieName + '='));
      const browserToken = Buffer.from(cookie ? cookie.slice(cookieName.length + 1) : '');
      const expectedToken = Buffer.from(token);
      const bearerOk =
        supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      const cookieOk =
        browserToken.length === expectedToken.length &&
        crypto.timingSafeEqual(browserToken, expectedToken);
      // 只有启动器提供的 Bearer 能建立会话；读取公开页面本身不授予 API 权限。
      if (url.pathname === '/api/session') {
        if (req.method !== 'POST') return send(405, { error: 'POST required' });
        if (!bearerOk) return send(401, { error: '请从桌面快捷方式重新打开切换器。' });
        res.writeHead(204, {
          'Set-Cookie': cookieName + '=' + token + '; HttpOnly; SameSite=Strict; Path=/api/',
        });
        res.end();
        return;
      }
      if (!bearerOk && !cookieOk)
        return send(401, { error: '本机会话已过期，请从桌面快捷方式重新打开切换器。' });
      try {
        if (runtime && req.method === 'GET' && url.pathname === '/api/runtime')
          return send(200, runtime);
        if (req.method === 'GET' && url.pathname === '/api/state')
          return send(200, await getState());
        if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
        const action = actions[url.pathname.slice(5)];
        if (!action) return send(404, { error: 'Unknown action' });
        if (!req.headers['content-type']?.startsWith('application/json'))
          return send(415, { error: 'JSON required' });
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 16384) return send(413, { error: 'Payload too large' });
        }
        const controller = new AbortController(),
          disconnected = () => controller.abort();
        // req.close 也会在正文正常读完时触发；响应关闭才代表本次连接已经结束。
        res.once('close', disconnected);
        let result;
        try {
          result = await action(JSON.parse(text || '{}'), { signal: controller.signal });
        } finally {
          res.off('close', disconnected);
        }
        if (res.destroyed) return;
        if (url.pathname === '/api/companionPackage') {
          const key = crypto.randomBytes(24).toString('hex');
          for (const [k, v] of downloads) if (Date.now() - v.at > 300000) downloads.delete(k);
          downloads.set(key, { at: Date.now(), bytes: Buffer.from(result.base64, 'base64') });
          return send(200, { filename: result.filename, url: '/download/' + key });
        }
        return send(200, result);
      } catch (e) {
        return send(e.status || 400, {
          error: String(e.message).slice(0, 300),
          ...(e.code ? { code: e.code } : {}),
        });
      }
    }
    if (req.method === 'GET' && ['/', '/app.js'].includes(url.pathname)) {
      const file = url.pathname === '/' ? 'web/index.html' : 'web/app.js';
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      const type = file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : 'text/javascript; charset=utf-8';
      const stream = fs.createReadStream(path.join(PROJECT_ROOT, file));
      let started = false;
      const start = () => {
        if (!started) {
          started = true;
          res.writeHead(200, { 'Content-Type': type });
        }
      };
      stream.on('data', (chunk) => {
        start();
        res.write(chunk);
      });
      stream.on('end', () => {
        start();
        res.end();
      });
      stream.on('error', () => {
        if (!started) send(500, { error: 'Static file unavailable' });
        else res.destroy();
      });
      res.on('close', () => stream.destroy());
      return;
    }
    send(404, { error: 'Not found' });
  });
}
module.exports = { createServer };
