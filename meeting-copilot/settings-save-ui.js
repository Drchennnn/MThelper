function replaceSavedVisionDraft(previous, multimodal) {
  return JSON.stringify({ ...JSON.parse(previous), multimodal });
}
function useSettingsSaveState(draft) {
  const [baseline, setBaseline] = reactExports.useState(() => JSON.stringify(draft));
  return {
    dirty: JSON.stringify(draft) !== baseline,
    commitAll: (multimodal) => setBaseline(JSON.stringify({ ...draft, multimodal, keys: [null, null, null, null] })),
    commitVision: (multimodal) => setBaseline(previous => replaceSavedVisionDraft(previous, multimodal))
  };
}
function SettingsSaveBar({ dirty, saving, message, error, confirmClose, onSave, onClose, onSaveClose, onDiscard, onContinue }) {
  const h = jsxRuntimeExports.jsx, hs = jsxRuntimeExports.jsxs;
  return hs('div', { style: { position: 'sticky', top: 0, zIndex: 30, background: 'var(--panel, #20242a)', borderBottom: '1px solid #ffffff25', padding: '10px 12px', marginBottom: 12 }, children: [
    hs('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }, children: [
      h('strong', { children: '设置' }),
      h('span', { role: 'status', style: { flex: 1 }, children: saving ? '保存中…' : dirty ? '有未保存的修改' : message || '没有未保存的修改' }),
      h('button', { className: 'btn btn-primary', type: 'button', onClick: () => onSave(), disabled: saving, children: '保存设置' }),
      h('button', { className: 'btn', type: 'button', onClick: () => onClose(), disabled: saving, children: '关闭' })
    ] }),
    error && h('div', { className: 'settings-warn', role: 'alert', children: error }),
    confirmClose && hs('div', { className: 'settings-warn', role: 'alert', children: [
      h('div', { children: '有未保存的设置。未填写 API Key 的空白接口也可以保存。' }),
      hs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }, children: [
        h('button', { className: 'btn btn-primary', type: 'button', disabled: saving, onClick: onSaveClose, children: '保存并关闭' }),
        h('button', { className: 'btn', type: 'button', disabled: saving, onClick: onDiscard, children: '放弃修改' }),
        h('button', { className: 'btn', type: 'button', disabled: saving, onClick: onContinue, children: '继续编辑' })
      ] })
    ] })
  ] });
}
