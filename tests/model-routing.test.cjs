'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = process.env.MC_ROUTING_MAIN || path.resolve(__dirname, '../work/model-routing-check/main.cjs');
const skip = !fs.existsSync(file) && 'Run install_model_routing.py --check to generate the real-bundle fixture';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(mode = 'interview', enabled = true, key = 'test-text-key') {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('    const llmControllers =');
  const end = source.indexOf('    asr.onEvent(', start);
  const handlers = {}, calls = [], events = [];
  const config = { mode, enabled, simultaneousAnswers: true };
  const settings = { data: { llm: { baseUrl: 'https://text.invalid/v1', model: 'text-model', answerLang: 'chinese', answerWithVision: true } }, getLlmApiKey: () => key };
  const multimodalRouter = {
    getPublic: () => config, ready: () => true,
    buildMessages: (input, kind) => ({ input, kind }),
    chat: async (messages, signal, progress, options) => { calls.push({ type: 'image', messages, signal, options }); return '截图答案'; }
  };
  const sendEv = event => events.push(event);
  const context = {
    AbortController, console: { log() {}, error() {}, warn() {} },
    electron: { ipcMain: { on: (name, callback) => { handlers[name] = callback; }, handle: (name, callback) => { handlers[name] = callback; } } },
    IPC: Object.fromEntries(['llmAsk', 'llmCancel', 'memoUpdate', 'translateText', 'shotAsk', 'llmEvent'].map(name => [name, name])),
    win: { webContents: { send: (_channel, event) => events.push(event) } },
    settings, multimodalRouter, unifiedEnabled: () => enabled,
    unifiedProgress: () => () => {},
    knowledge: { text: '' },
    buildAnswerMessages: input => [{ role: 'system', content: '面试 Prompt' }, { role: 'user', content: input.freeQuestion || input.question || '最新转录' }],
    buildVisionMessages: () => [{ role: 'system', content: '截图 Prompt' }],
    buildMemoUpdateMessages: () => [{ role: 'system', content: '备忘' }],
    buildTranslateMessages: text => [{ role: 'user', content: text }],
    clampMemo: text => text,
    stablePrefixFor: () => 'prefix', lastPrefix: null, lastPrefixActivity: 0,
    T: () => ({ noApiKey: '未配置文本模型密钥', noApiKeyShort: '缺少密钥' }),
    captureQuietScreenshot: async () => { calls.push({ type: 'capture' }); return 'data:image/png;base64,AAAA'; },
    chatStream: async (endpoint, messages, hooks, signal) => { calls.push({ type: 'text', endpoint, messages, signal }); hooks.onDelta('文本答案'); return { text: '文本答案' }; },
    chatOnce: async (endpoint, messages) => { calls.push({ type: 'memo', endpoint, messages }); return { text: '备忘结果' }; }
  };
  const optionsSource = source.slice(source.indexOf('  const unifiedResults = '), source.indexOf('\n', source.indexOf('  const unifiedResults = ')));
  vm.runInNewContext(optionsSource + '\nglobalThis.unifiedResults = unifiedResults;', context);
  vm.runInNewContext(source.slice(start, end), context);
  return { handlers, calls, events, config };
}

test('all ordinary ask modes use exactly the text endpoint, regardless of screenshot switch and legacy vision flag', { skip }, async () => {
  for (const enabled of [false, true]) for (const mode of ['continuous', 'segment', 'free', 'translate']) {
    const { handlers, calls, events } = fixture('interview', enabled);
    handlers.llmAsk({}, { requestId: 'text-' + mode, mode, question: '问题', freeQuestion: '自由问题', recentTranscript: [] });
    await flush();
    assert.deepEqual(calls.map(call => call.type), ['text']);
    assert.equal(calls[0].endpoint.model, 'text-model');
    assert.equal(events.filter(event => event.kind === 'done').length, 1);
    assert.equal(events.some(event => event.kind === 'model'), false);
  }
});

test('missing text credentials reports a text error without silently calling image endpoints', { skip }, () => {
  const { handlers, calls, events } = fixture('interview', true, '');
  handlers.llmAsk({}, { requestId: 'missing', mode: 'free' });
  assert.equal(calls.length, 0);
  assert.equal(events[0].kind, 'error');
  assert.equal(events[0].message, '未配置文本模型密钥');
});

test('interview screenshots call multimodal only and explicitly override stored simultaneous preference', { skip }, async () => {
  for (const mode of ['interview', 'auto', 'written']) {
    const { handlers, calls } = fixture(mode);
    handlers.shotAsk({}, { requestId: mode, imageDataUrl: 'data:image/png;base64,AAAA' });
    await flush();
    assert.deepEqual(calls.map(call => call.type), ['image']);
    assert.equal(calls[0].messages.kind, 'shot');
    assert.equal(calls[0].messages.input.imageDataUrl, 'data:image/png;base64,AAAA');
    assert.equal(calls[0].options.simultaneousAnswers, mode === 'written');
  }
});

test('disabled screenshots do not capture, fall back to legacy vision or contact any endpoint', { skip }, async () => {
  const { handlers, calls, events } = fixture('interview', false);
  handlers.shotAsk({}, { requestId: 'disabled' });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(events[0].kind, 'error');
});

test('translation and rolling memo stay on text model even with screenshot parallel mode enabled', { skip }, async () => {
  const { handlers, calls } = fixture('written');
  assert.equal(await handlers.translateText({}, 'hello'), '文本答案');
  assert.equal(await handlers.memoUpdate({}, { question: '问题', answer: '答案' }), '备忘结果');
  assert.deepEqual(calls.map(call => call.type), ['text', 'memo']);
  assert.ok(calls.every(call => call.endpoint.model === 'text-model'));
});
