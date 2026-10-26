'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createRouter, createElectronTransport, parseCompletion } = require('../meeting-copilot/multimodal-router.cjs');
const defaultsDirectory = path.resolve(__dirname, '../meeting-copilot/prompts');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from('encrypted:' + value.split('').reverse().join('')),
  decryptString: buffer => buffer.toString().slice(10).split('').reverse().join('')
};
const completion = text => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: text } }] }) });
function fixture(t, transport) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-router-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const router = createRouter({ directory, defaultsDirectory, safeStorage, transport });
  router.initialize();
  const config = router.getPublic();
  config.endpoints = Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), enabled: true, baseUrl: `https://test${i}.invalid/v1`, model: `test-model-${i}`, apiKey: `secret-${i}`, timeoutMs: 5000 }));
  router.applyPatch(config);
  return { router, directory };
}

test('four slots, encrypted persistence, redacted public settings, key preservation and clearing', t => {
  const { router, directory } = fixture(t, async () => completion('ok'));
  const saved = fs.readFileSync(path.join(directory, 'interfaces.json'), 'utf8');
  assert.equal(saved.includes('secret-'), false);
  assert.equal(router.getPublic().endpoints.length, 4);
  assert.equal(JSON.stringify(router.getPublic()).includes('apiKeyEncrypted'), false);
  const config = router.getPublic();
  config.mode = 'written';
  router.applyPatch(config);
  assert.ok(router.getPublic().endpoints[0].apiKeySet);
  config.endpoints[0].apiKey = '';
  router.applyPatch(config);
  assert.equal(router.getPublic().endpoints[0].apiKeySet, false);
  const next = createRouter({ directory, defaultsDirectory, safeStorage, transport: async () => completion('ok') });
  next.initialize();
  assert.equal(next.getPublic().mode, 'written');
});

test('migrates the existing vision configuration once and never overwrites it on restart', t => {
  const { directory } = fixture(t, async () => completion('ok'));
  fs.unlinkSync(path.join(directory, 'interfaces.json'));
  const next = createRouter({ directory, defaultsDirectory, safeStorage, transport: async () => completion('ok') });
  next.initialize({ baseUrl: 'https://vision.invalid/v1', model: 'vision-id', apiKey: 'private-key', proxyUrl: 'http://localhost:7890' });
  assert.equal(next.getPublic().endpoints[0].model, 'vision-id');
  assert.equal(next.getPublic().endpoints[0].apiKeySet, true);
  assert.equal(next.getPublic().endpoints.length, 1);
  next.initialize({ baseUrl: 'https://different.invalid', model: 'different', apiKey: 'other' });
  assert.equal(next.getPublic().endpoints[0].model, 'vision-id');
});

test('HTTP error, explicit refusal, empty answer, then fourth model succeeds with identical image and prompt', async t => {
  const calls = [];
  const replies = [{ status: 429, body: 'do not expose provider details' }, { status: 200, body: JSON.stringify({ choices: [{ message: { refusal: 'blocked' } }] }) }, completion(''), completion('第四个模型的答案')];
  const { router } = fixture(t, async (config, messages) => { calls.push({ config, messages }); return replies.shift(); });
  const messages = router.buildMessages({ question: '这道题怎么做？', imageDataUrl: 'data:image/png;base64,dGVzdA==' }, 'shot');
  const progress = [];
  assert.equal(await router.chat(messages, undefined, m => progress.push(m)), '第四个模型的答案');
  assert.equal(calls.length, 4);
  assert.equal(calls[0].config.apiKey, 'secret-0');
  for (const call of calls) assert.deepEqual(call.messages, messages);
  assert.ok(progress.some(p => p.includes('切换备用')));
});

test('timeout aborts first request and succeeds on backup even if first transport ignores abort', async t => {
  let count = 0;
  let firstSignal;
  const { router } = fixture(t, async (config, messages, signal) => {
    if (count++ === 0) { firstSignal = signal; return new Promise(() => {}); }
    return completion('备用成功');
  });
  const start = Date.now();
  assert.equal(await router.chat([]), '备用成功');
  assert.ok(Date.now() - start < 7000);
  assert.equal(firstSignal.aborted, true);
  assert.equal(count, 2);
});

