function compactWrittenAnswer(value) {
  const raw = String(value || '').trim();
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const option = line => {
    const cleaned = line.replace(/\*\*|`/g, '').replace(/^(?:答案|正确答案|选项)\s*(?:是|为)?\s*[:：]?\s*/, '').replace(/^(?:第\s*)?\d+\s*(?:题)?\s*[.、:：)）-]\s*/, '').trim();
    const match = cleaned.match(/^[（(\[【]?\s*([A-H](?:[\s,，、/;；]*[A-H])*)\s*[)）\]】.。]?$/i);
    return match ? match[1].replace(/[\s,，、/;；]/g, '').toUpperCase() : null;
  };
  if (!lines.length) return '';
  if (/```/.test(raw)) return raw;
  const options = lines.map(option);
  if (options.every(Boolean)) return options.join('\n');
  // Discard only an explicitly labelled choice explanation, never fields or code.
  if (options[0] && /^(?:原因|解析|解释|说明|因为|Explanation|Reason)[:：\s是]/i.test(lines[1] || '')) return options[0];
  return raw;
}
function writtenAnswerBlocks(value) {
  const text = compactWrittenAnswer(value);
  const blocks = [];
  const fence = /^[ \t]*```([^\n`]*)\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  let offset = 0, match;
  while ((match = fence.exec(text))) {
    const before = text.slice(offset, match.index).trim();
    if (before) blocks.push({ kind: 'text', text: before });
    blocks.push({ kind: 'code', language: match[1].trim(), text: match[2].replace(/\r?\n$/, '') });
    offset = fence.lastIndex;
  }
  const after = text.slice(offset).trim();
  if (after) blocks.push({ kind: 'text', text: after });
  return blocks;
}
function WrittenAnswerContent({ value, fontSize = 16, fontFamily = 'Microsoft YaHei', compact = false }) {
  const h = jsxRuntimeExports.jsx, hs = jsxRuntimeExports.jsxs;
  const [expanded, setExpanded] = reactExports.useState(false);
  const [copied, setCopied] = reactExports.useState(false);
  const text = compactWrittenAnswer(value);
  const blocks = writtenAnswerBlocks(value);
  const options = /^[A-H]+(?:\n[A-H]+)*$/.test(text);
  const long = text.length > 400 || text.split('\n').length > 12;
  const copy = async () => {
    const plain = blocks.map(block => block.text).join('\n\n');
    try { await navigator.clipboard.writeText(plain || text); setCopied(true); }
    catch { setCopied(false); }
  };
  if (options) return h('button', { type: 'button', title: copied ? '已复制' : '点击复制答案', onClick: copy, style: { border: 0, padding: 0, margin: 0, background: 'transparent', color: 'inherit', textAlign: 'left', fontFamily: fontFamily + ', sans-serif', fontSize, fontWeight: 600, lineHeight: 1.15, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', cursor: 'copy', userSelect: 'text' }, children: text });
  return hs('div', { style: { minWidth: 0 }, children: [
    h('div', { style: { maxHeight: expanded ? 'none' : compact ? 180 : 280, overflow: 'auto', fontFamily: fontFamily + ', sans-serif', fontSize, lineHeight: 1.35 }, children: blocks.map((block, index) => block.kind === 'code'
      ? h('pre', { style: { margin: '4px 0', padding: 6, borderRadius: 4, background: '#00000025', overflowX: 'auto', whiteSpace: 'pre', tabSize: 4, fontFamily: 'Consolas, monospace', fontSize, lineHeight: 1.4 }, children: h('code', { 'data-language': block.language, children: block.text }) }, index)
      : h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, children: block.text }, index)) }),
    hs('div', { style: { display: 'flex', gap: 5, marginTop: 3 }, children: [
      h('button', { className: 'btn btn-sm', type: 'button', style: { fontSize: 10, padding: '0 4px' }, onClick: copy, children: copied ? '已复制' : '复制' }),
      long && h('button', { className: 'btn btn-sm', type: 'button', style: { fontSize: 10, padding: '0 4px' }, onClick: () => setExpanded(v => !v), children: expanded ? '收起' : '展开完整内容' })
    ] })
  ] });
}
function writtenAnswerRows(turn) {
  if (!turn) return [];
  if (turn.modelResults?.length) return [...turn.modelResults].sort((a, b) => a.index - b.index);
  const text = String(turn.text || '');
  const headings = [...text.matchAll(/^【([^\n]+)】\s*$/gm)];
  if (headings.length) return headings.map((heading, index) => ({
    id: 'stored-' + index, index, name: heading[1], model: '', status: 'done',
    text: text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length).trim()
  }));
  return [{ id: turn.id, index: 0, name: '答案', model: '', status: turn.status === 'streaming' ? 'pending' : turn.status === 'error' ? 'error' : 'done', text, error: turn.error }];
}
function WrittenCompactView({ preferences, turn, ready, error, onPatch, onCapture, onCancel, onRestore, onSettings }) {
  const h = jsxRuntimeExports.jsx, hs = jsxRuntimeExports.jsxs;
  const [options, setOptions] = reactExports.useState(false);
  const rows = writtenAnswerRows(turn);
  const control = { WebkitAppRegion: 'no-drag', fontSize: 11, padding: '1px 5px', minWidth: 23, height: 24 };
  const button = (text, title, action, disabled) => h('button', { className: 'btn btn-sm', type: 'button', title, onClick: action, disabled, style: control, children: text });
  return hs('section', { className: 'written-compact', style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100vh', minWidth: 0, minHeight: 0, boxSizing: 'border-box', padding: 6, border: '1px solid var(--app-border, #475066)', borderRadius: 8, background: 'var(--app-bg, #202633)', overflow: 'hidden', position: 'relative' }, children: [
    h('style', { children: 'html[data-written-compact="true"],html[data-written-compact="true"] body,html[data-written-compact="true"] #root{min-width:0!important;min-height:0!important;width:100%!important;height:100%!important;margin:0!important;overflow:hidden!important}' }),
    hs('header', { style: { display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, paddingBottom: 4, borderBottom: '1px solid var(--border-soft, #ffffff20)', WebkitAppRegion: 'drag' }, children: [
      h('strong', { style: { fontSize: 11, flex: 1, minWidth: 28, cursor: 'move' }, title: '拖动移动小窗；拖动窗口边缘调整大小', children: preferences.clickThrough ? '穿透' : '笔试' }),
      button('A−', '缩小答案字号', () => onPatch({ fontDelta: -2 }), preferences.fontSize <= 12),
      button('A+', '放大答案字号', () => onPatch({ fontDelta: 2 }), preferences.fontSize >= 72),
      button('⋯', '字体与窗口大小', () => setOptions(value => !value)),
      button('↗', '返回完整界面', onRestore)
    ] }),
    error && h('div', { role: 'alert', className: 'answer-error', style: { fontSize: 11 }, children: error }),
    options && hs('div', { style: { position: 'absolute', zIndex: 50, top: 34, left: 6, right: 6, maxHeight: 'calc(100% - 40px)', overflowY: 'auto', padding: 8, border: '1px solid var(--popup-border, #626c80)', borderRadius: 6, background: 'var(--popup-bg, #202633)', fontSize: 11 }, children: [
      hs('label', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }, children: ['字号 ', h('input', { type: 'range', min: 12, max: 72, step: 1, value: preferences.fontSize, title: '答案字号', style: { minWidth: 30, flex: 1 }, onChange: e => onPatch({ fontSize: Number(e.target.value) }) }), String(preferences.fontSize)] }),
      hs('label', { style: { display: 'flex', gap: 6, marginBottom: 7 }, children: ['字体 ', hs('select', { value: preferences.fontFamily, title: '答案字体', style: { flex: 1, minWidth: 30 }, onChange: e => onPatch({ fontFamily: e.target.value }), children: [
        ['Microsoft YaHei', '微软雅黑'], ['SimSun', '宋体'], ['SimHei', '黑体'], ['DengXian', '等线'], ['Consolas', 'Consolas'], ['Arial', 'Arial']
      ].map(([value, label]) => h('option', { value, children: label }, value)) })] }),
      hs('label', { style: { display: 'flex', gap: 6, marginBottom: 7 }, children: [h('input', { type: 'checkbox', checked: preferences.showNames, onChange: e => onPatch({ showNames: e.target.checked }) }), '显示模型名'] }),
      hs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 }, children: [
        button('缩小窗口', '缩小窗口尺寸', () => onPatch({ scale: 0.85 })),
        button('放大窗口', '放大窗口尺寸', () => onPatch({ scale: 1.15 })),
        button('适配答案', '按当前模型数与字号适配窗口', () => onPatch({ resetBounds: true })),
        button('模型设置', '返回完整界面编辑设置', onSettings),
        button('只读穿透', '忽略鼠标并禁止激活；从托盘“设置”恢复操作', () => { setOptions(false); onPatch({ clickThrough: true }); }),
        button('收起', '收起字体与窗口设置', () => setOptions(false))
      ] })
    ] }),
    preferences.clickThrough && h('div', { style: { fontSize: 10, opacity: 0.7, paddingTop: 3 }, children: '鼠标穿透中 · 托盘→设置恢复操作' }),
    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingTop: 4 }, children: rows.length ? rows.map((result, index) => hs('div', { style: { display: 'grid', gridTemplateColumns: preferences.showNames ? 'minmax(60px, 40%) minmax(0, 1fr)' : '16px minmax(0, 1fr)', alignItems: 'center', gap: 6, padding: '3px 1px', borderBottom: index + 1 < rows.length ? '1px solid var(--border-soft, #ffffff15)' : 'none' }, children: [
      h('span', { title: [result.name, result.model].filter(Boolean).join(' · '), style: { fontSize: 10, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: preferences.showNames ? `${index + 1} ${result.model || result.name}` : String(index + 1) }),
      result.status === 'done' ? h('div', { style: { minWidth: 0, gridColumn: /^[A-H]+(?:\n[A-H]+)*$/.test(compactWrittenAnswer(result.text)) ? undefined : '1 / -1' }, children: h(WrittenAnswerContent, { value: result.text, fontSize: preferences.fontSize, fontFamily: preferences.fontFamily, compact: true }, result.id) })
        : h('span', { title: result.error || '', style: { fontSize: result.status === 'pending' ? 16 : 11 }, className: result.status === 'error' ? 'answer-error' : '', children: result.status === 'pending' ? '…' : result.error || '已停止' })
    ] }, result.id)) : h('div', { style: { fontSize: 11, opacity: 0.7, padding: '8px 2px' }, children: ready ? '按截图键或点“框选”开始' : '请先在完整界面配置视觉模型' }) }),
    hs('footer', { style: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, paddingTop: 4, borderTop: '1px solid var(--border-soft, #ffffff20)' }, children: [
      button('全屏', '静默全屏截图问答（快捷键仍有效）', () => { setOptions(false); onCapture('full'); }, !ready),
      button('框选', '无全屏蒙层框选截图问答', () => { setOptions(false); onCapture('region'); }, !ready),
      button('停止', '停止当前所有模型', () => onCancel(turn.id), !turn || turn.status !== 'streaming'),
      h('span', { style: { marginLeft: 'auto', fontSize: 10, opacity: 0.55 }, children: rows.length ? `${rows.filter(r => r.status === 'done').length}/${rows.length}` : '' })
    ] })
  ] });
}
