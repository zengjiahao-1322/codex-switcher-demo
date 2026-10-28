'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs'),
  path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
async function adapter(t, provider) {
  const write = (bridge, port) => {
    fs.writeFileSync(
      path.join(bridge, 'providers.json'),
      JSON.stringify({
        providers: [
          { id: 'bridge:adapter-fixture', name: 'Fixture', origin: 'custom', ...provider },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(bridge, 'adapter.json'),
      JSON.stringify({
        port,
        token: 'adapter-fixture-token',
        target: {
          providerId: 'bridge:adapter-fixture',
          model: provider.model,
          apiMode: provider.apiMode,
        },
      }),
    );
  };
  const f = await startBackend(t, {
    setup({ bridge, environment }) {
      write(bridge, Number(environment.BRIDGE_PORT));
    },
  });
  return {
    ...f,
    provider,
    url: f.url.origin + '/v1/responses',
    close: async () => {},
    fetch(options = {}) {
      write(f.bridge, Number(f.url.port));
      const headers = new Headers(options.headers);
      if (!headers.has('Authorization'))
        headers.set('Authorization', 'Bearer adapter-fixture-token');
      return f.request('/v1/responses', {
        ...options,
        headers,
      });
    },
  };
}
async function serve(fn) {
  const s = http.createServer(fn);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${s.address().port}`,
    close: () =>
      new Promise((r) => {
        s.close(r);
        s.closeAllConnections();
      }),
  };
}
async function fixture(t, mode = 'chat_completions', reply) {
  let captured;
  const upstream = await serve(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    captured = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        reply ?? {
          choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        },
      ),
    );
  });
  const provider = {
    baseUrl: upstream.url + '/v1',
    apiMode: mode,
    apiKey: 'mock-provider-secret',
    model: 'mock-model',
  };
  const bridge = await adapter(t, provider);
  t.after(async () => {
    await bridge.close();
    await upstream.close();
  });
  return {
    provider,
    captured: () => captured,
    request: (body) =>
      bridge.fetch({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer adapter-fixture-token',
        },
        body: JSON.stringify(body),
      }),
  };
}

test('Fast 档位转发给 Chat Completions，响应仅保留上游实际返回的档位', async (t) => {
  const f = await fixture(t, 'chat_completions', {
    choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
    service_tier: 'priority',
  });
  const r = await f.request({ input: 'hi', service_tier: 'fast' });
  assert.equal(f.captured().body.service_tier, 'priority');
  assert.equal((await r.json()).service_tier, 'priority');
  const g = await fixture(t);
  const plain = await g.request({ input: 'hi', service_tier: 'priority' });
  assert.equal((await plain.json()).service_tier, undefined);
});

test('Anthropic 转换拒绝 Fast，不丢弃参数后假装加速成功', async (t) => {
  const f = await fixture(t, 'anthropic_messages');
  const r = await f.request({ input: 'hi', service_tier: 'priority' });
  assert.equal(r.status, 400);
  assert.equal(f.captured(), undefined);
});
test('local mock chat function history and complete tool output', async (t) => {
  const f = await fixture(t, 'chat_completions', {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'call2', type: 'function', function: { name: 'lookup', arguments: '{"x":2}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  const r = await f.request({
    instructions: 'tools',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'lookup' }] },
      { type: 'function_call', call_id: 'call1', name: 'lookup', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call1', output: 'one' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'next' }] },
    ],
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object', properties: { x: { type: 'number' } } },
        strict: true,
      },
    ],
    tool_choice: { type: 'function', name: 'lookup' },
  });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.output[0].type, 'function_call');
  assert.equal(b.output[0].call_id, 'call2');
  assert.equal(b.output[0].arguments, '{"x":2}');
  assert.equal(f.captured().body.messages[2].tool_calls[0].id, 'call1');
  assert.equal(f.captured().body.messages[3].role, 'tool');
  assert.equal(f.captured().body.tools[0].function.strict, true);
  assert.deepEqual(f.captured().body.tool_choice, {
    type: 'function',
    function: { name: 'lookup' },
  });
});
test('local mock Anthropic maps tools and results, excludes hidden thinking', async (t) => {
  const f = await fixture(t, 'anthropic_messages', {
    content: [
      { type: 'thinking', thinking: 'private', signature: 'private' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'a2', name: 'lookup', input: { x: 2 } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 6 },
  });
  const r = await f.request({
    instructions: 'system',
    input: [
      { role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'a1', name: 'lookup', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'a1', output: 'one' },
    ],
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    tool_choice: 'required',
    max_output_tokens: 99,
  });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.output[0].content[0].text, 'answer');
  assert.equal(b.output[1].arguments, '{"x":2}');
  assert.equal(JSON.stringify(b).includes('private'), false);
  const c = f.captured();
  assert.equal(c.url, '/v1/messages');
  assert.equal(c.headers['x-api-key'], 'mock-provider-secret');
  assert.equal(c.body.system, 'system');
  assert.equal(c.body.messages[2].content[0].type, 'tool_result');
  assert.equal(c.body.max_tokens, 99);
  assert.deepEqual(c.body.tool_choice, { type: 'any' });
  assert.equal(b.usage.total_tokens, 11);
});
test('buffered SSE has ordered lifecycle, text and complete arguments', async (t) => {
  const f = await fixture(t, 'chat_completions', {
    choices: [
      {
        message: {
          content: '你好',
          reasoning_content: 'hidden',
          tool_calls: [
            {
              id: 'call_s',
              type: 'function',
              function: { name: 'lookup', arguments: '{"city":"台北"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  const r = await f.request({ input: 'hi', stream: true });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.equal(r.headers.get('x-bridge-streaming'), 'buffered');
  const text = await r.text();
  assert.equal(text.includes('hidden'), false);
  const events = text
    .trim()
    .split('\n\n')
    .map((s) => JSON.parse(s.split('\ndata: ')[1]));
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.at(-1).type, 'response.completed');
  events.forEach((e, i) => assert.equal(e.sequence_number, i));
  assert.equal(events.find((e) => e.type === 'response.output_text.delta').delta, '你好');
  assert.equal(
    events.find((e) => e.type === 'response.function_call_arguments.done').arguments,
    '{"city":"台北"}',
  );
  assert.equal(events.at(-1).response.output.length, 2);
  assert.equal(f.captured().body.stream, false);
});
test('upstream HTTP errors sanitized and redirects never followed', async (t) => {
  let leaked = 0;
  const sink = await serve((q, s) => {
    leaked++;
    s.end('{}');
  });
  const up = await serve((q, s) => {
    if (q.url.includes('redirect')) {
      s.writeHead(307, { location: sink.url });
      s.end();
    } else {
      s.writeHead(429);
      s.end('mock-provider-secret sensitive upstream text');
    }
  });
  const p = {
    baseUrl: up.url,
    model: 'mock',
    apiMode: 'chat_completions',
    apiKey: 'mock-provider-secret',
  };
  const bridge = await adapter(t, p);
  t.after(async () => {
    await bridge.close();
    await up.close();
    await sink.close();
  });
  let r = await bridge.fetch({
    method: 'POST',
    body: JSON.stringify({ input: 'hi', stream: true }),
  });
  assert.equal(r.status, 429);
  assert.equal((await r.text()).includes('secret'), false);
  p.baseUrl = up.url + '/redirect';
  r = await bridge.fetch({ method: 'POST', body: JSON.stringify({ input: 'hi' }) });
  assert.equal(r.status, 502);
  assert.equal(leaked, 0);
});
test('timeout aborts upstream and reports 504', async (t) => {
  let disconnected;
  const closed = new Promise((r) => (disconnected = r));
  const up = await serve((q, s) => {
    s.on('close', disconnected);
  });
  const bridge = await adapter(t, {
    baseUrl: up.url,
    apiMode: 'chat_completions',
    model: 'mock',
    apiKey: 'mock',
    timeoutMs: 80,
  });
  t.after(async () => {
    await bridge.close();
    await up.close();
  });
  const r = await bridge.fetch({ method: 'POST', body: JSON.stringify({ input: 'hi' }) });
  assert.equal(r.status, 504);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(Error('not cancelled')), 1000).unref()),
  ]);
});
test('client disconnect cancels upstream', async (t) => {
  let started, closed;
  const ready = new Promise((r) => (started = r)),
    ended = new Promise((r) => (closed = r));
  const up = await serve((q, s) => {
    s.on('close', closed);
    started();
  });
  const bridge = await adapter(t, {
    baseUrl: up.url,
    apiMode: 'chat_completions',
    model: 'mock',
    apiKey: 'mock',
    timeoutMs: 1000,
  });
  t.after(async () => {
    await bridge.close();
    await up.close();
  });
  const controller = new AbortController();
  const pending = bridge
    .fetch({
      method: 'POST',
      body: JSON.stringify({ input: 'hi' }),
      signal: controller.signal,
    })
    .catch(() => {});
  await ready;
  controller.abort();
  await pending;
  await Promise.race([
    ended,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('disconnect not propagated')), 500).unref(),
    ),
  ]);
});
test('parallel tool calls are grouped and all tool results survive Anthropic conversion', async (t) => {
  const f = await fixture(t, 'anthropic_messages', {
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
  });
  const r = await f.request({
    input: [
      { role: 'developer', content: 'dev' },
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      ...['c1', 'c2'].map((call_id) => ({
        type: 'function_call',
        call_id,
        name: 'f',
        arguments: '{}',
      })),
      ...['c1', 'c2'].map((call_id) => ({ type: 'function_call_output', call_id, output: 'ok' })),
    ],
  });
  assert.equal(r.status, 200);
  const b = f.captured().body;
  assert.match(b.system, /dev/);
  assert.match(b.system, /sys/);
  assert.equal(b.messages.length, 3);
  assert.equal(b.messages[1].content.length, 2);
  assert.equal(b.messages[2].content.length, 2);
});
test('truncation is incomplete, malformed tool output fails instead of fake success', async (t) => {
  const f = await fixture(t, 'chat_completions', {
    choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
  });
  let r = await f.request({ input: 'hi', max_output_tokens: 12 });
  let b = await r.json();
  assert.equal(b.status, 'incomplete');
  assert.equal(b.incomplete_details.reason, 'max_output_tokens');
  assert.equal(f.captured().body.max_completion_tokens, 12);
  const g = await fixture(t, 'chat_completions', {
    choices: [
      {
        message: {
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{"' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  r = await g.request({ input: 'hi' });
  assert.equal(r.status, 502);
});
test('unsupported apiMode never silently uses chat', async (t) => {
  const f = await fixture(t);
  f.provider.apiMode = 'unknown';
  assert.equal((await f.request({ input: 'hi' })).status, 400);
  assert.equal(f.captured(), undefined);
});
test('unknown upstream visible blocks and non-text chat output fail closed', async (t) => {
  for (const [mode, reply] of [
    ['anthropic_messages', { content: [{ type: 'server_tool_use', name: 'web_search' }] }],
    ['chat_completions', { choices: [{ message: { content: [{ type: 'image', url: 'x' }] } }] }],
  ]) {
    const f = await fixture(t, mode, reply);
    assert.equal((await f.request({ input: 'hi' })).status, 502);
  }
});
test('local mock chat text uses trusted model/key and instructions', async (t) => {
  const f = await fixture(t);
  const r = await f.request({
    input: 'hi',
    instructions: 'be brief',
    model: 'attacker-model',
    apiKey: 'attacker',
  });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.object, 'response');
  assert.equal(b.output[0].content[0].text, 'hello');
  assert.equal(b.status, 'completed');
  assert.equal(f.captured().headers.authorization, 'Bearer mock-provider-secret');
  assert.equal(f.captured().body.model, 'mock-model');
  assert.deepEqual(f.captured().body.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(f.captured().url, '/v1/chat/completions');
});
const codexLike = () => ({
  model: 'ignored',
  stream: true,
  store: false,
  parallel_tool_calls: true,
  tool_choice: 'auto',
  reasoning: { summary: 'auto', effort: 'high' },
  include: ['reasoning.encrypted_content'],
  prompt_cache_key: 'k',
  client_metadata: { session_id: 's' },
  text: { verbosity: 'low' },
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev rules' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'reasoning', summary: [], encrypted_content: 'opaque' },
  ],
  tools: [
    {
      type: 'function',
      name: 'exec_command',
      description: 'run',
      strict: false,
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
    },
    {
      type: 'namespace',
      name: 'multi_agent_v1',
      description: 'agents',
      tools: [
        {
          type: 'function',
          name: 'spawn_agent',
          description: 'spawn',
          strict: false,
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
    {
      type: 'custom',
      name: 'apply_patch',
      description: 'patch files',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch' },
    },
    { type: 'web_search', external_web_access: false },
  ],
});
const sseEvents = (text) =>
  text
    .trim()
    .split('\n\n')
    .map((s) => JSON.parse(s.split('\ndata: ')[1]));
function normalizedEvents(events) {
  const names = new Map(),
    counts = {};
  return JSON.parse(
    JSON.stringify(events, (key, value) => {
      if (key === 'created_at') return 0;
      if (
        (key === 'id' || key === 'item_id') &&
        typeof value === 'string' &&
        /^(resp|msg|fc|ctc)_[a-f0-9]{32}$/.test(value)
      ) {
        if (!names.has(value)) {
          const prefix = value.split('_')[0];
          counts[prefix] = (counts[prefix] || 0) + 1;
          names.set(value, prefix + '_FIXTURE_' + counts[prefix]);
        }
        return names.get(value);
      }
      return value;
    }),
  );
}
test('adapter完整事件样例：文本/函数/命名空间/custom/截断/Anthropic逐个事件与Node基准全等', async (t) => {
  const vectors = require('./fixtures/adapter-events.json');
  for (const vector of vectors) {
    const f = await fixture(t, vector.mode, vector.upstream);
    const response = await f.request(vector.input);
    assert.equal(response.status, 200, vector.name);
    assert.deepEqual(
      normalizedEvents(sseEvents(await response.text())),
      vector.expected,
      vector.name,
    );
    assert.deepEqual(f.captured().body, vector.payload, vector.name);
  }
});
test('real Codex request shape is accepted: reasoning/include/metadata ignored, tools flattened, built-ins dropped', async (t) => {
  const f = await fixture(t);
  const r = await f.request(codexLike());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-bridge-dropped-tools'), 'web_search');
  const events = sseEvents(await r.text());
  assert.equal(events.at(-1).type, 'response.completed');
  const b = f.captured().body;
  assert.deepEqual(
    b.tools.map((x) => x.function.name),
    ['exec_command', 'multi_agent_v1__spawn_agent', 'apply_patch'],
  );
  assert.deepEqual(b.tools[2].function.parameters.required, ['input']);
  assert.match(b.tools[2].function.description, /start: begin_patch/);
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.messages.length, 2);
  for (const k of [
    'reasoning',
    'reasoning_effort',
    'include',
    'prompt_cache_key',
    'client_metadata',
    'parallel_tool_calls',
    'store',
    'text',
  ])
    assert.equal(k in b, false, k);
  assert.equal(JSON.stringify(b).includes('opaque'), false);
});
test('namespace and custom tool calls round-trip between Codex items and chat tool_calls', async (t) => {
  const f = await fixture(t, 'chat_completions', {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'multi_agent_v1__spawn_agent', arguments: '{}' },
            },
            {
              id: 'c2',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  const body = codexLike();
  body.stream = false;
  body.input.push(
    {
      type: 'function_call',
      call_id: 'h1',
      name: 'spawn_agent',
      namespace: 'multi_agent_v1',
      arguments: '{}',
    },
    {
      type: 'function_call_output',
      call_id: 'h1',
      output: [
        { type: 'input_text', text: 'spawned' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA' },
      ],
    },
    { type: 'custom_tool_call', call_id: 'h2', name: 'apply_patch', input: 'PATCH' },
    { type: 'custom_tool_call_output', call_id: 'h2', output: 'Done' },
  );
  const r = await f.request(body);
  assert.equal(r.status, 200);
  const out = (await r.json()).output;
  assert.deepEqual(
    [out[0].type, out[0].name, out[0].namespace],
    ['function_call', 'spawn_agent', 'multi_agent_v1'],
  );
  assert.deepEqual(
    [out[1].type, out[1].name, out[1].input, out[1].call_id],
    ['custom_tool_call', 'apply_patch', '*** Begin Patch\n*** End Patch', 'c2'],
  );
  const m = f.captured().body.messages;
  assert.equal(m[2].tool_calls[0].function.name, 'multi_agent_v1__spawn_agent');
  assert.match(m[3].content, /spawned/);
  assert.match(m[3].content, /image omitted/);
  assert.equal(m[4].tool_calls[0].function.arguments, JSON.stringify({ input: 'PATCH' }));
  assert.equal(m[5].content, 'Done');
});
test('streamed custom tool call emits complete input events', async (t) => {
  const f = await fixture(t, 'chat_completions', {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: 'c2',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{"input":"P"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  const events = sseEvents(await (await f.request(codexLike())).text());
  events.forEach((e, i) => assert.equal(e.sequence_number, i));
  assert.equal(
    events.find((e) => e.type === 'response.output_item.done').item.type,
    'custom_tool_call',
  );
  assert.equal(events.find((e) => e.type === 'response.custom_tool_call_input.done').input, 'P');
});
test('still rejects state, malformed calls and unknown shapes before upstream', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { input: 'hi', previous_response_id: 'resp_x' },
    { input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: 'not json' }] },
    { input: 'hi', tool_choice: { type: 'allowed_tools', tools: [] } },
    { input: [{ role: 'unknown', content: 'x' }] },
    { input: 'hi', background: true },
    { input: 'hi', text: { format: { type: 'json_schema' } } },
    { input: [{ type: 'weird_item' }] },
    { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'f' }] }] },
  ]) {
    const r = await f.request(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).error.type, 'invalid_request_error');
  }
  assert.equal(f.captured(), undefined);
});
test('user images are forwarded to chat and Anthropic', async (t) => {
  const img = {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
    ],
  };
  const f = await fixture(t);
  assert.equal((await f.request({ input: [img] })).status, 200);
  assert.deepEqual(f.captured().body.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,QUJD' },
  });
  const a = await fixture(t, 'anthropic_messages', { content: [{ type: 'text', text: 'ok' }] });
  assert.equal((await a.request({ input: [img] })).status, 200);
  assert.deepEqual(a.captured().body.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
  });
});
test('Anthropic accepts the Codex request shape, appends /v1 for SDK-style base URLs and maps namespace calls back', async (t) => {
  let captured;
  const up = await serve(async (q, s) => {
    let raw = '';
    for await (const c of q) raw += c;
    captured = { url: q.url, body: JSON.parse(raw) };
    s.setHeader('content-type', 'application/json');
    s.end(
      JSON.stringify({
        content: [
          { type: 'thinking', thinking: 'x' },
          { type: 'tool_use', id: 't1', name: 'multi_agent_v1__spawn_agent', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  const bridge = await adapter(t, {
    baseUrl: up.url + '/claude',
    apiMode: 'anthropic_messages',
    apiKey: 'k',
    model: 'm',
  });
  t.after(async () => {
    await bridge.close();
    await up.close();
  });
  const body = codexLike();
  body.stream = false;
  body.tools[0].strict = true;
  const r = await bridge.fetch({ method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  const out = (await r.json()).output;
  assert.deepEqual([out[0].name, out[0].namespace], ['spawn_agent', 'multi_agent_v1']);
  assert.equal(captured.url, '/claude/v1/messages');
  assert.equal(captured.body.system, 'dev rules');
  assert.equal(captured.body.max_tokens, 32000);
  assert.equal('tool_choice' in captured.body, false);
});
test(
  'slow upstream gets heartbeats; a later failure becomes response.failed',
  { timeout: 20000 },
  async (t) => {
    const up = await serve((q, s) => {
      setTimeout(() => {
        s.writeHead(429);
        s.end('mock-provider-secret');
      }, 5600);
    });
    const bridge = await adapter(t, {
      baseUrl: up.url,
      apiMode: 'chat_completions',
      model: 'm',
      apiKey: 'mock-provider-secret',
    });
    t.after(async () => {
      await bridge.close();
      await up.close();
    });
    const r = await bridge.fetch({
      method: 'POST',
      body: JSON.stringify({ input: 'hi', stream: true }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.equal(text.includes('secret'), false);
    const events = sseEvents(text);
    assert.equal(events[0].type, 'response.created');
    assert.equal(events.at(-1).type, 'response.failed');
    assert.equal(events.at(-1).response.error.code, 'rate_limit_exceeded');
  },
);
test('over-long real MCP namespace names get stable aliases and map back', async (t) => {
  const ns = 'mcp__codex_apps__codex_document_control_',
    name = '_execute_document_command';
  let alias;
  const up = await serve(async (q, s) => {
    let raw = '';
    for await (const c of q) raw += c;
    const b = JSON.parse(raw);
    alias = b.tools[0].function.name;
    s.setHeader('content-type', 'application/json');
    s.end(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'c', type: 'function', function: { name: alias, arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        history: b.messages,
      }),
    );
  });
  const bridge = await adapter(t, {
    baseUrl: up.url,
    apiMode: 'chat_completions',
    apiKey: 'k',
    model: 'm',
  });
  t.after(async () => {
    await bridge.close();
    await up.close();
  });
  const body = {
    input: [
      { role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'h', name, namespace: ns, arguments: '{}' },
      { type: 'function_call_output', call_id: 'h', output: 'ok' },
    ],
    tools: [
      {
        type: 'namespace',
        name: ns,
        tools: [{ type: 'function', name, parameters: { type: 'object' } }],
      },
      { type: 'function', name: 'has space', parameters: { type: 'object' } },
    ],
  };
  const r = await bridge.fetch({ method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  assert.match(alias, /^[A-Za-z0-9_-]{1,64}$/);
  const out = (await r.json()).output[0];
  assert.deepEqual([out.name, out.namespace], [name, ns]);
});

test('adapter HTTP鉴权独立于UI会话，缺目标/删除配置返回503，畸形JSON在请求前拒绝', async (t) => {
  const f = await adapter(t, {
    baseUrl: 'http://127.0.0.1:9/v1',
    apiMode: 'chat_completions',
    apiKey: 'fake-only',
    model: 'm',
  });
  const send = (headers = {}, method = 'POST', body = '{"input":"hi"}') =>
    f.request('/v1/responses', { method, headers, ...(method === 'GET' ? {} : { body }) });
  assert.equal((await send({ Authorization: 'Bearer ' + f.token })).status, 401);
  assert.equal((await send()).status, 401);
  assert.equal((await send({ Authorization: 'Bearer adapter-fixture-token' }, 'GET')).status, 405);
  const malformed = await send({ Authorization: 'Bearer adapter-fixture-token' }, 'POST', '{');
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: { message: 'Malformed JSON', type: 'invalid_request_error' },
  });
  const file = path.join(f.bridge, 'adapter.json'),
    settings = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...settings, target: null }));
  const missing = await send({ Authorization: 'Bearer adapter-fixture-token' });
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), {
    error: { message: 'No adapter target configured', type: 'api_error' },
  });
  fs.writeFileSync(file, JSON.stringify(settings));
  fs.writeFileSync(path.join(f.bridge, 'providers.json'), '{"providers":[]}');
  const deleted = await send({ Authorization: 'Bearer adapter-fixture-token' });
  assert.equal(deleted.status, 503);
  assert.deepEqual(await deleted.json(), {
    error: { message: 'Adapter provider was deleted', type: 'api_error' },
  });
});

test('adapter HTTP在心跳后取消及时关闭上游，后续请求仍可用', async (t) => {
  let closed;
  const ended = new Promise((resolve) => {
    closed = resolve;
  });
  const up = await serve(async (q, s) => {
    for await (const _ of q) {
    }
    s.on('close', closed);
  });
  t.after(() => up.close());
  const f = await adapter(t, {
    baseUrl: up.url,
    apiMode: 'chat_completions',
    apiKey: 'fake-only',
    model: 'm',
  });
  const started = performance.now();
  const response = await f.fetch({
    method: 'POST',
    body: JSON.stringify({ input: 'hi', stream: true }),
  });
  assert.ok(performance.now() - started >= 4800);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /response.created/);
  const cancelled = performance.now();
  await reader.cancel();
  await Promise.race([
    ended,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('stream cancel did not close upstream')), 500),
    ),
  ]);
  t.diagnostic('Heartbeat stream cancellation: ' + (performance.now() - cancelled) + ' ms');
  assert.equal((await f.api('state')).status, 200);
});

function cpuMs(pid) {
  const { execFileSync } = require('node:child_process');
  if (process.platform === 'win32')
    return Number(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-Process -Id ' + pid + ').TotalProcessorTime.TotalMilliseconds',
        ],
        { windowsHide: true, encoding: 'utf8' },
      ).trim(),
    );
  const value = execFileSync('/bin/ps', ['-o', 'time=', '-p', String(pid)], {
    encoding: 'utf8',
  }).trim();
  return value.split(':').reduce((sum, x) => sum * 60 + Number(x), 0) * 1000;
}
test('adapter HTTP保持5秒首心跳/10秒后续心跳，等待完整JSON且记录空闲CPU原始值', async (t) => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const up = await serve(async (q, s) => {
    let raw = '';
    for await (const chunk of q) raw += chunk;
    assert.equal(JSON.parse(raw).stream, false);
    await gate;
    s.setHeader('content-type', 'application/json');
    s.end(
      JSON.stringify({ choices: [{ message: { content: 'finished' }, finish_reason: 'stop' }] }),
    );
  });
  t.after(() => {
    finish();
    return up.close();
  });
  const f = await adapter(t, {
    baseUrl: up.url,
    apiMode: 'chat_completions',
    apiKey: 'fake-only',
    model: 'm',
  });
  const started = performance.now();
  const response = await f.fetch({
    method: 'POST',
    body: JSON.stringify({ input: 'hi', stream: true }),
  });
  const reader = response.body.getReader();
  let text = '',
    observed = 0;
  const times = [];
  const next = async () => {
    while (true) {
      const events = text.includes('\n\n')
        ? sseEvents(text.slice(0, text.lastIndexOf('\n\n')))
        : [];
      const progress = events.filter((e) => e.type === 'response.in_progress').length;
      if (progress > observed) {
        observed = progress;
        times.push(performance.now() - started);
        return;
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += Buffer.from(chunk.value).toString();
    }
  };
  await next();
  const before = cpuMs(f.child.pid),
    sampleAt = performance.now();
  await next();
  const cpu = cpuMs(f.child.pid) - before,
    elapsed = performance.now() - sampleAt;
  assert.ok(times[0] >= 4800 && times[0] < 8000, 'first heartbeat ' + times[0]);
  assert.ok(
    times[1] - times[0] >= 9500 && times[1] - times[0] < 12000,
    'heartbeat interval ' + (times[1] - times[0]),
  );
  assert.doesNotMatch(text, /response.output_text.delta/);
  t.diagnostic(
    JSON.stringify({
      backend: process.env.SWITCHER_BACKEND || 'node',
      idleWaitMs: elapsed,
      cpuMs: cpu,
      heartbeatAtMs: times,
    }),
  );
  finish();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += Buffer.from(chunk.value).toString();
  }
  assert.equal(sseEvents(text).at(-1).type, 'response.completed');
});

test('adapter配置HTTP：应用/改密钥即时生效/备份恢复保留本机凭据及原始配置全文', async (t) => {
  const { api, isolatedEditor, finishJob, read } = require('./config-blackbox-helpers.cjs');
  const calls = [];
  const up = await serve(async (q, s) => {
    let raw = '';
    for await (const c of q) raw += c;
    const body = JSON.parse(raw);
    calls.push({ url: q.url, body, authorization: q.headers.authorization });
    s.setHeader('content-type', 'application/json');
    if (q.url === '/v1/responses') {
      s.writeHead(404);
      s.end('{}');
      return;
    }
    s.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'ok',
              tool_calls: body.tools
                ? [
                    {
                      id: 'ping',
                      type: 'function',
                      function: { name: 'bridge_ping', arguments: '{"ok":true}' },
                    },
                  ]
                : undefined,
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  t.after(() => up.close());
  const f = await startBackend(t);
  await isolatedEditor(t, f);
  fs.writeFileSync(path.join(f.home, 'auth.json'), '{}\n');
  const { id } = await api(f, 'providerAdd', {
    name: 'Adapter fixture',
    baseUrl: up.url + '/v1',
    apiKey: 'original-fake-key',
    apiMode: 'responses',
    model: 'm',
  });
  assert.equal((await api(f, 'probe', { id, model: 'm' })).mode, 'adapter');
  const result = await api(f, 'switch', { id, model: 'm', threadFollow: 'off', autostart: false });
  assert.equal(result.mode, 'adapter');
  const settings = JSON.parse(fs.readFileSync(path.join(f.bridge, 'adapter.json')));
  assert.deepEqual(settings.target, { providerId: id, model: 'm', apiMode: 'chat_completions' });
  const expected =
    'model = "m"\nmodel_provider = "hermes_bridge"\n[model_providers.hermes_bridge]\nname = "Adapter fixture（经本机转换）"\nbase_url = "http://127.0.0.1:' +
    settings.port +
    '/v1"\nwire_api = "responses"\nexperimental_bearer_token = "' +
    settings.token +
    '"\nrequires_openai_auth = false\n';
  assert.equal(read(f), expected);
  const invoke = () =>
    f.request('/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.token },
      body: JSON.stringify({ input: 'hi', model: 'untrusted-model' }),
    });
  assert.equal((await invoke()).status, 200);
  assert.equal(calls.at(-1).body.model, 'm');
  await api(f, 'providerUpdate', { id, apiKey: 'updated-fake-key' });
  assert.equal((await invoke()).status, 200);
  assert.equal(calls.at(-1).authorization, 'Bearer updated-fake-key');
  assert.equal(read(f), expected);
  await api(f, 'restore', { threadFollow: 'off' });
  assert.equal(
    read(f),
    'model = "blackbox-fixture"\n' +
      expected.slice(expected.indexOf('[model_providers.hermes_bridge]')),
  );
  const backup = (await api(f, 'backups', {})).items.find((x) => x.summary.includes('经本机转换'));
  assert.ok(backup);
  await api(f, 'restoreBackup', { id: backup.id, reloadEditors: false });
  await finishJob(f);
  assert.equal(read(f), expected);
  const restored = await invoke();
  assert.equal(restored.status, 200);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'adapter.json'))).target.apiMode,
    'chat_completions',
  );
  await api(f, 'providerUpdate', { id, apiMode: 'chat_completions' });
  await api(f, 'restoreBackup', { id: backup.id, reloadEditors: false });
  await finishJob(f);
  assert.equal(read(f), expected);
  assert.equal((await invoke()).status, 200);
  assert.equal(read(f, 'auth.json'), '{}\n');
});
