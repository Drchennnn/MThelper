'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createWrittenWindow, MINIMUM } = require('../meeting-copilot/written-window.cjs');
const source = fs.readFileSync(path.resolve(__dirname, '../meeting-copilot/written-window-ui.js'), 'utf8');
const format = vm.runInNewContext(source + '\ncompactWrittenAnswer;');
const rows = vm.runInNewContext(source + '\nwrittenAnswerRows;');
class FakeWindow extends EventEmitter {
  constructor() { super(); this.bounds = { x: 200, y: 100, width: 940, height: 560 }; this.minimum = [640, 380]; this.maximized = false; }
  isDestroyed() { return false; }
  isMaximized() { return this.maximized; }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  getBounds() { return { ...this.bounds }; }
  getNormalBounds() { return { ...this.bounds }; }
  getMinimumSize() { return [...this.minimum]; }
  setMinimumSize(w, h) { this.minimum = [w, h]; }
  setBounds(bounds) { this.bounds = { ...bounds }; this.emit('resize'); this.emit('move'); }
  setIgnoreMouseEvents(ignore) { this.ignoresMouse = ignore; }
  setFocusable(focusable) { this.focusable = focusable; }
  showInactive() { this.inactiveShows = (this.inactiveShows || 0) + 1; }
}
function fixture(t, count = 4) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'written-window-test-'));
  const file = path.join(folder, 'written-window.json');
  const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) };
  const host = createWrittenWindow({ file, screen, getModelCount: () => count });
  const win = new FakeWindow();
  host.attach(win);
  t.after(() => { win.emit('close'); win.emit('closed'); host.flush(); fs.rmSync(folder, { recursive: true, force: true }); });
  return { folder, file, host, win, screen };
}
test('compact mode lowers the minimum size, fits four answer rows and restores the original window', t => {
  const { host, win } = fixture(t);
  const original = win.getBounds();
  host.applyPatch({ enabled: true });
  assert.deepEqual(win.minimum, MINIMUM);
  assert.equal(win.bounds.width, 320);
  assert.equal(win.bounds.height, 236);
  assert.equal(host.getPublic().enabled, true);
  host.applyPatch({ enabled: false });
  assert.deepEqual(win.getBounds(), original);
  assert.deepEqual(win.minimum, [640, 380]);
});
test('a single model starts in a smaller answer-sized window', t => {
  const { host, win } = fixture(t, 1);
  host.applyPatch({ enabled: true });
  assert.equal(win.bounds.height, 116);
  assert.equal(win.bounds.width, 320);
});
test('dragged bounds, font and label preferences survive restart and initial startup stays compact', t => {
  const { host, win, file, screen } = fixture(t);
  host.applyPatch({ enabled: true, fontFamily: 'Consolas', fontSize: 34, showNames: false });
  win.setBounds({ x: 420, y: 180, width: 280, height: 180 });
  host.flush();
  const next = createWrittenWindow({ file, screen, getModelCount: () => 4 });
  assert.equal(next.getPublic().fontSize, 34);
  assert.equal(next.getPublic().fontFamily, 'Consolas');
  assert.equal(next.getPublic().showNames, false);
  assert.equal(next.initialOptions().width, 280);
  assert.equal(next.initialOptions().minWidth, 190);
  const reopened = new FakeWindow();
  next.attach(reopened);
  assert.deepEqual(reopened.getBounds(), { x: 420, y: 180, width: 280, height: 180 });
  next.applyPatch({ enabled: false });
  assert.deepEqual(reopened.getBounds(), { x: 200, y: 100, width: 940, height: 560 });
});
test('font controls and window scale remain independent and invalid values do not persist', t => {
  const { host, win, file } = fixture(t);
  host.applyPatch({ enabled: true });
  const before = win.getBounds();
  host.applyPatch({ fontDelta: 2 });
  assert.equal(host.getPublic().fontSize, 30);
  assert.deepEqual(win.getBounds(), before);
  host.applyPatch({ scale: 1.15 });
  assert.equal(win.bounds.width, 368);
  assert.equal(host.getPublic().fontSize, 30);
  const saved = fs.readFileSync(file, 'utf8');
  for (const patch of [{ fontSize: 200 }, { fontFamily: 'unknown' }, { fontDelta: 5 }, { scale: 0 }]) {
    assert.throws(() => host.applyPatch(patch));
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
  }
  host.applyPatch({ resetBounds: true });
  assert.equal(win.bounds.height, 76 + 4 * 42);
});
test('compact bounds stay visible after a display is disconnected', t => {
  const { host, win } = fixture(t);
  host.applyPatch({ enabled: true });
  win.setBounds({ x: -1800, y: -900, width: 400, height: 250 });
  host.flush();
  host.applyPatch({ enabled: false });
  host.applyPatch({ enabled: true });
  assert.ok(win.bounds.x >= 0 && win.bounds.y >= 0);
});
test('option formatter removes question numbers, prefixes and first-line explanations without guessing non-choice answers', () => {
  for (const [input, output] of [['2. B', 'B'], ['答案：B', 'B'], ['**B**', 'B'], ['正确答案为 AC', 'AC'], ['B、D', 'BD'], ['1. A\n2. C', 'A\nC'], ['B\n原因是……', 'B'], ['42', '42'], ['x = 2', 'x = 2'], ['无法确定，请补充题干', '无法确定，请补充题干']]) assert.equal(format(input), output);
});
test('compact rows retain every model and preserve status while displaying only the latest turn', () => {
  const current = { id: 'current', modelResults: [{ id: 'two', index: 1, model: 'b', status: 'pending' }, { id: 'one', index: 0, model: 'a', status: 'done', text: '2. B' }] };
  const result = rows(current);
  assert.deepEqual(Array.from(result, row => row.id), ['one', 'two']);
  assert.equal(result[1].status, 'pending');
  assert.equal(current.modelResults[0].id, 'two', 'presentation must not mutate session history');
  const stored = rows({ id: 'stored', text: '【接口 1 · a】\n2. B\n\n【接口 2 · b】\nB', status: 'done' });
  assert.equal(stored.length, 2);
  assert.equal(format(stored[0].text), 'B');
  assert.equal(rows(null).length, 0);
});
test('compact view provides font, restore and screenshot controls without transcription or interview tools', () => {
  const element = (type, props, key) => ({ type, props, key });
  const view = vm.runInNewContext(source + '\nWrittenCompactView;', { jsxRuntimeExports: { jsx: element, jsxs: element }, reactExports: { useState: initial => [initial, () => {}] } });
  const actions = [];
  const tree = view({ preferences: { fontSize: 28, fontFamily: 'Microsoft YaHei', showNames: true }, ready: true, turn: { id: 'answer', status: 'done', modelResults: [{ id: 'model', index: 0, name: '接口1', model: 'test', status: 'done', text: '2. B' }] }, onPatch: patch => actions.push(patch), onRestore: () => actions.push('restore'), onCapture: mode => actions.push(mode) });
  const all = node => !node || typeof node !== 'object' ? [] : typeof node.type === 'function' ? all(node.type(node.props)) : [node, ...[node.props?.children].flat().flatMap(all)];
  const nodes = all(tree);
  assert.ok(nodes.some(node => node.props?.children === 'B'));
  assert.equal(nodes.some(node => node.props?.children === '2. B'), false);
  assert.equal(nodes.some(node => node.props?.children === '转录'), false);
  nodes.find(node => node.props?.title === '放大答案字号').props.onClick();
  nodes.find(node => node.props?.title === '返回完整界面').props.onClick();
  nodes.find(node => node.props?.children === '框选').props.onClick();
  assert.equal(actions[0].fontDelta, 2);
  assert.equal(actions[1], 'restore');
  assert.equal(actions[2], 'region');
});

