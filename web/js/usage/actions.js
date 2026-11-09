import { api } from '../api.js';

// 用量页的三个后台接口，参数和返回格式见 collab/next-batch-tasks.md 第 3 轮。
export const summary = (client, range) => api('usage', { client, range });
export const requests = (query) => api('usageRequests', query);
export const refreshPrices = () => api('usagePrices', {});
