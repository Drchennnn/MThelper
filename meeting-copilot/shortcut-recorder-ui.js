function acceleratorFromKeyboardEvent(event) {
  if (event.isComposing || event.repeat || ['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph'].includes(event.key)) return null;
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  const names = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', '+': 'Plus', '=': '=', '-': '-', '\\': '\\' };
  const numpad = { NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec' };
  let key = names[event.key] || event.key;
  if (/^Key[A-Z]$/.test(event.code || '')) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code || '')) key = event.code.slice(5);
  else if (/^Numpad[0-9]$/.test(event.code || '')) key = 'num' + event.code.slice(6);
  else if (numpad[event.code]) key = numpad[event.code];
  else if (key?.length === 1) key = key.toUpperCase();
  if (!key || (!modifiers.length && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key))) return null;
  return [...modifiers, key].join('+');
}

function ShortcutRecorder({ label, value, onChange }) {
  const h = jsxRuntimeExports.jsx, hs = jsxRuntimeExports.jsxs;
  const [recording, setRecording] = reactExports.useState(false);
  const [message, setMessage] = reactExports.useState('');
  const [manual, setManual] = reactExports.useState(false);
  const input = reactExports.useRef(null);
  const session = reactExports.useRef(null);
  const ready = reactExports.useRef(false);
  const pendingKey = reactExports.useRef(false);
  const finish = () => {
    const token = session.current;
    session.current = null; ready.current = false; pendingKey.current = false;
    setRecording(false);
    if (token) void window.mc.endShortcutRecording(token).catch(() => {});
  };
  const begin = async () => {
    if (session.current) return;
    const token = crypto.randomUUID();
    session.current = token; ready.current = false;
    setRecording(true); setMessage('正在准备录制…');
    try {
      const ok = await window.mc.beginShortcutRecording(token);
      if (session.current !== token) return;
      if (!ok) { finish(); return; }
      ready.current = true;
      setMessage('请按组合键、F1–F24 或鼠标侧键；Esc 取消，Delete / Backspace 清除。');
    } catch (error) { if (session.current === token) { finish(); setMessage(error.message); } }
  };
  reactExports.useEffect(() => {
    const off = window.mc.onShortcutRecorded(event => {
      if (event.token !== session.current) return;
      if (event.ended) { finish(); setMessage(event.error || '录制已结束，点击“录制”重试'); return; }
      onChange(event.accelerator); setMessage('已录入，点击设置底部保存'); finish();
    });
    return () => { off(); const token = session.current; session.current = null; if (token) void window.mc.endShortcutRecording(token).catch(() => {}); };
  }, [onChange]);
  return hs('div', { className: 'settings-row', style: { alignItems: 'start' }, children: [
    h('label', { children: label }),
    hs('div', { style: { width: '100%' }, children: [
      h('input', {
        ref: input, value: value || '', readOnly: !manual, spellCheck: false, placeholder: recording ? '请按键…' : '未设置',
        'aria-label': label, onFocus: () => void begin(), onClick: () => void begin(), onBlur: finish,
        onChange: event => { if (manual) onChange(event.target.value); },
        onKeyDown: event => {
          if (manual) { if (event.key === 'Escape') { event.preventDefault(); finish(); } return; }
          event.preventDefault(); event.stopPropagation();
          if (!session.current) { void begin(); return; }
          if (!ready.current) return;
          if (event.key === 'Escape') { finish(); setMessage('已取消录制'); return; }
          if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && ['Delete', 'Backspace'].includes(event.key)) {
            onChange(''); setMessage('已清除，保存后生效'); pendingKey.current = true; return;
          }
          const accelerator = acceleratorFromKeyboardEvent(event);
          if (accelerator) { onChange(accelerator); pendingKey.current = true; setMessage('已录入，松开按键后点击保存'); }
        },
        onKeyUp: event => { if (pendingKey.current && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) finish(); },
        onMouseDown: event => { if (event.button === 3 || event.button === 4) { event.preventDefault(); event.stopPropagation(); } }
      }),
      hs('div', { style: { display: 'flex', gap: 8, marginTop: 6 }, children: [
        h('button', { className: 'btn btn-sm', type: 'button', onClick: () => { setManual(false); input.current?.focus(); void begin(); }, children: recording ? '录制中…' : '录制' }),
        h('button', { className: 'btn btn-sm', type: 'button', onClick: () => { finish(); setManual(v => !v); setMessage('可手动填写，如 Control+Shift+S 或 Mouse4；填写后保存'); }, children: manual ? '返回录制' : '手动填写' }),
        h('button', { className: 'btn btn-sm', type: 'button', onClick: () => { finish(); onChange(''); setMessage('已清除，保存后生效'); }, children: '清除' })
      ] }),
      message && h('div', { className: 'settings-hint', role: 'status', children: message })
    ] })
  ] });
}

function mergeModelAnswer(turn, result) {
  if (turn.status !== 'streaming') return turn;
  const results = [...(turn.modelResults || []).filter(item => item.id !== result.id), result].sort((a, b) => a.index - b.index);
  return { ...turn, modelResults: results, text: results.filter(item => item.status === 'done').map(item => `【${item.name} · ${item.model}】\n${item.text}`).join('\n\n') };
}
function ModelAnswers({ results, onlyOptions = false }) {
  const h = jsxRuntimeExports.jsx, hs = jsxRuntimeExports.jsxs;
  const display = value => onlyOptions ? compactWrittenAnswer(value) : value;
  return hs('div', { children: results.map(result => hs('div', { style: { border: '1px solid #ffffff25', borderRadius: 8, padding: 12, marginBottom: 10 }, children: [
    h('strong', { children: `${result.name} · ${result.model}` }),
    result.status === 'done' && !onlyOptions && h('button', { className: 'btn btn-sm', type: 'button', style: { float: 'right' }, onClick: () => void navigator.clipboard.writeText(display(result.text)), children: '复制' }),
    result.status === 'pending' ? h('div', { className: 'settings-hint', children: '正在回答…' }) : result.status === 'done'
      ? h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 8 }, children: onlyOptions ? h(WrittenAnswerContent, { value: result.text }) : display(result.text) })
      : h('div', { className: 'answer-error', children: result.error || '已停止' })
  ] }, result.id)) });
}
