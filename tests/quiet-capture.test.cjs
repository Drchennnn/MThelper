'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCaptureService, createCaptureSettings } = require('../meeting-copilot/quiet-capture.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-region-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('full-screen and region captures call distinct native modes with appropriate timeouts and clean temporary files', async t => {
  const root = fixture(t);
  const calls = [];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const service = createCaptureService({ helperPath: 'native-helper.exe', tempRoot: root, execFile: (exe, args, options, cb) => {
    calls.push({ exe, args, options });
    setImmediate(() => { fs.writeFileSync(args[1], png); cb(null); });
    return { kill: () => {} };
  } });
  assert.equal(await service.capture(), 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(await service.capture('region'), 'data:image/png;base64,' + png.toString('base64'));
  assert.deepEqual(calls.map(c => c.args[0]), ['--capture-once', '--capture-region']);
  assert.deepEqual(calls.map(c => c.options.timeout), [15000, 75000]);
  assert.ok(calls.every(c => c.options.windowsHide));
  assert.deepEqual(fs.readdirSync(root), []);
});
test('native Escape/right-click cancellation yields no image and no lingering files', async t => {
  const root = fixture(t);
  const service = createCaptureService({ helperPath: 'helper', tempRoot: root, execFile: (exe, args, options, cb) => {
    setImmediate(() => cb(Object.assign(new Error('cancelled'), { code: 2 })));
    return { kill: () => {} };
  } });
  assert.equal(await service.capture('region'), null);
  assert.equal(service.busy, false);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('rapid repeated shortcuts cannot create overlapping selectors; shutdown kills the active helper', async t => {
  const root = fixture(t);
  let called, finish;
  const started = new Promise(resolve => { called = resolve; });
  let launches = 0, kills = 0;
  const service = createCaptureService({ helperPath: 'helper', tempRoot: root, execFile: (exe, args, options, cb) => {
    launches++; finish = cb; called();
    return { kill: () => { kills++; setImmediate(() => finish(Object.assign(new Error('killed'), { code: null }))); } };
  } });
  const pending = service.capture('region');
  await started;
  assert.equal(await service.capture('region'), null);
  assert.equal(await service.capture('full'), null);
  service.cancel();
  assert.equal(await pending, null);
  assert.equal(launches, 1);
  assert.equal(kills, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('helper failures clean up without returning a misleading screenshot', async t => {
  const root = fixture(t);
  const service = createCaptureService({ helperPath: 'helper', tempRoot: root, execFile: (exe, args, options, cb) => {
    setImmediate(() => { fs.writeFileSync(args[1], 'partial'); cb(Object.assign(new Error('native details'), { code: 1 })); });
    return { kill: () => {} };
  } });
  await assert.rejects(service.capture('region'), /区域截图失败/);
  assert.equal(service.busy, false);
  assert.deepEqual(fs.readdirSync(root), []);
  await assert.rejects(service.capture('bogus'), /未知截图模式/);
});
function shortcuts() {
  const active = new Set();
  return { active, isRegistered: key => active.has(key), register: key => {
    if (key === 'Control+BadKey') throw new Error('Invalid accelerator');
    if (key === 'Control+Alt+Q') return false;
    active.add(key); return true;
  }, unregister: key => active.delete(key) };
}
test('region shortcut supports combinations, either side button, clearing and persisted reload', t => {
  const root = fixture(t), api = shortcuts();
  const file = path.join(root, 'capture.json');
  const store = createCaptureSettings({ file, shortcuts: api });
  const current = { hotkeyToggle: 'Control+B', hotkeyShot: 'Mouse5' };
  assert.equal(store.getPublic().hotkeyRegion, 'Control+Shift+A');
  store.applyPatch({ hotkeyRegion: 'Alt+Shift+R' }, current);
  assert.equal(api.active.size, 0, 'preflight registration must be removed');
  const reload = createCaptureSettings({ file, shortcuts: api });
  assert.equal(reload.getPublic().hotkeyRegion, 'Alt+Shift+R');
  reload.applyPatch({ hotkeyRegion: 'Mouse4' }, current);
  assert.equal(reload.getPublic().hotkeyRegion, 'Mouse4');
  reload.applyPatch({ hotkeyRegion: '' }, current);
  assert.equal(reload.getPublic().hotkeyRegion, '');
  reload.applyPatch({ hotkeyRegion: 'Mouse5' }, { ...current, hotkeyShot: 'Mouse4' });
  assert.equal(reload.getPublic().hotkeyRegion, 'Mouse5');
});
test('conflicting, malformed and unavailable shortcuts are rejected without changing saved settings', t => {
  const root = fixture(t), api = shortcuts();
  const file = path.join(root, 'capture.json');
  const store = createCaptureSettings({ file, shortcuts: api });
  const current = { hotkeyToggle: 'Control+B', hotkeyShot: 'Mouse5' };
  store.applyPatch({ hotkeyRegion: 'Alt+Shift+R' }, current);
  const before = fs.readFileSync(file, 'utf8');
  for (const hotkeyRegion of ['Ctrl+B', 'Mouse5', 'A', 'Control+BadKey', 'Control+Alt+Q']) {
    assert.throws(() => store.applyPatch({ hotkeyRegion }, current));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});
