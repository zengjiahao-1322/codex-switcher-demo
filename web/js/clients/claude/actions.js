import { api } from '../../api.js';

export const apply = (id, model, fastModel) => api('claudeApply', { id, model, ...(fastModel ? { fastModel } : {}) });
export const restore = () => api('claudeRestore', {});
export const probe = (id, model) => api('claudeProbe', { id, model });
export const autostart = () => api('autostart', { enabled: true });
export const models = (id) => api('models', { id });
