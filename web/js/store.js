// 跨模块共享的页面数据；其他模块只能读取，修改通过 set 函数。
export let state = null,
  accountData = null;
export const pendingRequests = new Set(),
  modelCache = new Map(),
  // 请求开始和结束时刷新按钮可用状态，由来源选择模块提供。
  hooks = { afterBusy: () => {} };
export function setState(value) {
  state = value;
}
export function setAccountData(value) {
  return (accountData = value);
}
