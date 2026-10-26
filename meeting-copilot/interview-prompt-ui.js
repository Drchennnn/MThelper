function InterviewPromptSettings({ value, defaultValue, warning, onChange }) {
  const h = jsxRuntimeExports.jsx, hs = jsxRuntimeExports.jsxs;
  return hs('section', { style: { margin: '14px 0', padding: 12, border: '1px solid #ffffff25', borderRadius: 8 }, children: [
    h('label', { htmlFor: 'interview-prompt-editor', style: { display: 'block', fontWeight: 600, marginBottom: 6 }, children: '面试文本模型 Prompt' }),
    h('div', { className: 'settings-hint', children: '控制文本模型的面试回答，也供“普通面试”场景的多模态接口共用。笔试和截图面试各自使用独立 Prompt。修改后点击顶部“保存设置”，下一次提问生效。' }),
    h('textarea', { id: 'interview-prompt-editor', 'aria-label': '面试文本模型 Prompt', value, rows: 9, maxLength: 64000, spellCheck: false, style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'Consolas, Microsoft YaHei, monospace', lineHeight: 1.5 }, onChange: event => onChange(event.target.value) }),
    hs('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }, children: [
      h('button', { className: 'btn btn-sm', type: 'button', onClick: () => onChange(defaultValue), children: '恢复原版（保存后生效）' }),
      h('span', { className: 'settings-hint', children: `${value.length} / 64000` })
    ] }),
    warning && h('div', { className: 'settings-warn', role: 'alert', children: warning })
  ] });
}
