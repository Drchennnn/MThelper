'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PROMPTS = ['common.md', 'written.md', 'interview.md', 'auto.md', 'original-vision.md'];
const abortError = () => Object.assign(new Error('请求已取消'), { name: 'AbortError' });
const failure = (code) => Object.assign(new Error(code), { code });

function validateEndpoint(endpoint, index) {
  const e = {
    id: String(endpoint.id || randomUUID()),
    name: String(endpoint.name || `接口 ${index + 1}`).trim().slice(0, 80),
    enabled: endpoint.enabled !== false,
    baseUrl: String(endpoint.baseUrl || '').trim(),
    model: String(endpoint.model || '').trim().slice(0, 200),
    proxyUrl: String(endpoint.proxyUrl || '').trim(),
    timeoutMs: Number(endpoint.timeoutMs ?? 30000),
    apiKeyEncrypted: String(endpoint.apiKeyEncrypted || '')
  };
  if (!Number.isInteger(e.timeoutMs) || e.timeoutMs < 5000 || e.timeoutMs > 180000) {
    throw new Error(`接口 ${index + 1} 超时应为 5–180 秒`);
  }
  if (e.baseUrl) {
    let u;
    try { u = new URL(e.baseUrl); } catch { throw new Error(`接口 ${index + 1} 的 Base URL 无效`); }
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
      throw new Error(`接口 ${index + 1} 需要不含密码、查询参数的 HTTP(S) Base URL`);
    }
    e.baseUrl = e.baseUrl.replace(/\/+$/, '');
  }
  if (e.proxyUrl && !/^(https?|socks[45]?):\/\//i.test(e.proxyUrl)) {
    throw new Error(`接口 ${index + 1} 的代理需要 http://、https:// 或 socks5:// 地址`);
  }
  return e;
}

function parseCompletion(raw) {
  if (raw.status < 200 || raw.status >= 300) throw failure(`HTTP_${raw.status}`);
  let result;
  try { result = JSON.parse(raw.body); } catch { throw failure('INVALID_JSON'); }
  const choice = result?.choices?.[0];
  const msg = choice?.message;
  if (msg?.refusal || ['content_filter', 'safety', 'blocked'].includes(choice?.finish_reason) || result?.prompt_feedback?.block_reason) {
    throw failure('REFUSAL');
  }
  const text = (typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content)
    ? msg.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '').trim();
  if (!text) throw failure('EMPTY');
  // Only short, explicit refusal openings qualify; explanatory answers are not rejected by keywords alone.
  if (/^(?:(?:对不起|抱歉|很抱歉|非常抱歉|Sorry|I(?:’|')m sorry)[，,。.!！:\s]*)?(?:我(?:不能|无法|不可以|不被允许)(?:为你|为您|帮你|帮助你|协助你|协助您)?(?:回答|提供|协助|帮助|完成|处理|参与|支持)|I (?:cannot|can(?:’|')t|am unable to|must decline to) (?:help|assist|provide|answer|comply))/i.test(text.slice(0, 350))) {
    throw Object.assign(failure('REFUSAL'), { refusalText: text });
  }
  return text;
}

function createElectronTransport(electron) {
  // A separate partition per proxy avoids concurrent requests changing one shared proxy session.
  const sessions = new Map();
  return async (config, messages, signal) => {
    if (signal.aborted) throw abortError();
    let session = electron.session.defaultSession;
    if (config.proxyUrl) {
      const key = config.proxyUrl;
      if (!sessions.has(key)) {
        const partition = 'mm-proxy-' + require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 16);
        const isolated = electron.session.fromPartition(partition);
        sessions.set(key, isolated.setProxy({ proxyRules: config.proxyUrl }).then(() => isolated));
      }
      session = await sessions.get(key);
    }
    if (signal.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      const url = /\/chat\/completions$/.test(config.baseUrl) ? config.baseUrl : config.baseUrl + '/chat/completions';
      const req = electron.net.request({ method: 'POST', url, session });
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        err ? reject(err) : resolve(value);
      };
      const onAbort = () => { finish(abortError()); req.abort(); };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('error', () => finish(failure('NETWORK')));
      req.on('abort', () => finish(abortError()));
      req.on('response', res => {
        let size = 0;
        const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { finish(failure('RESPONSE_TOO_LARGE')); req.abort(); }
          else chunks.push(Buffer.from(chunk));
        });
        res.on('error', () => finish(failure('NETWORK')));
        res.on('aborted', () => finish(failure('NETWORK')));
        res.on('end', () => finish(null, { status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setHeader('Content-Type', 'application/json');
      if (config.apiKey) req.setHeader('Authorization', `Bearer ${config.apiKey}`);
      req.write(JSON.stringify({ model: config.model, messages, stream: false }));
      req.end();
    });
  };
}