test('reading lock passes clicks through, cannot focus and unlocks without losing window preferences', t => {
  const { host, win, file, screen } = fixture(t);
  assert.throws(() => host.applyPatch({ clickThrough: true }));
  host.applyPatch({ enabled: true, clickThrough: true });
  assert.equal(win.ignoresMouse, true);
  assert.equal(win.focusable, false);
  const bounds = win.getBounds();
  host.showInactive();
  assert.equal(win.inactiveShows, 1);
  host.unlock();
  assert.equal(win.ignoresMouse, false);
  assert.equal(win.focusable, true);
  assert.deepEqual(win.getBounds(), bounds);
  host.applyPatch({ clickThrough: true });
  const next = createWrittenWindow({ file, screen });
  assert.equal(next.getPublic().clickThrough, false, 'restart must never trap the user in a mouse lock');
  host.applyPatch({ enabled: false });
  assert.equal(host.getPublic().clickThrough, false);
  assert.equal(win.focusable, true);
});

test('a leading option cannot discard required fields or code; code fences keep indentation', () => {
  const code = 'B\n```python\ndef solve(x):\n    return x + 1\n```';
  assert.equal(format(code), code);
  assert.equal(format('B\n用户名：alice\n年龄：25'), 'B\n用户名：alice\n年龄：25');
  const parse = vm.runInNewContext(source + '\nwrittenAnswerBlocks;');
  const blocks = parse(code);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'B');
  assert.equal(blocks[1].language, 'python');
  assert.equal(blocks[1].text, 'def solve(x):\n    return x + 1');
  assert.equal(parse('const a = 1;')[0].text, 'const a = 1;');
  assert.equal(parse('```html\n<script>alert(1)</script>\n```')[0].text, '<script>alert(1)</script>', 'code is inert text');
});

test('long code is scrollable and copied whole, without markdown fences', async () => {
  const element = (type, props, key) => ({ type, props, key });
  let clipboard;
  const content = vm.runInNewContext(source + '\nWrittenAnswerContent;', {
    jsxRuntimeExports: { jsx: element, jsxs: element }, reactExports: { useState: initial => [initial, () => {}] },
    navigator: { clipboard: { writeText: async value => { clipboard = value; } } }
  });
  const program = Array.from({ length: 45 }, (_, i) => '    line' + i).join('\n');
  const tree = content({ value: '```python\n' + program + '\n```', compact: true, fontSize: 28 });
  const all = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat().flatMap(all)];
  const nodes = all(tree);
  assert.ok(nodes.some(node => node.props?.style?.maxHeight === 180));
  assert.ok(nodes.some(node => node.type === 'code' && node.props.children === program));
  assert.ok(nodes.some(node => node.props?.children === '展开完整内容'));
  await nodes.find(node => node.props?.children === '复制').props.onClick();
  assert.equal(clipboard, program);
});
