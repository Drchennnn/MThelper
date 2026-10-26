// This replaces the original vision section inside Advanced Settings.
function MultimodalSettings({ value, onChange, providerSelect, onSave, saving }) {
  const h = jsxRuntimeExports.jsx;
  const hs = jsxRuntimeExports.jsxs;
  const [folderError, setFolderError] = reactExports.useState("");
  const addedId = reactExports.useRef(null);
  reactExports.useEffect(() => {
    if (addedId.current) {
      document.getElementById(`vision-api-${addedId.current}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      addedId.current = null;
    }
  }, [value.endpoints.length]);
  const update = (patch) => onChange({ ...value, ...patch });
  const updateEndpoint = (index, patch) => update({ endpoints: value.endpoints.map((e, i) => i === index ? { ...e, ...patch } : e) });
  const addEndpoint = () => {
    const id = crypto.randomUUID();
    addedId.current = id;
    update({ endpoints: [...value.endpoints, { id, name: "", enabled: true, baseUrl: "", model: "", proxyUrl: "", timeoutMs: 30000, apiKeySet: false }] });
  };
  const row = (label, child, key) => hs("div", { className: "settings-row", children: [h("label", { children: label }), child] }, key);
  const field = (index, name, label, props = {}) => row(label, h("input", {
    value: value.endpoints[index][name] ?? "", spellCheck: false,
    onChange: (event) => updateEndpoint(index, { [name]: event.target.value }), ...props
  }), name);
  return hs("div", { className: "vision-endpoints", children: [
    hs("div", { className: "settings-section", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }, children: [
      h("span", { children: "截图模型（多模态接口）" }),
      h("button", { className: "btn btn-primary btn-sm", type: "button", onClick: onSave, disabled: !!saving, children: saving ? "保存中…" : "保存视觉设置" }),
      h("button", { className: "btn btn-sm", type: "button", title: "添加视觉模型接口", "aria-label": "添加视觉模型接口", onClick: addEndpoint, children: "＋" })
    ] }),
    h("div", { className: "settings-hint", children: "点击 ＋ 添加一个备用 API 接口。按从上到下的顺序请求，超时或失败时自动切换。接口使用 OpenAI 兼容协议，模型需要支持图片输入。" }),
    row("启用截图问答", h("input", { type: "checkbox", checked: value.enabled, onChange: (e) => update({ enabled: e.target.checked }) })),
    row("笔试截图同时回答", h("input", { type: "checkbox", checked: !!value.simultaneousAnswers, onChange: (e) => update({ simultaneousAnswers: e.target.checked }) })),
    h("div", { className: "settings-hint", children: "转录问答、持续答、手动提问、翻译和备忘固定使用文本模型。只有截图才调用这里的接口。面试及自动场景的截图按主接口→备用接口顺序作答，只返回一份答案。" }),
    h("div", { className: "settings-hint", children: value.simultaneousAnswers ? "笔试场景的截图由所有已启用且配置完整的接口同时作答，按模型分别显示。面试截图不受此开关影响。" : "笔试截图也按接口顺序请求，失败后切换备用接口。" }),
    row("作答场景", hs("select", { value: value.mode, onChange: (e) => update({ mode: e.target.value }), children: [
      h("option", { value: "auto", children: "自动判断" }), h("option", { value: "written", children: "笔试" }), h("option", { value: "interview", children: "普通面试" })
    ] })),
    row("拒答时切换备用接口", h("input", { type: "checkbox", disabled: value.mode === "written" && !!value.simultaneousAnswers, checked: value.retryOnRefusal, onChange: (e) => update({ retryOnRefusal: e.target.checked }) })),
    ...value.endpoints.map((endpoint, index) => hs("div", {
      id: `vision-api-${endpoint.id}`,
      style: { border: "1px solid #ffffff20", borderRadius: 8, padding: 12, margin: "12px 0", scrollMarginTop: 88 },
      children: [
        hs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }, children: [
          h("strong", { children: `接口 ${index + 1}${index === 0 ? "（主接口）" : "（备用）"}` }),
          value.endpoints.length > 1 && h("button", { className: "btn btn-sm", type: "button", title: `移除接口 ${index + 1}（保存后生效）`, onClick: () => update({ endpoints: value.endpoints.filter(e => e.id !== endpoint.id) }), children: "移除" })
        ] }),
        row("启用此接口", h("input", { type: "checkbox", checked: endpoint.enabled, onChange: (e) => updateEndpoint(index, { enabled: e.target.checked }) })),
        row("服务商", providerSelect("vision", endpoint.baseUrl, endpoint.model, (preset) => updateEndpoint(index, { baseUrl: preset.baseUrl, model: preset.model, proxyUrl: preset.defaultProxyUrl || "" }))),
        field(index, "name", "接口名称（可选）", { placeholder: `接口 ${index + 1}` }),
        field(index, "baseUrl", "Base URL", { placeholder: "https://你的服务地址/v1" }),
        field(index, "model", "视觉模型名", { placeholder: "填写服务商提供的完整模型 ID" }),
        field(index, "apiKey", "视觉 API Key", { type: "password", autoComplete: "new-password", placeholder: endpoint.apiKeySet ? "已保存；留空保留原密钥" : "尚未填写（本地无鉴权接口可留空）", onChange: (e) => {
          const text = e.target.value;
          const next = { ...endpoint };
          if (text) next.apiKey = text; else delete next.apiKey;
          update({ endpoints: value.endpoints.map((v, i) => i === index ? next : v) });
        } }),
        endpoint.apiKeySet && h("button", { className: "btn btn-sm", type: "button", children: endpoint.apiKey === "" ? "已标记清除（保存后生效）" : "清除已保存的密钥", onClick: () => updateEndpoint(index, { apiKey: "" }) }),
        field(index, "proxyUrl", "视觉代理（可选）", { placeholder: "如 http://127.0.0.1:7890；直连留空" }),
        row("单接口超时（秒）", h("input", { type: "number", min: 5, max: 180, value: endpoint.timeoutMs / 1000, onChange: (e) => updateEndpoint(index, { timeoutMs: Number(e.target.value) * 1000 }) }))
      ]
    }, endpoint.id)),
    h("button", { className: "btn", type: "button", onClick: addEndpoint, children: "＋ 添加备用接口" }),
    h("div", { className: "settings-hint", children: "空白接口和未填写 API Key 的接口也可以先保存。修改后点击本区“保存视觉设置”或顶部“保存设置”；未填写完整的接口不会用于问答。" }),
    h("div", { className: "settings-hint", children: "笔试模式：所有接口共用 written.md，选择题和简单题直接给答案。面试模式：采用原版面试 / 截图提示词。" }),
    h("button", { className: "btn", type: "button", children: "定位笔试 Prompt（written.md）", onClick: async () => {
      try { await window.mc.openModelPrompt("written"); setFolderError(""); }
      catch (error) { setFolderError(error.message); }
    } }),
    h("button", { className: "btn", type: "button", children: "打开提示词文件夹", onClick: async () => {
      try { await window.mc.openMultimodalPrompts(); setFolderError(""); }
      catch (error) { setFolderError(error.message); }
    } }),
    folderError && h("div", { className: "settings-warn", children: folderError })
  ] });
}