function createRouter({ directory, defaultsDirectory, safeStorage, transport }) {
  const configPath = path.join(directory, 'interfaces.json');
  const promptDir = path.join(directory, 'prompts');
  let state;
  function persist(next) {
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, configPath);
    state = next;
  }
  function encrypt(key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 密钥加密不可用，无法保存新密钥');
    return safeStorage.encryptString(key).toString('base64');
  }
  function decrypt(key) {
    if (!key) return '';
    try { return safeStorage.decryptString(Buffer.from(key, 'base64')); }
    catch { throw failure('KEY_UNAVAILABLE'); }
  }
  function initialize(legacy = {}) {
    fs.mkdirSync(promptDir, { recursive: true });
    for (const file of PROMPTS) {
      const target = path.join(promptDir, file);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(defaultsDirectory, file), target);
    }
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (![1, 2].includes(saved.version) || !Array.isArray(saved.endpoints) || !saved.endpoints.length || !['auto', 'written', 'interview'].includes(saved.mode)) {
        throw new Error('多模态配置格式不正确，请检查 interfaces.json');
      }
      const endpoints = saved.endpoints.map(validateEndpoint);
      if (saved.version === 1) {
        const first = endpoints[0];
        if (!first.baseUrl && !first.model && !first.apiKeyEncrypted && legacy.baseUrl && legacy.model) {
          endpoints[0] = validateEndpoint({ ...legacy, id: first.id, name: first.name, enabled: first.enabled }, 0);
          endpoints[0].apiKeyEncrypted = legacy.apiKey ? encrypt(legacy.apiKey) : '';
        }
        // Trim only untouched, blank placeholders from the previous fixed-slot UI.
        while (endpoints.length > 1) {
          const last = endpoints.at(-1);
          if (last.enabled || last.baseUrl || last.model || last.apiKeyEncrypted || last.proxyUrl || last.name !== `接口 ${endpoints.length}` || last.timeoutMs !== 30000) break;
          endpoints.pop();
        }
        if (!fs.existsSync(configPath + '.before-dynamic.bak')) fs.copyFileSync(configPath, configPath + '.before-dynamic.bak', fs.constants.COPYFILE_EXCL);
      }
      if (new Set(endpoints.map(e => e.id)).size !== endpoints.length) throw new Error('接口标识重复，请检查配置');
      const next = { ...saved, version: 2, simultaneousAnswers: saved.simultaneousAnswers === true, endpoints };
      if (JSON.stringify(next) !== JSON.stringify(saved)) persist(next);
      else state = next;
    } else {
      const endpoints = [validateEndpoint({ enabled: true }, 0)];
      if (legacy.baseUrl && legacy.model) {
        endpoints[0] = validateEndpoint({ ...legacy, name: '主接口（原视觉配置）' }, 0);
        endpoints[0].apiKeyEncrypted = legacy.apiKey ? encrypt(legacy.apiKey) : '';
      }
      persist({ version: 2, enabled: !!(legacy.baseUrl && legacy.model), mode: 'auto', retryOnRefusal: true, simultaneousAnswers: false, endpoints });
    }
    return getPublic();
  }
  function getPublic() {
    return {
      enabled: state.enabled !== false, mode: state.mode, retryOnRefusal: state.retryOnRefusal !== false,
      simultaneousAnswers: state.simultaneousAnswers === true,
      directory, promptDir,
      ready: ready(),
      endpoints: state.endpoints.map(({ apiKeyEncrypted, ...e }) => ({ ...e, apiKeySet: !!apiKeyEncrypted }))
    };
  }
  function ready() { return state.endpoints.some(e => e.enabled && e.baseUrl && e.model); }
  function applyPatch(patch) {
    if (!patch || !['auto', 'written', 'interview'].includes(patch.mode) || !Array.isArray(patch.endpoints) || !patch.endpoints.length) {
      throw new Error('请保留至少一个视觉模型接口');
    }
    const endpoints = patch.endpoints.map((input, i) => {
      const previous = state.endpoints.find(e => e.id === input.id);
      const endpoint = validateEndpoint({ ...input, apiKeyEncrypted: previous?.apiKeyEncrypted || '' }, i);
      if (Object.hasOwn(input, 'apiKey')) {
        const key = String(input.apiKey || '').trim();
        endpoint.apiKeyEncrypted = key ? encrypt(key) : '';
      }
      return endpoint;
    });
    if (new Set(endpoints.map(e => e.id)).size !== endpoints.length) throw new Error('接口标识重复，请重新添加接口');
    persist({ version: 2, enabled: patch.enabled !== false, mode: patch.mode, retryOnRefusal: patch.retryOnRefusal !== false, simultaneousAnswers: patch.simultaneousAnswers ?? state.simultaneousAnswers ?? false, endpoints });
    return getPublic();
  }
  function loadPrompt(mode, kind = 'answer') {
    const read = file => {
      const content = fs.readFileSync(path.join(promptDir, file), 'utf8').trim();
      if (!content || content.length > 64000) throw new Error(`提示词文件 ${file} 为空或过长`);
      return content;
    };
    // Written mode has one shared, standalone prompt. Interview mode has no written rules.
    if (mode === 'written') return read('written.md');
    if (mode === 'interview') return read(kind === 'shot' ? 'original-vision.md' : 'interview.md');
    return [read('common.md'), read('auto.md'),
      '【以下规则仅在判定为笔试时适用】\n' + read('written.md'),
      '【以下为原版面试规则，仅在判定为普通面试时适用】\n' + read(kind === 'shot' ? 'original-vision.md' : 'interview.md')
    ].join('\n\n');
  }
  function buildMessages(input, kind = 'answer') {
    const mode = state.mode;
    const system = loadPrompt(mode, kind);
    if (mode === 'interview' && Array.isArray(input.originalMessages)) {
      return input.originalMessages.map((message, index) => {
        if (index === 0 && message.role === 'system' && typeof message.content === 'string' && input.originalPersona && message.content.startsWith(input.originalPersona)) {
          return { ...message, content: system + message.content.slice(input.originalPersona.length) };
        }
        return { ...message };
      });
    }
    const resume = String(input.resume || input.background || '').trim().slice(0, 8000);
    const jd = String(input.jd || '').trim().slice(0, 8000);
    const transcript = (input.recentTranscript || []).slice(-30).join('\n').slice(-4800);
    const memo = String(input.memo || '').slice(0, 1000);
    const refs = [resume && `【个人资料与知识库】\n${resume}`, jd && `【岗位描述】\n${jd}`, transcript && `【最近对话】\n${transcript}`, memo && `【先前问答备忘】\n${memo}`].filter(Boolean).join('\n\n');
    const messages = [{ role: 'system', content: system + (input.answerLang === 'english' ? '\n\n本次请用英文作答。' : '') }];
    // Reference text stays in a user turn, not in the high-priority prompt definition.
    if (refs) {
      messages.push({ role: 'user', content: '以下是参考资料：\n' + refs });
      messages.push({ role: 'assistant', content: mode === 'written' ? '收到。' : '我会根据这些资料回答，并避免编造个人经历。' });
    }
    for (const m of (input.history || []).slice(-20)) {
      if (['user', 'assistant'].includes(m.role) && typeof m.content === 'string') messages.push({ role: m.role, content: m.content.slice(0, 16000) });
    }
    const question = String(input.freeQuestion || input.question || '').trim() || (mode === 'written' ? (kind === 'shot' ? '请直接回答截图中的题目。' : '请直接回答最新题目。') : kind === 'shot'
      ? '请识别截图中的问题或内容，并按照当前场景给出答案和必要的依据。'
      : '请根据最近对话回答最新的问题。');
    const content = input.imageDataUrl ? [{ type: 'image_url', image_url: { url: input.imageDataUrl } }, { type: 'text', text: question }] : question;
    messages.push({ role: 'user', content });
    return messages;
  }
  function errorLabel(code) {
    return ({ TIMEOUT: '超时', REFUSAL: '拒答', EMPTY: '空回答', INVALID_JSON: '响应格式错误', NETWORK: '网络错误', KEY_UNAVAILABLE: '密钥不可用' })[code] || (/^HTTP_\d+$/.test(code) ? code.replace('_', ' ') : '接口错误');
  }
  async function attempt(endpoint, messages, signal) {
    if (signal?.aborted) throw abortError();
    const ac = new AbortController();
    let timer, onCancel, timedOut = false;
    const interrupted = new Promise((_, reject) => {
      onCancel = () => { reject(abortError()); ac.abort(); };
      signal?.addEventListener('abort', onCancel, { once: true });
      timer = setTimeout(() => { timedOut = true; reject(failure('TIMEOUT')); ac.abort(); }, endpoint.timeoutMs);
    });
    try {
      const apiKey = decrypt(endpoint.apiKeyEncrypted);
      const raw = await Promise.race([transport({ ...endpoint, apiKey }, messages, ac.signal), interrupted]);
      if (signal?.aborted) throw abortError();
      return parseCompletion(raw);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw failure('TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
      ac.abort();
    }
  }
  async function chat(messages, signal, onProgress = () => {}, options = {}) {
    if (signal?.aborted) throw abortError();
    // Snapshot candidates so a settings change cannot mix configurations mid-request.
    const endpoints = state.endpoints.filter(e => e.enabled && e.baseUrl && e.model).map(e => ({ ...e }));
    const retryOnRefusal = state.retryOnRefusal !== false;
    if (!endpoints.length) throw new Error('请在设置的“视觉模型”中配置至少一个接口');
    if (options.answerMode && (options.simultaneousAnswers ?? state.simultaneousAnswers) === true) {
      const onResult = result => { if (!signal?.aborted) options.onResult?.(result); };
      let completed = 0;
      onProgress(`同时回答：0/${endpoints.length} 已完成`);
      // Publish all placeholders first, preserving configuration order regardless of completion order.
      endpoints.forEach((endpoint, index) => onResult({ id: endpoint.id, index, name: endpoint.name, model: endpoint.model, status: 'pending', text: '' }));
      const results = await Promise.all(endpoints.map(async (endpoint, index) => {
        const result = { id: endpoint.id, index, name: endpoint.name, model: endpoint.model };
        try { result.text = await attempt(endpoint, messages, signal); result.status = 'done'; }
        catch (error) {
          if (signal?.aborted) throw abortError();
          result.status = 'error'; result.error = errorLabel(error.code || 'NETWORK'); result.text = '';
        }
        if (signal?.aborted) throw abortError();
        onResult(result);
        completed++;
        onProgress(`同时回答：${completed}/${endpoints.length} 已完成`);
        return result;
      }));
      if (signal?.aborted) throw abortError();
      if (!results.some(result => result.status === 'done')) throw new Error('所有已启用接口均未成功。' + results.map(result => `${result.name}：${result.error}`).join('；'));
      return results.map(result => `【${result.name} · ${result.model}】\n${result.status === 'done' ? result.text : '（' + result.error + '）'}`).join('\n\n');
    }
    const failures = [];
    for (let i = 0; i < endpoints.length; i++) {
      if (signal?.aborted) throw abortError();
      const endpoint = endpoints[i];
      onProgress(`正在请求 ${endpoint.name}（${i + 1}/${endpoints.length}）`);
      try {
        const text = await attempt(endpoint, messages, signal);
        onProgress(`已由 ${endpoint.name} 回答`);
        return text;
      } catch (err) {
        if (signal?.aborted) throw abortError();
        const code = err.code || 'NETWORK';
        if (code === 'REFUSAL' && !retryOnRefusal) {
          if (err.refusalText) return err.refusalText;
          throw new Error(`${endpoint.name} 拒绝回答（自动切换已关闭）`);
        }
        const label = errorLabel(code);
        failures.push(`${endpoint.name}：${label}`);
        onProgress(`${endpoint.name}：${label}${i + 1 < endpoints.length ? '，正在切换备用接口' : ''}`);
      }
    }
    throw new Error('所有已启用接口均未成功。' + failures.join('；'));
  }
  return { initialize, getPublic, ready, applyPatch, buildMessages, chat, promptDir };
}

module.exports = { createRouter, createElectronTransport, parseCompletion, validateEndpoint };
