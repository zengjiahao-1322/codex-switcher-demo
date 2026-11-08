// Claude Code 页用到的后台接口。
import { api } from '../../api.js';

export const apply = (id, model, fastModel) =>
  api('claudeApply', { id, model, ...(fastModel ? { fastModel } : {}) });
export const restore = () => api('claudeRestore', {});
export const probe = (id, model) => api('claudeProbe', { id, model });
export const enableAutostart = () => api('autostart', { enabled: true });
export const fetchModels = (id) => api('models', { id });
