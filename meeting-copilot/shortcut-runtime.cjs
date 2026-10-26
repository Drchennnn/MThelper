'use strict';
const net = require('node:net');
const cp = require('node:child_process');

function createShortcutRuntime({ shortcuts, helperPath, getBindings, onToggle, onCapture, onRecord, onError, createServer = net.createServer, spawn = cp.spawn }) {
  let host = null, epoch = 0, recording = null, disposed = false;
  function stopHost() {
    epoch++;
    if (!host) return;
    const old = host;
    host = null;
    clearTimeout(old.timer);
    old.reject?.(new Error('侧键监听已停止'));
    for (const socket of old.sockets) socket.destroy();
    old.server.close();
    old.child?.kill();
  }
  function startHost(buttons) {
    stopHost();
    const current = epoch;
    const pipeName = `meeting-copilot-mouse-${current}-${process.pid}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    return new Promise((resolve, reject) => {
      const state = { sockets: new Set(), reject, ready: false };
      const fail = error => {
        if (current !== epoch) return;
        clearTimeout(state.timer);
        const wasReady = state.ready;
        state.reject = null;
        reject(error);
        onError(error.message);
        stopHost();
        if (recording) end(recording.token, true, error.message);
      };
      state.server = createServer(socket => {
        state.sockets.add(socket);
        socket.on('close', () => state.sockets.delete(socket));
        socket.on('error', () => {});
        socket.on('data', bytes => {
          if (current !== epoch) return;
          for (const byte of bytes) {
            if (byte === 0) { state.ready = true; state.reject = null; clearTimeout(state.timer); resolve(true); continue; }
            const key = byte === 5 ? 'Mouse4' : byte === 6 ? 'Mouse5' : '';
            if (!key) continue;
            if (recording) onRecord({ token: recording.token, accelerator: key });
            else {
              const bindings = getBindings();
              if (key === bindings.full) onCapture('full');
              else if (key === bindings.region) onCapture('region');
            }
          }
        });
      });
      state.server.on('error', () => fail(new Error('侧键监听通道无法启动')));
      host = state;
      state.timer = setTimeout(() => fail(new Error('侧键监听启动超时，请重新录制')), 7000);
      state.server.listen(pipePath, () => {
        if (current !== epoch) return;
        state.child = spawn(helperPath, ['--mouse-watch', pipeName, buttons.join(',')], { windowsHide: true, stdio: 'ignore' });
        state.child.on('error', () => fail(new Error('侧键监听程序无法启动')));
        state.child.on('exit', () => fail(new Error('侧键监听程序已退出')));
      });
    });
  }
  function register() {
    if (disposed || recording) return;
    stopHost();
    shortcuts.unregisterAll();
    onError('');
    const bindings = getBindings();
    const mouse = [];
    for (const [kind, key] of Object.entries(bindings)) {
      if (!key) continue;
      if (/^Mouse[45]$/.test(key)) { if (kind !== 'toggle') mouse.push(key); continue; }
      try {
        const ok = shortcuts.register(key, kind === 'toggle' ? onToggle : () => onCapture(kind));
        if (!ok) onError(`快捷键 ${key} 已被占用，请在设置中更换`);
      } catch { onError(`快捷键 ${key} 格式无效，请重新录入`); }
    }
    if (mouse.length) {
      const current = epoch + 1;
      startHost([...new Set(mouse)]).catch(error => { if (current === epoch) onError(error.message); });
    }
  }
  async function begin(token) {
    if (disposed) throw new Error('应用已退出');
    if (!token || typeof token !== 'string') throw new Error('录制会话无效');
    if (recording) end(recording.token, false);
    recording = { token, timer: setTimeout(() => end(token, true, '录制超时，点击录制重试'), 45000) };
    const active = recording;
    shortcuts.unregisterAll();
    try {
      await startHost(['Mouse4', 'Mouse5']);
      return recording === active;
    } catch (error) {
      if (recording !== active) return false;
      end(token);
      throw error;
    }
  }
  function end(token, restore = true, error = '') {
    if (!recording || (token && token !== recording.token)) return false;
    const endedToken = recording.token;
    clearTimeout(recording.timer);
    recording = null;
    onRecord({ token: endedToken, ended: true, error });
    stopHost();
    if (restore) register();
    return true;
  }
  function dispose() { disposed = true; if (recording) clearTimeout(recording.timer); recording = null; stopHost(); shortcuts.unregisterAll(); }
  return { register, begin, end, dispose, get recording() { return !!recording; } };
}
module.exports = { createShortcutRuntime };