test('cancellation during a request stops the chain without trying a backup or returning a late result', async t => {
  let calls = 0;
  let notify;
  const started = new Promise(r => { notify = r; });
  const { router } = fixture(t, async () => { calls++; notify(); return new Promise(resolve => setTimeout(() => resolve(completion('late')), 40)); });
  const ac = new AbortController();
  const promise = router.chat([], ac.signal);
  await started;
  ac.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(calls, 1);
});

test('already cancelled request makes no network calls', async t => {
  let count = 0;
  const { router } = fixture(t, async () => { count++; return completion('bad'); });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(router.chat([], ac.signal), { name: 'AbortError' });
  assert.equal(count, 0);
});

test('disabled and blank slots are skipped; failure message omits secrets and provider body', async t => {
  const calls = [];
  const { router } = fixture(t, async config => { calls.push(config.model); return { status: 500, body: 'private provider content secret-0' }; });
  const config = router.getPublic();
  config.endpoints[0].enabled = false;
  config.endpoints[1].baseUrl = '';
  router.applyPatch(config);
  await assert.rejects(router.chat([]), error => {
    assert.ok(error.message.includes('HTTP 500'));
    assert.equal(error.message.includes('secret-'), false);
    assert.equal(error.message.includes('provider content'), false);
    return true;
  });
  assert.deepEqual(calls, ['test-model-2', 'test-model-3']);
});

test('refusal detection handles structured and textual refusals without rejecting an ordinary explanation', () => {
  for (const text of ['抱歉，我无法回答这个问题。', 'Sorry, I cannot assist with that request.', '我不能提供相关答案。']) {
    assert.throws(() => parseCompletion(completion(text)), { code: 'REFUSAL' });
  }
  assert.equal(parseCompletion(completion('这个算法不能处理负数，需要先做边界检查。')), '这个算法不能处理负数，需要先做边界检查。');
  assert.throws(() => parseCompletion({ status: 200, body: '{' }), { code: 'INVALID_JSON' });
  assert.throws(() => parseCompletion({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: {} }] }) }), { code: 'REFUSAL' });
  assert.throws(() => parseCompletion({ status: 200, body: JSON.stringify({ choices: [{ message: { reasoning_content: 'hidden reasoning only' } }] }) }), { code: 'EMPTY' });
  assert.equal(parseCompletion({ status: 200, body: JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'visible answer' }] } }] }) }), 'visible answer');
});

test('can disable automatic fallback on refusal', async t => {
  let calls = 0;
  const { router } = fixture(t, async () => { calls++; return completion('抱歉，我无法回答这个问题。'); });
  router.applyPatch({ ...router.getPublic(), retryOnRefusal: false });
  assert.equal(await router.chat([]), '抱歉，我无法回答这个问题。');
  assert.equal(calls, 1);
});

test('prompt hot reload, scenario selection, language, screenshot, resume, JD, history and transcript survive', t => {
  const { router, directory } = fixture(t, async () => completion('ok'));
  router.applyPatch({ ...router.getPublic(), mode: 'written' });
  fs.writeFileSync(path.join(directory, 'prompts/written.md'), '自定义笔试规则');
  const messages = router.buildMessages({ question: '题目', imageDataUrl: 'data:image/png;base64,x', answerLang: 'english', resume: '我的真实经历', jd: '岗位条件', recentTranscript: ['转录问题'], memo: '一致性', history: [{ role: 'system', content: 'should not be accepted' }, { role: 'assistant', content: '先前答案' }] });
  assert.ok(messages[0].content.includes('自定义笔试规则'));
  assert.ok(messages[0].content.includes('英文'));
  assert.equal(messages.filter(m => m.role === 'system').length, 1);
  for (const text of ['我的真实经历', '岗位条件', '转录问题', '一致性', '先前答案']) assert.ok(JSON.stringify(messages).includes(text));
  assert.equal(messages.at(-1).content[0].image_url.url, 'data:image/png;base64,x');
  fs.writeFileSync(path.join(directory, 'prompts/written.md'), '新的笔试规则');
  assert.ok(router.buildMessages({ question: 'x' })[0].content.includes('新的笔试规则'));
  router.applyPatch({ ...router.getPublic(), mode: 'interview' });
  assert.equal(router.buildMessages({ question: 'x' })[0].content.includes('新的笔试规则'), false);
});

