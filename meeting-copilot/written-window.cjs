'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FONTS = ['Microsoft YaHei', 'SimSun', 'SimHei', 'DengXian', 'Consolas', 'Arial'];
const MINIMUM = [190, 96];
const finite = value => typeof value === 'number' && Number.isFinite(value);

function createWrittenWindow({ file, screen, getModelCount = () => 1, onChange = () => {} }) {
  let win = null, timer = null, applying = false;
  let saved = {};
  try { if (fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const data = {
    enabled: saved.enabled === true,
    fontSize: finite(saved.fontSize) ? Math.max(12, Math.min(72, Math.round(saved.fontSize))) : 28,
    fontFamily: FONTS.includes(saved.fontFamily) ? saved.fontFamily : 'Microsoft YaHei',
    showNames: saved.showNames !== false,
    // Reading lock is temporary; restart always restores mouse operation.
    clickThrough: false,
    compactBounds: saved.compactBounds || null,
    normalBounds: saved.normalBounds || null,
    normalMin: saved.normalMin || [640, 380],
    normalMaximized: saved.normalMaximized === true
  };
  function persist() {
    clearTimeout(timer); timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(file + '.tmp', file);
  }
  function clampBounds(value) {
    const fallback = { x: 80, y: 80, width: 320, height: 76 + Math.max(1, Math.min(12, getModelCount())) * (data.fontSize + 12) };
    const candidate = value && ['x', 'y', 'width', 'height'].every(k => finite(value[k])) ? value : fallback;
    const work = screen.getDisplayMatching(candidate).workArea;
    const width = Math.min(work.width, Math.max(MINIMUM[0], Math.round(candidate.width)));
    const height = Math.min(work.height, Math.max(MINIMUM[1], Math.round(candidate.height)));
    return { x: Math.round(Math.max(work.x, Math.min(candidate.x, work.x + work.width - width))), y: Math.round(Math.max(work.y, Math.min(candidate.y, work.y + work.height - height))), width, height };
  }
  function initialOptions() {
    if (!data.enabled) return {};
    const bounds = clampBounds(data.compactBounds);
    return { ...bounds, minWidth: MINIMUM[0], minHeight: MINIMUM[1] };
  }
  function getPublic() {
    return { enabled: data.enabled, fontSize: data.fontSize, fontFamily: data.fontFamily, showNames: data.showNames, clickThrough: data.clickThrough, bounds: data.compactBounds ? { ...data.compactBounds } : null };
  }
  function applyInputMode() {
    if (!win || win.isDestroyed()) return;
    const locked = data.enabled && data.clickThrough;
    win.setIgnoreMouseEvents(locked, { forward: true });
    win.setFocusable(!locked);
  }
  function unlock() {
    if (data.clickThrough) {
      data.clickThrough = false;
      applyInputMode();
      persist();
      onChange(getPublic());
    }
  }
  function showInactive() {
    if (!win || win.isDestroyed()) return;
    // Unlike show()/focus(), this is only a visibility operation.
    win.showInactive();
  }
  function remember() {
    if (applying || !win || win.isDestroyed() || !data.enabled) return;
    data.compactBounds = { ...win.getBounds() };
    clearTimeout(timer);
    timer = setTimeout(persist, 120);
  }
  function applyLayout(reset = false) {
    if (!win || win.isDestroyed()) return;
    applying = true;
    try {
      if (data.enabled) {
        if (win.isMaximized()) win.unmaximize();
        win.setMinimumSize(...MINIMUM);
        let bounds = data.compactBounds;
        if (reset || !bounds) {
          const origin = win.getBounds();
          bounds = { ...clampBounds(null), x: origin.x, y: origin.y };
        }
        data.compactBounds = clampBounds(bounds);
        win.setBounds(data.compactBounds, false);
      } else {
        const minimum = Array.isArray(data.normalMin) && data.normalMin.length === 2 ? data.normalMin : [640, 380];
        win.setMinimumSize(...minimum);
        if (data.normalBounds) {
          const bounds = data.normalBounds;
          const work = screen.getDisplayMatching(bounds).workArea;
          const visible = bounds.x < work.x + work.width && bounds.x + bounds.width > work.x && bounds.y < work.y + work.height && bounds.y + bounds.height > work.y;
          win.setBounds(visible ? bounds : clampBounds(bounds), false);
        }
        if (data.normalMaximized) win.maximize();
      }
    } finally { applying = false; }
  }
  function attach(window) {
    win = window;
    window.on('resize', remember);
    window.on('move', remember);
    window.on('close', () => { remember(); if (timer) persist(); });
    window.on('closed', () => { if (timer) persist(); win = null; });
    if (data.enabled) applyLayout();
    applyInputMode();
  }
  function applyPatch(patch) {
    if (patch.fontSize !== undefined && (!finite(patch.fontSize) || patch.fontSize < 12 || patch.fontSize > 72)) throw new Error('小窗字号应在 12–72 之间');
    if (patch.fontDelta !== undefined && ![-2, 2].includes(patch.fontDelta)) throw new Error('字号调整无效');
    if (patch.fontFamily !== undefined && !FONTS.includes(patch.fontFamily)) throw new Error('请选择列表中的字体');
    if (patch.scale !== undefined && ![0.85, 1.15].includes(patch.scale)) throw new Error('窗口缩放比例无效');
    if (patch.clickThrough !== undefined && typeof patch.clickThrough !== 'boolean') throw new Error('鼠标穿透设置无效');
    if (patch.clickThrough && !(patch.enabled ?? data.enabled)) throw new Error('鼠标穿透仅在笔试小窗中可用');
    const changedMode = patch.enabled !== undefined && data.enabled !== !!patch.enabled;
    if (changedMode && patch.enabled && win && !win.isDestroyed()) {
      data.normalBounds = { ...win.getNormalBounds() };
      data.normalMin = win.getMinimumSize();
      data.normalMaximized = win.isMaximized();
    }
    if (patch.enabled !== undefined) data.enabled = !!patch.enabled;
    if (patch.fontSize !== undefined) data.fontSize = Math.round(patch.fontSize);
    if (patch.fontDelta !== undefined) data.fontSize = Math.max(12, Math.min(72, data.fontSize + patch.fontDelta));
    if (patch.fontFamily !== undefined) data.fontFamily = patch.fontFamily;
    if (patch.showNames !== undefined) data.showNames = !!patch.showNames;
    if (patch.clickThrough !== undefined) data.clickThrough = patch.clickThrough;
    if (!data.enabled) data.clickThrough = false;
    if (patch.scale && data.enabled) {
      const current = win && !win.isDestroyed() ? win.getBounds() : clampBounds(data.compactBounds);
      data.compactBounds = clampBounds({ ...current, width: current.width * patch.scale, height: current.height * patch.scale });
    }
    if (changedMode || patch.resetBounds || patch.scale) applyLayout(!!patch.resetBounds);
    applyInputMode();
    persist();
    onChange(getPublic());
    return getPublic();
  }
  function flush() { if (timer) persist(); }
  return { getPublic, initialOptions, attach, applyPatch, flush, unlock, showInactive };
}
module.exports = { createWrittenWindow, FONTS, MINIMUM };
