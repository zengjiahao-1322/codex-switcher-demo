'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {isRust}=require('./backend.cjs');const {fixture,collect}=require('./fixtures/claude-stream.cjs');
const rustOnly={skip:!isRust&&'Claude 流式仅 Rust 实现'};
function blocks(rows){let active=null,next=0;for(const {value:v} of rows){if(v.type==='content_block_start'){assert.equal(active,null);assert.equal(v.index,next++);active=v.index;}if(v.type==='content_block_delta')assert.equal(v.index,active);if(v.type==='content_block_stop'){assert.equal(v.index,active);active=null;}}assert.equal(active,null);}
for(const mode of ['responses','chat_completions'])test(mode+'文字实时到达且保留token和缓存',rustOnly,async t=>{
 const f=await fixture(t,mode),r=await f.request(),rows=await collect(r);assert.equal(r.status,200);assert.equal(f.requests[0].body.stream,true);if(mode==='chat_completions')assert.deepEqual(f.requests[0].body.stream_options,{include_usage:true});
 const first=rows.find(r=>r.value.delta?.type==='text_delta');const last=f.times().filter(r=>r.event.delta||r.event.choices?.[0]?.delta?.content).at(-1);t.diagnostic(JSON.stringify({mode,firstTextAt:first.at,lastUpstreamTextAt:last.at,leadMs:last.at-first.at}));assert.ok(first.at<last.at,JSON.stringify({first,last}));assert.equal(rows.filter(r=>r.value.delta?.type==='text_delta').map(r=>r.value.delta.text).join(''),'流式-ok');assert.deepEqual(rows.find(r=>r.value.type==='message_delta').value.usage,{input_tokens:12,output_tokens:5,cache_read_input_tokens:3});assert.equal(rows[0].value.type,'message_start');assert.equal(rows.at(-1).value.type,'message_stop');blocks(rows);
});
for(const mode of ['responses','chat_completions'])test(mode+'工具分段收齐并按编号输出完整参数',rustOnly,async t=>{
 const f=await fixture(t,mode);f.set({kind:'tools'});const rows=await collect(await f.request());blocks(rows);const start=rows.filter(r=>r.value.content_block?.type==='tool_use');assert.deepEqual(start.map(r=>r.value.content_block.id),mode==='responses'?['call0']:['call0','call1']);const args=rows.filter(r=>r.value.delta?.type==='input_json_delta').map(r=>JSON.parse(r.value.delta.partial_json));assert.deepEqual(args,mode==='responses'?[{path:'x'}]:[{a:'x'},{b:'x'}]);assert.equal(rows.find(r=>r.value.type==='message_delta').value.delta.stop_reason,'tool_use');assert.equal(f.requests[0].body.parallel_tool_calls,undefined);
});
test('thinking开关、签名及块关闭顺序',rustOnly,async t=>{for(const mode of ['responses','chat_completions']){const f=await fixture(t,mode);for(const enabled of [true,false]){f.set({kind:'thinking'});const rows=await collect(await f.request(enabled?{thinking:{type:'enabled',budget_tokens:16}}:{}));blocks(rows);assert.equal(rows.some(r=>r.value.delta?.type==='thinking_delta'),enabled);const sig=rows.find(r=>r.value.delta?.type==='signature_delta');assert.equal(sig?.value.delta.signature,enabled?'codex-switcher':undefined);}}});
test('中途断开和错误JSON输出error、初始HTTP错误保留状态', rustOnly, async (t) => {
  for (const mode of ['responses', 'chat_completions']) {
    const f = await fixture(t, mode);
    const cases = [
      [{ kind: 'disconnect' }, '上游连接中断'],
      [{ kind: 'eof' }, '上游连接中断'],
      [{ kind: 'error' }, 'fixture midstream failure'],
    ];
    if (mode === 'responses') {
      cases.push(
        [{ kind: 'error', event: { type: 'error', message: 'fixture response error' } }, 'fixture response error'],
        [{ kind: 'error', event: { type: 'response.failed', response: { error: { message: 'fixture response failed' } } } }, 'fixture response failed'],
      );
    }
    for (const [scenario, message] of cases) {
      f.set(scenario);
      const rows = await collect(await f.request());
      assert.equal(rows.at(-1).value.type, 'error');
      assert.equal(rows.at(-1).value.error.message, message);
      assert.ok(rows.some(r => r.value.delta?.text === 'partial'));
      assert.equal(rows.some(r => r.value.type === 'message_stop'), false);
    }
    f.set({ kind: 'http-error' });
    const response = await f.request();
    assert.equal(response.status, 429);
    assert.match(response.headers.get('content-type'), /json/);
    assert.match((await response.json()).error.message, /fixture rate limit/);
  }
});
test('非流式回归及max_tokens结束原因',rustOnly,async t=>{for(const mode of ['responses','chat_completions']){const f=await fixture(t,mode);const r=await f.request({stream:false});assert.equal(r.status,200);const value=await r.json();assert.equal(value.content[0].text,'stream-ok');assert.equal(f.requests[0].body.stream,false);f.set({kind:'text',reason:'length'});const rows=await collect(await f.request());assert.equal(rows.find(r=>r.value.type==='message_delta').value.delta.stop_reason,'max_tokens');}});
test('2xx后立即message_start、空闲十秒ping且总超时仍生效',rustOnly,async t=>{const f=await fixture(t);f.set({kind:'idle'});const rows=await collect(await f.request());assert.equal(rows[0].value.type,'message_start');assert.ok(rows.find(r=>r.value.type==='ping').at-rows[0].at>=9900);assert.ok(rows[0].at<f.times()[0].at);const fs=require('fs'),path=require('path');const file=path.join(f.bridge,'providers.json'),value=JSON.parse(fs.readFileSync(file));value.providers[0].timeoutMs=100;fs.writeFileSync(file,JSON.stringify(value));f.set({kind:'timeout'});const failed=await collect(await f.request());assert.equal(failed.at(-1).value.type,'error');assert.match(failed.at(-1).value.error.message,/timed out/);});