test('invalid settings cannot partially persist; unavailable encryption never writes plaintext keys', t => {
  const { router, directory } = fixture(t, async () => completion('ok'));
  const before = fs.readFileSync(path.join(directory, 'interfaces.json'), 'utf8');
  const config = router.getPublic();
  config.endpoints[1].timeoutMs = 1;
  assert.throws(() => router.applyPatch(config), /5–180/);
  assert.equal(fs.readFileSync(path.join(directory, 'interfaces.json'), 'utf8'), before);
  const unsafe = createRouter({ directory, defaultsDirectory, safeStorage: { isEncryptionAvailable: () => false }, transport: async () => completion('ok') });
  unsafe.initialize();
  const publicConfig = unsafe.getPublic();
  publicConfig.endpoints[0].apiKey = 'never-plaintext';
  assert.throws(() => unsafe.applyPatch(publicConfig), /加密/);
  assert.equal(fs.readFileSync(path.join(directory, 'interfaces.json'), 'utf8').includes('never-plaintext'), false);
});

test('actual transport sends compatible HTTP payload and falls back across two local servers', async t => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/first/')) { res.statusCode = 503; res.end('{}'); }
      else res.end(completion('本地服务验证成功').body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const electron = {
    session: { defaultSession: {}, fromPartition: () => { throw new Error('proxy not expected'); } },
    net: { request: ({ url, method }) => {
      const wrapper = new EventEmitter();
      const req = http.request(url, { method }, res => wrapper.emit('response', res));
      req.on('error', err => wrapper.emit('error', err));
      wrapper.setHeader = (...args) => req.setHeader(...args);
      wrapper.write = (...args) => req.write(...args);
      wrapper.end = () => req.end();
      wrapper.abort = () => req.destroy();
      return wrapper;
    } }
  };
  const { router } = fixture(t, createElectronTransport(electron));
  const config = router.getPublic();
  config.endpoints.forEach((e, i) => { e.enabled = i < 2; e.baseUrl = `http://127.0.0.1:${server.address().port}/${i === 0 ? 'first/v1' : 'second/v1/chat/completions'}`; });
  router.applyPatch(config);
  const messages = router.buildMessages({ question: '测试', imageDataUrl: 'data:image/png;base64,eA==' }, 'shot');
  assert.equal(await router.chat(messages), '本地服务验证成功');
  assert.equal(received.length, 2);
  assert.equal(received[0].url, '/first/v1/chat/completions');
  assert.equal(received[1].url, '/second/v1/chat/completions');
  assert.equal(received[1].auth, 'Bearer secret-1');
  assert.deepEqual(received[1].body.messages, messages);
  assert.equal(received[1].body.stream, false);
});

