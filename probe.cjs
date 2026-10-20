async function probe(provider, model) {
  const url = new URL(provider.baseUrl.replace(/\/$/, '') + '/responses');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('无效 API 地址');
  const payload = {
    model,
    input: [
      {
        role: 'user',
        content:
          'Compatibility check only. Call bridge_ping with ok true. Do not perform any other action.',
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'bridge_ping',
        description: 'Connectivity test; no side effects.',
        parameters: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: 'auto',
    max_output_tokens: 1024,
    store: false,
    stream: false,
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: 'Bearer ' + provider.apiKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      const hint =
        {
          401: '密钥无效或已过期',
          403: '密钥无权访问该模型或接口',
          404: '该地址不提供 /responses 接口（可能只支持 Chat Completions）',
          405: '该地址不接受 Responses 请求',
          429: '额度已用尽或请求过于频繁，请稍后再试或换一个供应商',
        }[response.status] || (response.status >= 500 ? '供应商服务端出错，请稍后再试' : '');
      return {
        ok: false,
        status: response.status,
        message: 'Responses 请求失败，HTTP ' + response.status + (hint ? '：' + hint : ''),
      };
    }
    const obj = await response.json();
    const valid =
      obj.object === 'response' && Array.isArray(obj.output) && obj.status === 'completed';
    const toolCall =
      valid && obj.output.some((x) => x.type === 'function_call' && x.name === 'bridge_ping');
    return {
      ok: !!toolCall,
      status: response.status,
      toolCall: !!toolCall,
      message: toolCall
        ? 'Responses 和函数调用通过；流式输出仍需 Codex 实测。'
        : '未返回完整 Responses 函数调用，未通过兼容性检测。',
    };
  } catch (e) {
    return {
      ok: false,
      message:
        e.name === 'TimeoutError'
          ? '连接超时'
          : '连接失败或返回了无法解析的响应；未显示远端错误正文以避免泄露密钥。',
    };
  }
}
// Anthropic SDK 的 base_url 不含 /v1；OpenAI 风格的 base_url 通常已含 /v1。
function nativeUrl(provider) {
  const base = provider.baseUrl.replace(/\/$/, '');
  return provider.apiMode === 'anthropic_messages'
    ? /\/v1$/.test(base)
      ? base + '/messages'
      : base + '/v1/messages'
    : base + '/chat/completions';
}
// 检测供应商在 Hermes 中登记的原生协议（Chat Completions / Anthropic Messages）能否完成一次强制函数调用，用于判断协议转换路径是否可行。
async function probeNative(provider, model) {
  const url = new URL(nativeUrl(provider));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('无效 API 地址');
  const anthropic = provider.apiMode === 'anthropic_messages';
  const prompt =
    'Compatibility check only. Call bridge_ping with ok true. Do not perform any other action.';
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const payload = anthropic
    ? {
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        tools: [
          {
            name: 'bridge_ping',
            description: 'Connectivity test; no side effects.',
            input_schema: schema,
          },
        ],
        tool_choice: { type: 'auto' },
      }
    : {
        model,
        messages: [{ role: 'user', content: prompt }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'bridge_ping',
              description: 'Connectivity test; no side effects.',
              parameters: schema,
            },
          },
        ],
        tool_choice: 'auto',
        max_tokens: 1024,
        stream: false,
      };
  const headers = anthropic
    ? {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01',
      }
    : {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: 'Bearer ' + provider.apiKey } : {}),
      };
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        message: '原生协议请求失败，HTTP ' + response.status,
      };
    const j = await response.json();
    const tool = anthropic
      ? Array.isArray(j.content) &&
        j.content.some((c) => c.type === 'tool_use' && c.name === 'bridge_ping')
      : !!j.choices?.[0]?.message?.tool_calls?.some((t) => t.function?.name === 'bridge_ping');
    return {
      ok: tool,
      status: response.status,
      message: tool ? '原生协议函数调用通过' : '原生协议未返回函数调用',
    };
  } catch (e) {
    return {
      ok: false,
      message: e.name === 'TimeoutError' ? '连接超时' : '连接失败或响应无法解析',
    };
  }
}
// 获取供应商的模型列表：OpenAI 风格 GET <base>/models；Anthropic 风格 GET <base>/v1/models（分页）。只读请求，不产生模型调用费用。
const HTTP_HINTS = {
  401: '密钥无效或已过期',
  403: '密钥无权访问',
  404: '该地址不提供模型列表接口，请手动填写模型',
  429: '请求过于频繁或额度用尽',
};
async function listModels(provider) {
  const base = provider.baseUrl.replace(/\/$/, '');
  const anthropic = provider.apiMode === 'anthropic_messages';
  const url0 = new URL(
    anthropic ? (/\/v1$/.test(base) ? base + '/models' : base + '/v1/models') : base + '/models',
  );
  if (!['http:', 'https:'].includes(url0.protocol) || url0.username || url0.password)
    throw Error('无效 API 地址');
  const headers = anthropic
    ? { 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' }
    : provider.apiKey
      ? { Authorization: 'Bearer ' + provider.apiKey }
      : {};
  const ids = new Set();
  let after = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(url0);
    if (anthropic) {
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
    }
    let r;
    try {
      r = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw Error(e.name === 'TimeoutError' ? '获取模型列表超时' : '连接失败，请检查 API 地址');
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw Error(
        '获取模型列表失败，HTTP ' +
          r.status +
          (HTTP_HINTS[r.status] ? '：' + HTTP_HINTS[r.status] : ''),
      );
    }
    let j;
    try {
      j = await r.json();
    } catch {
      throw Error('模型列表格式无法识别，请手动填写模型');
    }
    const items = Array.isArray(j)
      ? j
      : Array.isArray(j?.data)
        ? j.data
        : Array.isArray(j?.models)
          ? j.models
          : null;
    if (!items) throw Error('模型列表格式无法识别，请手动填写模型');
    for (const m of items) {
      const id = typeof m === 'string' ? m : m?.id || m?.name;
      if (typeof id === 'string' && id.trim() && id.length <= 200)
        ids.add(id.trim().replace(/^models\//, ''));
    }
    if (!(anthropic && j.has_more && j.last_id)) break;
    after = j.last_id;
  }
  return [...ids].sort((a, b) => a.localeCompare(b)).slice(0, 1000);
}
module.exports = { probe, probeNative, nativeUrl, listModels };
