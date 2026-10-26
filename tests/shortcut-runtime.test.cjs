'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createShortcutRuntime } = require('../meeting-copilot/shortcut-runtime.cjs');
const uiSource = fs.readFileSync(path.resolve(__dirname, '../meeting-copilot/shortcut-recorder-ui.js'), 'utf8');
const key = vm.runInNewContext(uiSource + '\nacceleratorFromKeyboardEvent;');
const merge = vm.runInNewContext(uiSource + '\nmergeModelAnswer;');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const active = new Map(), servers = [], children = [], captured = [], recorded = [], errors = [];
  const bindings = { toggle: 'Control+B', full: 'Mouse5', region: 'Control+Shift+A' };
  const shortcuts = { register: (key, callback) => { active.set(key, callback); return true; }, unregisterAll: () => active.clear() };
  const runtime = createShortcutRuntime({ shortcuts, helperPath: 'helper.exe', getBindings: () => bindings,
    onToggle: () => {}, onCapture: mode => captured.push(mode), onRecord: event => recorded.push(event), onError: e => errors.push(e),
    createServer: handler => {
      const server = new EventEmitter();
      server.handler = handler;
      server.listen = (pipe, cb) => { server.pipe = pipe; queueMicrotask(cb); };
      server.close = () => { server.closed = true; };
      servers.push(server);
      return server;
    },
    spawn: (exe, args, options) => {
      const child = new EventEmitter();
      child.args = args; child.options = options;
      child.kill = () => { child.killed = true; child.emit('exit', 0); };
      children.push(child);
      queueMicrotask(() => {
        const server = servers.find(s => s.pipe.endsWith(args[1]) && !s.closed);
        if (!server || child.killed) return;
        const socket = new EventEmitter(); socket.destroy = () => { socket.emit('close'); };
        server.socket = socket; server.handler(socket); socket.emit('data', Buffer.from([0]));
      });
      return child;
    }
  });
  t.after(() => runtime.dispose());
  return { runtime, active, servers, children, captured, recorded, bindings, errors };
}
test('recording suspends existing global keys and routes side buttons to the recorder without taking screenshots', async t => {
  const f = fixture(t);
  f.runtime.register(); await tick();
  assert.ok(f.active.has('Control+Shift+A'));
  assert.equal(await f.runtime.begin('field-full'), true);
  assert.equal(f.active.size, 0, 'existing combination must reach the focused input');
  assert.equal(f.children.at(-1).args[2], 'Mouse4,Mouse5');
  f.servers.at(-1).socket.emit('data', Buffer.from([6]));
  assert.equal(f.recorded.at(-1).accelerator, 'Mouse5');
  assert.equal(f.captured.length, 0);
  assert.equal(f.runtime.end('field-full'), true);
  await tick();
  assert.ok(f.active.has('Control+Shift+A'));
  assert.ok(f.recorded.some(e => e.token === 'field-full' && e.ended));
});
test('changing a side button back to a keyboard combination restores the right capture routes', async t => {
  const f = fixture(t);
  f.runtime.register(); await tick();
  f.servers.at(-1).socket.emit('data', Buffer.from([6]));
  assert.deepEqual(f.captured, ['full']);
  await f.runtime.begin('edit');
  f.runtime.end('edit');
  f.bindings.full = 'Control+Shift+S'; f.bindings.region = 'Mouse4';
  f.runtime.register(); await tick();
  f.active.get('Control+Shift+S')();
  f.servers.at(-1).socket.emit('data', Buffer.from([5, 6]));
  assert.deepEqual(f.captured, ['full', 'full', 'region']);
  assert.equal(f.children.at(-1).args[2], 'Mouse4');
});
test('recording sessions can be replaced or ended before native startup without leaving global shortcuts suspended', async t => {
  const f = fixture(t);
  const first = f.runtime.begin('old');
  const second = f.runtime.begin('new');
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(f.runtime.end('old'), false);
  f.runtime.end(); await tick();
  assert.equal(f.runtime.recording, false);
  assert.ok(f.active.has('Control+B'));
  assert.equal(new Set(f.servers.map(s => s.pipe)).size, f.servers.length, 'each host uses a unique pipe');
  f.runtime.dispose();
  assert.ok(f.children.every(child => child.killed));
  assert.equal(f.active.size, 0);
});
test('keyboard recorder supports physical letters, punctuation, arrows, function keys and numpad combinations', () => {
  assert.equal(key({ key: 's', code: 'KeyS', ctrlKey: true, shiftKey: true }), 'Control+Shift+S');
  assert.equal(key({ key: 'S', code: 'KeyS', altKey: true }), 'Alt+S');
  assert.equal(key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }), 'Control+Left');
  assert.equal(key({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }), 'Control+Shift+Plus');
  assert.equal(key({ key: '1', code: 'Numpad1', altKey: true }), 'Alt+num1');
  assert.equal(key({ key: '+', code: 'NumpadAdd', ctrlKey: true }), 'Control+numadd');
  assert.equal(key({ key: 'F12', code: 'F12' }), 'F12');
  assert.equal(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), null);
  assert.equal(key({ key: 'x', code: 'KeyX' }), null);
  assert.equal(key({ key: 'a', code: 'KeyA', ctrlKey: true, repeat: true }), null);
});
test('separate model cards preserve configuration order, partial answers and completed answers after stopping', () => {
  let turn = { status: 'streaming', text: '' };
  turn = merge(turn, { id: 'second', index: 1, name: '备用', model: 'b', status: 'done', text: '先返回的答案' });
  assert.ok(turn.text.includes('先返回的答案'));
  turn = merge(turn, { id: 'first', index: 0, name: '主接口', model: 'a', status: 'pending', text: '' });
  assert.deepEqual(Array.from(turn.modelResults, r => r.id), ['first', 'second']);
  turn = merge(turn, { id: 'first', index: 0, name: '主接口', model: 'a', status: 'error', error: '超时', text: '' });
  assert.ok(turn.text.includes('先返回的答案'));
  assert.equal(turn.modelResults[0].error, '超时');
  turn = { ...turn, status: 'done' };
  assert.equal(merge(turn, { id: 'third', index: 2, status: 'done', text: 'late' }), turn);
});
