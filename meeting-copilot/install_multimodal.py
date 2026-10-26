"""Add editable prompts and dynamic API entries inside the original vision settings."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('capture_installer', HERE / 'install.py')
asar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asar)
MAIN = 'out/main/index.js'
RENDERER = 'out/renderer/assets/index-hyFYaQxP.js'
PRELOAD = 'out/preload/index.js'
MARKER = '// meeting-copilot-multimodal-v2'
OLD_MARKER = '// meeting-copilot-multimodal-v1'


def replace_one(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Application build mismatch near: ' + before[:100])
    return text.replace(before, after, 1)


def integrate_vision_section(renderer):
    renderer = replace_one(renderer, '    mmConfig && jsxRuntimeExports.jsx(MultimodalSettings, { value: mmConfig, onChange: setMmConfig }),\n', '')
    renderer = replace_one(renderer, '    mmSaveError && jsxRuntimeExports.jsx("div", { className: "settings-warn", children: mmSaveError }),\n', '')
    first = '      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-section", children: t.settings.visionSection }),'
    last = '      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-section", children: t.settings.asrSection }),'
    start = renderer.index(first)
    end = renderer.index(last, start)
    renderer = renderer[:start] + '''      mmConfig && jsxRuntimeExports.jsx(MultimodalSettings, { value: mmConfig, onChange: setMmConfig, providerSelect }),
      mmSaveError && jsxRuntimeExports.jsx("div", { className: "settings-warn", children: mmSaveError }),
''' + renderer[end:]
    renderer = replace_one(renderer, 'return "统一多模态 · " +', 'return "视觉模型 · " +')
    renderer = replace_one(renderer, 'settings?.multimodal?.enabled ? "统一多模态" :', 'settings?.multimodal?.enabled ? t.titlebar.vision :')
    return renderer


def upgrade_sources(main, renderer, preload):
    if OLD_MARKER not in main:
        raise ValueError('Expected the previous multimodal patch for this upgrade')
    start = renderer.index('function MultimodalSettings(')
    end = renderer.index('function SettingsPanel({', start)
    renderer = renderer[:start] + (HERE / 'multimodal-ui.js').read_text(encoding='utf8') + '\n' + renderer[end:]
    renderer = integrate_vision_section(renderer)
    return {MAIN: main.replace(OLD_MARKER, MARKER, 1).encode('utf8'), RENDERER: renderer.encode('utf8'), PRELOAD: preload.encode('utf8')}


def patch_sources(main, renderer, preload):
    if MARKER in main:
        raise ValueError('Multimodal patch already installed; runtime module and prompts can be edited separately')
    if 'stopMouseShot' not in main:
        raise ValueError('Install the screenshot/shortcut patch first')
    main = replace_one(main, '  let sessionStore;', '''  let sessionStore;
  let multimodalRouter;
  const unifiedEnabled = () => !!multimodalRouter?.getPublic().enabled;
  const unifiedProgress = (sendEv, requestId) => (message) => sendEv({ requestId, kind: "status", message });''')
    main = replace_one(main, '    pub.knowledge = { chars: knowledge.chars };', '''    pub.knowledge = { chars: knowledge.chars };
    pub.multimodal = multimodalRouter?.getPublic();''')
    main = replace_one(main, '    sessionStore = new SessionStore(path.join(electron.app.getPath("userData"), "sessions.json"));', '''    sessionStore = new SessionStore(path.join(electron.app.getPath("userData"), "sessions.json"));
    const mm = require(path.join(process.resourcesPath, "multimodal", "multimodal-router.cjs"));
    multimodalRouter = mm.createRouter({
      directory: path.join(electron.app.getPath("userData"), "multimodal"),
      defaultsDirectory: path.join(process.resourcesPath, "multimodal", "prompts"),
      safeStorage: electron.safeStorage,
      transport: mm.createElectronTransport(electron)
    });
    multimodalRouter.initialize({ ...settings.data.vision, apiKey: settings.getVisionApiKey() });
    electron.ipcMain.handle("multimodal:open-prompts", async () => {
      const error = await electron.shell.openPath(multimodalRouter.promptDir);
      if (error) throw new Error(error);
      return true;
    });''')
    main = replace_one(main, '      settings.applyPatch(patch);', '''      if (patch.multimodal) multimodalRouter.applyPatch(patch.multimodal);
      settings.applyPatch(patch);''')
    main = replace_one(main, '      if (!apiKey || settings.data.llm.answerWithVision) return;', '      if (!apiKey || unifiedEnabled() || settings.data.llm.answerWithVision) return;')
    main = replace_one(main, '''      if (!apiKey) {
        sendEv({ requestId: payload.requestId, kind: "error", message: T().noApiKey });''', '''      if (!apiKey && !unifiedEnabled()) {
        sendEv({ requestId: payload.requestId, kind: "error", message: T().noApiKey });''')
    main = replace_one(main, '      const useVision = settings.data.llm.answerWithVision && payload.mode', '      const useVision = !unifiedEnabled() && settings.data.llm.answerWithVision && payload.mode')
    main = replace_one(main, '      if (!isTranslate && !useVision && payload.mode !== "free") {', '      if (!unifiedEnabled() && !isTranslate && !useVision && payload.mode !== "free") {')
    main = replace_one(main, '      const work = useVision ? visionChat(', '''      const work = unifiedEnabled() ? Promise.resolve().then(() => multimodalRouter.chat(
        isTranslate ? messages : multimodalRouter.buildMessages({
          ...payload,
          answerLang: payload.answerLang ?? settings.data.llm.answerLang,
          background: payload.background || (hasMaterial ? void 0 : knowledge.text)
        }), ac.signal, unifiedProgress(sendEv, payload.requestId)
      )).then((text) => {
        if (!ac.signal.aborted) sendEv({ requestId: payload.requestId, kind: "delta", text });
        return { text };
      }) : useVision ? visionChat(''')
    main = replace_one(main, '      work.then((r) => {\n        const u = r.usage;', '      work.then((r) => {\n        if (ac.signal.aborted) return;\n        const u = r.usage;')
    main = replace_one(main, '''        const apiKey = settings.getLlmApiKey();
        if (!apiKey) return "";
        try {''', '''        const apiKey = settings.getLlmApiKey();
        if (unifiedEnabled()) {
          try { return clampMemo(await multimodalRouter.chat(buildMemoUpdateMessages(p.memo ?? "", p.question ?? "", p.answer ?? ""))); }
          catch { return ""; }
        }
        if (!apiKey) return "";
        try {''')
    main = replace_one(main, '''    electron.ipcMain.handle(IPC.translateText, async (_e, text) => {
      const apiKey''', '''    electron.ipcMain.handle(IPC.translateText, async (_e, text) => {
      if (unifiedEnabled()) return multimodalRouter.chat(buildTranslateMessages(text));
      const apiKey''')
    main = replace_one(main, '        if (!vision2.baseUrl || !vision2.model || !apiKey) {', '        if (!unifiedEnabled() && (!vision2.baseUrl || !vision2.model || !apiKey)) {')
    main = replace_one(main, '          (dataUrl) => visionChat(', '''          (dataUrl) => unifiedEnabled() ? multimodalRouter.chat(
            multimodalRouter.buildMessages({ ...payload, imageDataUrl: dataUrl, answerLang: settings.data.llm.answerLang, background: payload.background || knowledge.text }, "shot"),
            ac.signal, unifiedProgress(sendEv, payload.requestId)
          ) : visionChat(''')
    main = replace_one(main, '''        ).then((text) => {
          sendEv({ requestId: payload.requestId, kind: "delta", text });''', '''        ).then((text) => {
          if (ac.signal.aborted) return;
          sendEv({ requestId: payload.requestId, kind: "delta", text });''')
    main = MARKER + '\n' + main

    preload = replace_one(preload, '  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),', '''  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),
  openMultimodalPrompts: () => electron.ipcRenderer.invoke("multimodal:open-prompts"),''')

    renderer = replace_one(renderer, 'function SettingsPanel({', (HERE / 'multimodal-ui.js').read_text(encoding='utf8') + '\nfunction SettingsPanel({')
    renderer = replace_one(renderer, '  const [saving, setSaving] = reactExports.useState(false);', '''  const [saving, setSaving] = reactExports.useState(false);
  const [mmConfig, setMmConfig] = reactExports.useState(settings.multimodal);
  const [mmSaveError, setMmSaveError] = reactExports.useState("");''')
    renderer = replace_one(renderer, '      const next = await window.mc.setSettings({\n        llm:', '      const next = await window.mc.setSettings({\n        multimodal: mmConfig,\n        llm:')
    renderer = replace_one(renderer, '      onSaved(next);\n    } finally {', '      setMmSaveError("");\n      onSaved(next);\n    } catch (error) {\n      setMmSaveError(error.message);\n    } finally {')
    renderer = replace_one(renderer, '  const llmSummary = () => {', '''  const llmSummary = () => {
    if (mmConfig?.enabled) return "统一多模态 · " + (mmConfig.endpoints.find(e => e.enabled && e.baseUrl && e.model)?.name || "请配置接口");''')
    renderer = replace_one(renderer, '    /* @__PURE__ */ jsxRuntimeExports.jsxs("details", { className: "settings-advanced", children: [', '''    mmConfig && jsxRuntimeExports.jsx(MultimodalSettings, { value: mmConfig, onChange: setMmConfig }),
    mmSaveError && jsxRuntimeExports.jsx("div", { className: "settings-warn", children: mmSaveError }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("details", { className: "settings-advanced", children: [''')
    renderer = replace_one(renderer, '    const updated = await window.mc.setSettings({ llm: { answerWithVision: !settings.llm.answerWithVision } });', '''    const updated = await window.mc.setSettings(settings.multimodal
      ? { multimodal: { ...settings.multimodal, enabled: !settings.multimodal.enabled }, llm: { answerWithVision: false } }
      : { llm: { answerWithVision: !settings.llm.answerWithVision } });''')
    renderer = replace_one(renderer, '  const visionReady = !!settings?.llm.answerWithVision && !!settings?.vision.baseUrl && !!settings?.vision.model && !!settings?.vision.apiKeySet;', '''  const visionReady = settings?.multimodal?.enabled ? settings.multimodal.ready : !!settings?.llm.answerWithVision && !!settings?.vision.baseUrl && !!settings?.vision.model && !!settings?.vision.apiKeySet;''')
    renderer = replace_one(renderer, 'className: settings?.llm.answerWithVision ? "btn btn-on" : "btn",', 'className: (settings?.multimodal?.enabled || settings?.llm.answerWithVision) ? "btn btn-on" : "btn",')
    renderer = replace_one(renderer, 'children: settings?.llm.answerWithVision ? t.titlebar.vision : t.titlebar.textOnly', 'children: settings?.multimodal?.enabled ? "统一多模态" : settings?.llm.answerWithVision ? t.titlebar.vision : t.titlebar.textOnly')
    renderer = replace_one(renderer, '        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn", onClick: () => void toggleAnswerLang(),', '''        settings?.multimodal?.enabled && jsxRuntimeExports.jsxs("select", {
          value: settings.multimodal.mode, title: "切换笔试 / 普通面试场景", className: "btn",
          onChange: async (e) => {
            const next = await window.mc.setSettings({ multimodal: { ...settings.multimodal, mode: e.target.value } });
            setSettings(next);
          },
          children: [jsxRuntimeExports.jsx("option", { value: "auto", children: "自动" }), jsxRuntimeExports.jsx("option", { value: "written", children: "笔试" }), jsxRuntimeExports.jsx("option", { value: "interview", children: "面试" })]
        }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn", onClick: () => void toggleAnswerLang(),''')
    renderer = replace_one(renderer, '            if (ev.kind === "delta") return', '            if (ev.kind === "status") return { ...t2, progress: ev.message };\n            if (ev.kind === "delta") return')
    renderer = replace_one(renderer, '        turn.status === "streaming" && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cursor", children: "▍" })', '''        turn.status === "streaming" && turn.progress && jsxRuntimeExports.jsx("div", { className: "settings-hint", children: turn.progress }),
        turn.status === "streaming" && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cursor", children: "▍" })''')
    renderer = integrate_vision_section(renderer)
    return {MAIN: main.encode('utf8'), RENDERER: renderer.encode('utf8'), PRELOAD: preload.encode('utf8')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app_dir', nargs='?', default=str(Path(os.environ['LOCALAPPDATA']) / 'Programs/meeting-copilot'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    app_dir = Path(args.app_dir).resolve()
    target = app_dir / 'resources/app.asar'
    archive = target.read_bytes()
    header, start = asar.read_header(archive)
    sources = [asar.read_member(archive, header, start, p).decode('utf8') for p in [MAIN, RENDERER, PRELOAD]]
    upgrading = OLD_MARKER in sources[0]
    if MARKER in sources[0]:
        print('Dynamic vision API settings are already installed.')
        return
    replacements = upgrade_sources(*sources) if upgrading else patch_sources(*sources)
    check_dir = HERE.parent / 'work/multimodal-check'
    check_dir.mkdir(parents=True, exist_ok=True)
    for name, data in replacements.items():
        check_path = check_dir / ('renderer.mjs' if name == RENDERER else ('preload.cjs' if name == PRELOAD else 'main.cjs'))
        check_path.write_bytes(data)
        subprocess.run(['node', '--check', str(check_path)], check=True)
    if args.check:
        print('Compatible. All patched JavaScript passes syntax checks. No application files changed.')
        return
    asar.require_closed(app_dir)
    backup = target.with_name('app.asar.before-dynamic-vision.bak' if upgrading else 'app.asar.before-multimodal.bak')
    if backup.exists() and asar.sha256(backup.read_bytes()) != asar.sha256(archive):
        raise RuntimeError('A different multimodal backup already exists')
    patched = asar.replace_members(archive, replacements)
    new_header, new_start = asar.read_header(patched)
    for name, data in replacements.items():
        if asar.read_member(patched, new_header, new_start, name) != data:
            raise RuntimeError('ASAR verification failed: ' + name)
    if not backup.exists():
        shutil.copy2(target, backup)
    module_dir = app_dir / 'resources/multimodal'
    module_dir.mkdir(parents=True, exist_ok=True)
    if upgrading and (module_dir / 'multimodal-router.cjs').exists() and not (module_dir / 'multimodal-router.cjs.before-dynamic.bak').exists():
        shutil.copy2(module_dir / 'multimodal-router.cjs', module_dir / 'multimodal-router.cjs.before-dynamic.bak')
    shutil.copy2(HERE / 'multimodal-router.cjs', module_dir / 'multimodal-router.cjs')
    shutil.copytree(HERE / 'prompts', module_dir / 'prompts', dirs_exist_ok=True)
    staged = target.with_name('app.asar.multimodal.tmp')
    if staged.exists():
        raise RuntimeError('Existing staging archive requires review')
    staged.write_bytes(patched)
    os.replace(staged, target)
    print('Installed: dynamic API entries in the original vision model section.')
    print('Backup:', backup)


if __name__ == '__main__':
    main()
