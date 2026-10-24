// 在假页面里执行真实的 web/js 页面模块，供前端行为测试使用（不是测试文件本身）。
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');

// 任意属性、调用都返回自身的假元素，只记录页面实际写入的属性，供断言读取。
function element() {
  const props = {};
  // 与浏览器一致：replaceChildren 替换、append 追加元素的文字内容，后渲染会覆盖先写入的提示。
  const text = (node) =>
    typeof node === 'string' ? node : typeof node?.textContent === 'string' ? node.textContent : '';
  const self = new Proxy(function () {}, {
    get: (_, key) => {
      if (key === 'then') return undefined;
      if (key === 'replaceChildren')
        return (...nodes) => (props.textContent = nodes.map(text).join(''));
      if (key === 'append')
        return (...nodes) =>
          (props.textContent =
            (typeof props.textContent === 'string' ? props.textContent : '') +
            nodes.map(text).join(''));
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

// 页面首屏后会检查更新；测试默认得到“已是最新”，需要时用 update 参数指定。
const latestUpdate = {
  current: { version: '0.1.3', build: 'test', sequence: 1 },
  latest: { version: '0.1.3', build: 'test', sequence: 1 },
  checkedAt: '2026-10-23T00:00:00.000Z',
  status: 'idle',
};
// respond(route, body) 返回 { status, body }；route 是去掉 /api/ 的接口名。
async function runPage({ hash = '', respond, confirm = () => true, update = latestUpdate }) {
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
  // 记录页面新建的元素，测试据此检查下载链接等动态内容。
  const created = [];
  document.createElement = (tag) => {
    const node = element();
    created.push({ tag, node });
    return node;
  };
  const context = {
    document,
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_, __, url) => history.push(url) },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', headers: options.headers || {}, body });
      pending++;
      const route = url.replace(/^\/api\//, '');
      const reply = await Promise.resolve(
        route === 'checkUpdate' ? { body: update } : respond(route, body),
      ).finally(() => pending--);
      const status = reply.status ?? 200;
      return { status, ok: status < 300, json: async () => reply.body ?? {} };
    },
    confirm,
    prompt: () => null,
    console,
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    // 返回非零编号，页面据此判断定时刷新已开启；回调本身不执行。
    setInterval: () => 1,
    clearInterval: () => {},
    queueMicrotask,
  };
  context.window = context;
  vm.createContext(context);
  // 每个假页面独立加载一套模块（需要 node --experimental-vm-modules），互不共享模块状态。
  const modules = new Map();
  const load = (file) => {
    if (!modules.has(file))
      modules.set(
        file,
        new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { context, identifier: file }),
      );
    return modules.get(file);
  };
  const main = load(path.join(__dirname, '..', 'web', 'js', 'main.js'));
  await main.link((specifier, referrer) =>
    load(path.resolve(path.dirname(referrer.identifier), specifier)),
  );
  await main.evaluate();
  await settle();
  return {
    requests,
    history,
    byId,
    workspace,
    created,
    settle,
    calls: (route) => requests.filter((r) => r.url === '/api/' + route),
  };
}

module.exports = { runPage };
