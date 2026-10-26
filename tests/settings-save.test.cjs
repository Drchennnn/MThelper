'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../meeting-copilot/settings-save-ui.js'), 'utf8');

test('saving visual settings clears only visual changes, preserving unrelated unsaved settings', () => {
  let baseline;
  const useSave = vm.runInNewContext(source + '\nuseSettingsSaveState;', { reactExports: { useState: initial => {
    if (baseline === undefined) baseline = initial();
    return [baseline, update => { baseline = typeof update === 'function' ? update(baseline) : update; }];
  } } });
  const original = { model: 'old-text-model', keys: [null, null, null, null], multimodal: { endpoints: [{ id: 'one' }] } };
  assert.equal(useSave(original).dirty, false);
  const vision = { endpoints: [{ id: 'one' }, { id: 'new-blank', baseUrl: '', model: '' }] };
  const changed = { ...original, multimodal: vision };
  assert.equal(useSave(changed).dirty, true);
  useSave(changed).commitVision(vision);
  assert.equal(useSave(changed).dirty, false);
  const unrelated = { ...changed, model: 'unsaved-text-model', interviewPrompt: 'unsaved interview prompt' };
  useSave(unrelated).commitVision(vision);
  assert.equal(useSave(unrelated).dirty, true);
  useSave(unrelated).commitAll(vision);
  assert.equal(useSave(unrelated).dirty, false);
});

test('the always-visible save bar exposes save, unsaved-close choices and save failures', () => {
  const element = (type, props) => ({ type, props });
  const bar = vm.runInNewContext(source + '\nSettingsSaveBar;', { jsxRuntimeExports: { jsx: element, jsxs: element } });
  const calls = [];
  const tree = bar({ dirty: true, saving: false, confirmClose: true, error: '无法写入设置', onSave: () => calls.push('save'), onClose: () => calls.push('close'), onSaveClose: () => calls.push('save-close'), onDiscard: () => calls.push('discard'), onContinue: () => calls.push('continue') });
  const all = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat().flatMap(all)];
  const nodes = all(tree);
  assert.equal(tree.props.style.position, 'sticky');
  for (const text of ['保存设置', '保存并关闭', '放弃修改', '继续编辑', '无法写入设置']) assert.ok(nodes.some(n => n.props?.children === text));
  nodes.find(n => n.props?.children === '保存设置').props.onClick();
  nodes.find(n => n.props?.children === '保存并关闭').props.onClick();
  nodes.find(n => n.props?.children === '继续编辑').props.onClick();
  assert.deepEqual(calls, ['save', 'save-close', 'continue']);
});