test('dynamic addition, removal, reorder and reload preserve the right encrypted keys by endpoint ID', async t => {
  const calls = [];
  const transport = async config => { calls.push(config); return completion('ok'); };
  const { router, directory } = fixture(t, transport);
  const config = router.getPublic();
  config.endpoints.splice(0, 1);
  config.endpoints.reverse();
  config.endpoints.push({ id: randomUUID(), name: '新接口', enabled: true, baseUrl: 'https://new.invalid/v1', model: 'new-model' });
  router.applyPatch(config);
  assert.equal(router.getPublic().endpoints.at(-1).apiKeySet, false);
  await router.chat([]);
  assert.equal(calls[0].model, 'test-model-3');
  assert.equal(calls[0].apiKey, 'secret-3');
  const reloaded = createRouter({ directory, defaultsDirectory, safeStorage, transport });
  reloaded.initialize();
  const next = reloaded.getPublic();
  next.endpoints = [next.endpoints.find(e => e.model === 'test-model-1')];
  reloaded.applyPatch(next);
  await reloaded.chat([]);
  assert.equal(calls[1].apiKey, 'secret-1');
  assert.equal(reloaded.getPublic().endpoints.length, 1);
  assert.throws(() => reloaded.applyPatch({ ...next, endpoints: [] }), /至少一个/);
  assert.throws(() => reloaded.applyPatch({ ...next, endpoints: [next.endpoints[0], next.endpoints[0]] }), /重复/);
});

test('old fixed-slot configuration migrates without losing configured slots, keys or edited prompts', t => {
  const { router, directory } = fixture(t, async () => completion('ok'));
  const file = path.join(directory, 'interfaces.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  old.version = 1;
  old.endpoints.forEach(e => { delete e.id; });
  old.endpoints[3] = { name: '接口 4', enabled: false, baseUrl: '', model: '', apiKeyEncrypted: '', proxyUrl: '', timeoutMs: 30000 };
  fs.writeFileSync(file, JSON.stringify(old));
  fs.writeFileSync(path.join(directory, 'prompts/common.md'), '用户自己的提示词');
  router.initialize();
  const current = router.getPublic();
  assert.equal(current.endpoints.length, 3);
  assert.equal(current.endpoints[2].apiKeySet, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.before-dynamic.bak', 'utf8')), old);
  const ids = current.endpoints.map(e => e.id);
  router.initialize();
  assert.deepEqual(router.getPublic().endpoints.map(e => e.id), ids);
  assert.equal(fs.readFileSync(path.join(directory, 'prompts/common.md'), 'utf8'), '用户自己的提示词');
});

test('vision settings plus button adds exactly one editable API card per click and retains input', () => {
  const vm = require('node:vm');
  const element = (type, props, key) => ({ type, props, key });
  const component = vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../meeting-copilot/multimodal-ui.js'), 'utf8') + '\nMultimodalSettings;', {
    jsxRuntimeExports: { jsx: element, jsxs: element },
    reactExports: { useState: () => ['', () => {}], useRef: () => ({ current: null }), useEffect: () => {} },
    crypto: { randomUUID },
    window: { mc: {} }
  });
  let value = { enabled: false, mode: 'auto', retryOnRefusal: true, endpoints: [{ id: 'primary', enabled: true, baseUrl: '', model: '', timeoutMs: 30000 }] };
  const render = () => component({ value, onChange: next => { value = next; }, providerSelect: () => element('select', {}) });
  const all = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat().flatMap(all)];
  let nodes = all(render());
  assert.equal(nodes.filter(n => n.props?.children === '视觉 API Key').length, 1);
  nodes.find(n => n.props?.type === 'password').props.onChange({ target: { value: 'pending-unsaved-key' } });
  nodes = all(render());
  nodes.find(n => n.props?.['aria-label'] === '添加视觉模型接口').props.onClick();
  assert.equal(value.endpoints.length, 2);
  assert.equal(value.endpoints[0].apiKey, 'pending-unsaved-key');
  nodes = all(render());
  assert.equal(nodes.filter(n => n.props?.children === '视觉 API Key').length, 2);
  nodes.find(n => n.props?.children === '＋ 添加备用接口').props.onClick();
  assert.equal(value.endpoints.length, 3);
  nodes = all(render());
  nodes.find(n => n.props?.title === '移除接口 2（保存后生效）').props.onClick();
  assert.equal(value.endpoints.length, 2);
  assert.equal(value.endpoints[0].apiKey, 'pending-unsaved-key');
});

