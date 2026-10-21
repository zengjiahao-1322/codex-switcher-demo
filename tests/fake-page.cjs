// 在假页面里执行真实的 web/app.js，供前端行为测试使用（不是测试文件本身）。
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');

// 任意属性、调用都返回自身的假元素，只记录页面实际写入的属性，供断言读取。
function element() {
  const props = {};
  const self = new Proxy(function () {}, {
    get: (_, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return () => [][Symbol.iterator]();
      return key in props ? props[key] : self;
    },
    set: (_, key, value) => {
      // 与浏览器一致：表单值总是字符串，选择不存在的选项得到空字符串。
      props[key] = key === 'value' ? (value == null ? '' : String(value)) : value;
      return true;
    },
    apply: () => self,
    construct: () => self,
  });
  return self;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// respond(route, body) 返回 { status, body }；route 是去掉 /api/ 的接口名。
async function runPage({ hash = '', respond, confirm = () => true }) {
  const elements = new Map(),
    requests = [],
    history = [];
  let pending = 0;
  // 等到页面没有进行中的请求，且后续回调也没有再发出新请求。
  const settle = async () => {
    do await tick();
    while (pending);
    await tick();
    if (pending) await settle();
  };
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const document = element();
  document.getElementById = byId;
  const workspace = element();
  document.querySelector = (selector) => (selector === '.workspace' ? workspace : element());
  const context = {
    document,
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_, __, url) => history.push(url) },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', headers: options.headers || {}, body });
      pending++;
      const reply = await Promise.resolve(respond(url.replace(/^\/api\//, ''), body)).finally(
        () => pending--,
      );
      const status = reply.status ?? 200;
      return { status, ok: status < 300, json: async () => reply.body ?? {} };
    },
    confirm,
    prompt: () => null,
    console,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask,
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), context);
  await settle();
  return {
    requests,
    history,
    byId,
    workspace,
    settle,
    calls: (route) => requests.filter((r) => r.url === '/api/' + route),
  };
}

module.exports = { runPage };
