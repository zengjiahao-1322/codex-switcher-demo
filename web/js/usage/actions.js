import { api } from '../api.js';

// 用量页的后台接口，参数和返回格式见 collab/next-batch-tasks.md 第 3 轮。价格簿过期时后台自己更新。
export const summary = (client, range) => api('usage', { client, range });
export const requests = (query) => api('usageRequests', query);