test('simultaneous answers start every configured interface together, publish early results and isolate failures', async t => {
  const pending = new Map(), calls = [], events = [];
  const { router, directory } = fixture(t, (config, messages, signal) => {
    calls.push({ config, messages, signal });
    return new Promise(resolve => pending.set(config.model, resolve));
  });
  router.applyPatch({ ...router.getPublic(), simultaneousAnswers: true });
  const messages = router.buildMessages({ question: '题目', imageDataUrl: 'data:image/png;base64,dGVzdA==' }, 'shot');
  const answer = router.chat(messages, undefined, () => {}, { answerMode: true, onResult: result => events.push(result) });
  assert.equal(calls.length, 4, 'all transports start without awaiting an earlier model');
  assert.equal(events.filter(e => e.status === 'pending').length, 4);
  pending.get('test-model-2')(completion('第三个先回答'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(e => e.status === 'done').length, 1);
  assert.equal(events.find(e => e.status === 'done').model, 'test-model-2');
  pending.get('test-model-0')(completion('第一个回答'));
  pending.get('test-model-1')({ status: 503, body: 'private provider body' });
  pending.get('test-model-3')(completion('抱歉，我无法回答这个问题。'));
  const text = await answer;
  assert.ok(text.includes('第一个回答') && text.includes('第三个先回答'));
  assert.ok(text.includes('HTTP 503') && text.includes('拒答'));
  assert.equal(text.includes('private provider body'), false);
  assert.deepEqual(events.filter(e => e.status !== 'pending').map(e => e.status).sort(), ['done', 'done', 'error', 'error']);
  for (const call of calls) assert.deepEqual(call.messages, messages);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'interfaces.json'), 'utf8'));
  assert.equal(saved.simultaneousAnswers, true);
});

test('per-request single-answer override uses ordered fallback while preserving the saved written parallel preference', async t => {
  const calls = [];
  const { router } = fixture(t, async config => {
    calls.push(config.model);
    return config.model === 'test-model-0' ? { status: 503, body: '' } : completion('单份截图答案');
  });
  router.applyPatch({ ...router.getPublic(), mode: 'interview', simultaneousAnswers: true });
  const result = await router.chat([], undefined, () => {}, { answerMode: true, simultaneousAnswers: false });
  assert.equal(result, '单份截图答案');
  assert.deepEqual(calls, ['test-model-0', 'test-model-1']);
  assert.equal(router.getPublic().simultaneousAnswers, true);
});

test('stop cancels every simultaneous model and suppresses all late model results', async t => {
  const calls = [], events = [];
  const { router } = fixture(t, (config, messages, signal) => {
    calls.push(signal);
    return new Promise(resolve => setTimeout(() => resolve(completion('late')), 30));
  });
  router.applyPatch({ ...router.getPublic(), simultaneousAnswers: true });
  const ac = new AbortController();
  const request = router.chat([], ac.signal, () => {}, { answerMode: true, onResult: r => events.push(r) });
  assert.equal(calls.length, 4);
  ac.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(calls.every(signal => signal.aborted));
  assert.equal(events.length, 4, 'only initial placeholders may have been published');
});

test('a slow simultaneous model times out independently while a fast answer is already visible', async t => {
  const events = [];
  const { router } = fixture(t, async config => config.model === 'test-model-0' ? new Promise(() => {}) : completion('快速答案'));
  const config = router.getPublic();
  config.simultaneousAnswers = true;
  config.endpoints = config.endpoints.slice(0, 2);
  router.applyPatch(config);
  const request = router.chat([], undefined, () => {}, { answerMode: true, onResult: r => events.push(r) });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(r => r.model === 'test-model-1' && r.status === 'done'));
  assert.equal(events.filter(r => r.status === 'error').length, 0);
  const text = await request;
  assert.ok(text.includes('快速答案') && text.includes('超时'));
});

test('internal translation or memo requests keep a single interface even when simultaneous answers are enabled', async t => {
  let count = 0;
  const { router } = fixture(t, async () => { count++; return completion('单接口'); });
  router.applyPatch({ ...router.getPublic(), simultaneousAnswers: true });
  assert.equal(await router.chat([]), '单接口');
  assert.equal(count, 1);
});

