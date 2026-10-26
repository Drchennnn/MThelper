'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createCaptureService({ helperPath, execFile = require('node:child_process').execFile, tempRoot = os.tmpdir() }) {
  let busy = false;
  let child = null;
  let cancelled = false;
  async function capture(mode = 'full') {
    if (!['full', 'region'].includes(mode)) throw new Error('未知截图模式');
    if (busy) return null;
    busy = true;
    cancelled = false;
    let directory;
    try {
      directory = await fs.promises.mkdtemp(path.join(tempRoot, 'meeting-copilot-shot-'));
      const file = path.join(directory, 'screen.png');
      const result = await new Promise((resolve, reject) => {
        child = execFile(helperPath, [mode === 'region' ? '--capture-region' : '--capture-once', file], {
          windowsHide: true, timeout: mode === 'region' ? 75000 : 15000
        }, error => {
          child = null;
          if (cancelled || (mode === 'region' && error?.code === 2)) resolve(false);
          else if (error) reject(new Error(mode === 'region' ? '区域截图失败或等待超时，请重新框选。' : '静默全屏截图失败，请重试。'));
          else resolve(true);
        });
        if (cancelled) child?.kill();
      });
      if (!result || cancelled) return null;
      const bytes = await fs.promises.readFile(file);
      return 'data:image/png;base64,' + bytes.toString('base64');
    } finally {
      child = null;
      try {
        if (directory) {
          await fs.promises.rm(path.join(directory, 'screen.png'), { force: true });
          await fs.promises.rmdir(directory);
        }
      } finally { busy = false; }
    }
  }
  function cancel() { cancelled = true; child?.kill(); }
  return { capture, cancel, get busy() { return busy; } };
}

function normalizeShortcut(value) {
  return String(value || '').trim().toLowerCase().replace(/ctrl|commandorcontrol|cmdorctrl/g, 'control').split('+').map(x => x.trim()).filter(Boolean).sort().join('+');
}
function createCaptureSettings({ file, shortcuts }) {
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { hotkeyRegion: 'Control+Shift+A' };
  let registrationError = '';
  const getPublic = () => ({ hotkeyRegion: String(state.hotkeyRegion || ''), registrationError });
  function validate(patch, existing) {
    const hotkey = String(patch?.hotkeyRegion ?? state.hotkeyRegion).trim();
    const keys = [['框选', hotkey], ['全屏截图', existing.hotkeyShot || ''], ['呼出', existing.hotkeyToggle || '']];
    const assigned = keys.filter(([, key]) => key).map(([, key]) => normalizeShortcut(key));
    if (new Set(assigned).size !== assigned.length) throw new Error('框选、全屏截图和呼出快捷键不能重复');
    for (const [name, key] of keys) {
      if (!key || /^Mouse[45]$/.test(key)) continue;
      if (!(/(control|ctrl|alt|shift|super|command)/i.test(key) && key.includes('+')) && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) throw new Error(`${name}键请使用组合键、F1–F24 或 Mouse4 / Mouse5`);
      if (!shortcuts.isRegistered(key)) {
        let ok;
        try { ok = shortcuts.register(key, () => {}); }
        catch { throw new Error(`${name}快捷键格式无效，请重新录入`); }
        if (!ok) throw new Error(`${name}快捷键已被其他程序占用，请换一组`);
        shortcuts.unregister(key);
      }
    }
    return { hotkeyRegion: hotkey };
  }
  function applyPatch(patch, existing) {
    const next = validate(patch, existing);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
    fs.renameSync(file + '.tmp', file);
    state = next;
    registrationError = '';
  }
  return { getPublic, applyPatch, validate, setRegistrationError: error => { registrationError = error; } };
}
module.exports = { createCaptureService, createCaptureSettings, normalizeShortcut };