test('a new blank backup interface without API key survives save, close/reload and later edits', t => {
  const { router, directory } = fixture(t, async () => completion('ok'));
  const next = router.getPublic();
  const id = randomUUID();
  next.endpoints.push({ id, name: '', enabled: true, baseUrl: '', model: '', proxyUrl: '', timeoutMs: 30000, apiKeySet: false });
  router.applyPatch(next);
  const fresh = createRouter({ directory, defaultsDirectory, safeStorage, transport: async () => completion('ok') });
  fresh.initialize();
  const blank = fresh.getPublic().endpoints.at(-1);
  assert.equal(fresh.getPublic().endpoints.length, 5);
  assert.equal(blank.id, id);
  assert.equal(blank.apiKeySet, false);
  assert.equal(blank.baseUrl, '');
  const again = fresh.getPublic();
  again.endpoints.at(-1).name = '以后再填的备用口';
  fresh.applyPatch(again);
  fresh.initialize();
  assert.equal(fresh.getPublic().endpoints.at(-1).name, '以后再填的备用口');
});

test('written mode uses one concise standalone prompt shared unchanged by every model', async t => {
  const seen = [];
  const { router } = fixture(t, async (config, messages) => { seen.push(messages); return completion('B'); });
  router.applyPatch({ ...router.getPublic(), mode: 'written', simultaneousAnswers: true });
  const messages = router.buildMessages({ imageDataUrl: 'data:image/png;base64,dGVzdA==', originalMessages: [{ role: 'system', content: 'old interview identity' }] }, 'shot');
  const expected = fs.readFileSync(path.join(defaultsDirectory, 'written.md'), 'utf8').trim();
  assert.equal(messages[0].content, expected);
  assert.ok(expected.includes('只输出正确选项字母'));
  assert.ok(expected.includes('不要题号'));
  assert.ok(expected.includes('最终可填写的文字或数值'));
  assert.ok(expected.includes('最短、完整可用的代码'));
  assert.equal(messages[0].content.includes('实时面试提词器'), false);
  assert.equal(JSON.stringify(messages).includes('必要的依据'), false);
  assert.equal(messages.at(-1).content[1].text, '请直接回答截图中的题目。');
  await router.chat(messages, undefined, () => {}, { answerMode: true });
  assert.equal(seen.length, 4);
  assert.ok(seen.every(sent => sent[0].content === expected));
});

test('interview mode preserves original spoken interview and original screenshot messages including context', t => {
  const { router } = fixture(t, async () => completion('ok'));
  router.applyPatch({ ...router.getPublic(), mode: 'interview' });
  const spoken = fs.readFileSync(path.join(defaultsDirectory, 'interview.md'), 'utf8').trim();
  const original = [{ role: 'system', content: spoken + '\n\n【简历】\n我的真实经历\n【简历结束】\n\n- 用【中文】输出。' }, { role: 'user', content: '面试官刚才说：如何优化索引？' }];
  assert.deepEqual(router.buildMessages({ originalMessages: original, originalPersona: spoken }), original);
  assert.ok(spoken.includes('实时面试提词器') && spoken.includes('先一句话讲思路'));
  const vision = fs.readFileSync(path.join(defaultsDirectory, 'original-vision.md'), 'utf8').trim();
  const shot = [{ role: 'system', content: vision + '\n\n===== 本人资料与知识库（作答时优先采用） =====\n资料\n===== 资料结束 =====' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }, { type: 'text', text: '解读这页内容的要点，并给出我应该怎么回应的建议。' }] }];
  assert.deepEqual(router.buildMessages({ originalMessages: shot, originalPersona: vision }, 'shot'), shot);
  assert.ok(vision.includes('回答要点或解题思路'));
  assert.equal(JSON.stringify(router.buildMessages({ question: '普通面试问题' })).includes('仅输出最终答案'), false);
});
