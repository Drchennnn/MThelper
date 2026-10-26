"""Add a compact, resizable written-test answer window and option-only output."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
spec = importlib.util.spec_from_file_location('asar', HERE / 'install.py')
asar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asar)
MAIN = 'out/main/index.js'
RENDERER = 'out/renderer/assets/index-hyFYaQxP.js'
PRELOAD = 'out/preload/index.js'
MARKER = '// meeting-copilot-written-window-v1'


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Unexpected source near: ' + before[:100])
    return text.replace(before, after, 1)


def patch_sources(main, renderer, preload):
    if MARKER in main:
        raise ValueError('Written compact window already installed')
    if '// meeting-copilot-save-written-prompt-v1' not in main:
        raise ValueError('Install the settings-save and written-prompt patch first')
    main = once(main, '  let shortcutRuntime;', '  let shortcutRuntime;\n  let writtenWindow;')
    main = once(main, '    pub.capture = captureSettings?.getPublic();', '    pub.capture = captureSettings?.getPublic();\n    pub.writtenWindow = writtenWindow?.getPublic();')
    main = once(main, '    multimodalRouter.initialize({ ...settings.data.vision, apiKey: settings.getVisionApiKey() });', '''    multimodalRouter.initialize({ ...settings.data.vision, apiKey: settings.getVisionApiKey() });
    const { createWrittenWindow } = require(path.join(process.resourcesPath, "tools", "written-window.cjs"));
    writtenWindow = createWrittenWindow({
      file: path.join(electron.app.getPath("userData"), "written-window.json"), screen: electron.screen,
      getModelCount: () => {
        const config = multimodalRouter.getPublic();
        return config.simultaneousAnswers ? Math.max(1, config.endpoints.filter(endpoint => endpoint.enabled && endpoint.baseUrl && endpoint.model).length) : 1;
      }
    });
    electron.ipcMain.handle("written-window:set", (_event, patch = {}) => {
      if (patch.enabled === true) {
        const config = multimodalRouter.getPublic();
        multimodalRouter.applyPatch({ ...config, mode: "written", enabled: config.enabled || multimodalRouter.ready() });
      }
      writtenWindow.applyPatch(patch);
      return publicSettings();
    });''')
    main = once(main, '''      minWidth: 640,
      minHeight: 380,
      frame: false,''', '''      minWidth: 640,
      minHeight: 380,
      ...writtenWindow.initialOptions(),
      frame: false,''')
    main = once(main, '    win.setAlwaysOnTop(true, "screen-saver");', '    writtenWindow.attach(win);\n    win.setAlwaysOnTop(true, "screen-saver");')
    main = once(main, '  electron.app.on("before-quit", () => {', '  electron.app.on("before-quit", () => {\n    writtenWindow?.flush();')
    main = MARKER + '\n' + main
    preload = once(preload, '  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),', '  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),\n  setWrittenWindow: (patch) => electron.ipcRenderer.invoke("written-window:set", patch),')

    # Keep normal interview presentation unchanged; written answers use the compact option formatter.
    start = renderer.index('function ModelAnswers(')
    end = renderer.index('function replaceSavedVisionDraft(', start)
    helpers = (HERE / 'shortcut-recorder-ui.js').read_text(encoding='utf8')
    model_answers = helpers[helpers.index('function ModelAnswers('):]
    renderer = renderer[:start] + model_answers + '\n' + renderer[end:]
    renderer = once(renderer, 'function App() {', (HERE / 'written-window-ui.js').read_text(encoding='utf8') + '\nfunction App() {')
    renderer = once(renderer, '  const [settings, setSettings] = reactExports.useState(null);', '  const [settings, setSettings] = reactExports.useState(null);\n  const [writtenError, setWrittenError] = reactExports.useState("");')
    renderer = once(renderer, '  visionReady,\n  answersReady,', '  visionReady,\n  writtenMode,\n  answersReady,')
    renderer = once(renderer, 'jsxRuntimeExports.jsx(ModelAnswers, { results: turn.modelResults })', 'jsxRuntimeExports.jsx(ModelAnswers, { results: turn.modelResults, onlyOptions: writtenMode })')
    renderer = once(renderer, '        turn.text || (turn.kind === "vision" ? t.answer.visionWaiting : t.answer.genWaiting),', '        (writtenMode ? compactWrittenAnswer(turn.text) : turn.text) || (turn.kind === "vision" ? t.answer.visionWaiting : t.answer.genWaiting),')
    renderer = once(renderer, '          turns: current?.turns ?? [],', '          turns: current?.turns ?? [],\n          writtenMode: settings?.multimodal?.mode === "written",')
    renderer = once(renderer, '  const visionReady = settings?.multimodal?.enabled', '''  const patchWrittenWindow = reactExports.useCallback(async (patch) => {
    try {
      const next = await window.mc.setWrittenWindow(patch);
      setSettings(next);
      setWrittenError("");
      return next;
    } catch (error) { setWrittenError(error.message); return null; }
  }, []);
  const enterWrittenWindow = reactExports.useCallback(async () => {
    setContinuous(false);
    if (loopbackRef.current?.running || themInputRef.current?.running) await stopCapture();
    if (micRef.current?.running) { await micRef.current.stop(); setMicActive(false); }
    setShowSettings(false);
    await patchWrittenWindow({ enabled: true });
  }, [stopCapture, patchWrittenWindow]);
  reactExports.useLayoutEffect(() => {
    document.documentElement.dataset.writtenCompact = settings?.writtenWindow?.enabled ? "true" : "false";
  }, [settings?.writtenWindow?.enabled]);
  const visionReady = settings?.multimodal?.enabled''')
    renderer = once(renderer, '  const answersReady = health?.answersAvailable ?? true;\n  return', '''  const answersReady = health?.answersAvailable ?? true;
  if (settings?.writtenWindow?.enabled) {
    const turn = [...(current?.turns || [])].reverse().find(item => item.kind !== "translate") || null;
    return jsxRuntimeExports.jsx(WrittenCompactView, {
      preferences: settings.writtenWindow, turn, ready: visionReady, error: writtenError,
      onPatch: (patch) => void patchWrittenWindow(patch), onCapture: (mode) => void doRegionShot(mode), onCancel: cancelTurn,
      onRestore: () => void patchWrittenWindow({ enabled: false }),
      onSettings: async () => { if (await patchWrittenWindow({ enabled: false })) setShowSettings(true); }
    });
  }
  return''')
    renderer = once(renderer, '''    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "titlebar", children: [''', '''    writtenError && jsxRuntimeExports.jsx("div", { className: "settings-warn", role: "alert", children: writtenError }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "titlebar", children: [''')
    renderer = once(renderer, '        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn", onClick: () => void toggleAnswerLang(),', '''        settings?.multimodal?.mode === "written" && jsxRuntimeExports.jsx("button", {
          className: "btn", title: "打开笔试专用小窗（停止语音采集，可缩放与调整字体）",
          onClick: () => { if (showSettings) settingsCloseRef.current?.(enterWrittenWindow); else void enterWrittenWindow(); }, children: "小窗"
        }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn", onClick: () => void toggleAnswerLang(),''')
    start = renderer.index('function SettingsPanel({')
    end = renderer.index('const TONE_CLASS = {', start)
    panel = renderer[start:end]
    panel = once(panel, '  onOpenHelp\n})', '  onOpenHelp,\n  onOpenWritten\n})')
    panel = once(panel, '    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-section", children: t.settings.commonSection }),', '''    jsxRuntimeExports.jsx("button", { className: "btn", type: "button", title: "进入截图答题小窗，并停止语音采集", onClick: () => requestClose(onOpenWritten), children: "打开笔试专用小窗（窗口 / 字体可调整）" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-section", children: t.settings.commonSection }),''')
    renderer = renderer[:start] + panel + renderer[end:]
    renderer = once(renderer, '        closeRef: settingsCloseRef,', '        closeRef: settingsCloseRef,\n        onOpenWritten: () => void enterWrittenWindow(),')
    return {MAIN: main.encode('utf8'), RENDERER: renderer.encode('utf8'), PRELOAD: preload.encode('utf8')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app_dir', nargs='?', default=str(Path(os.environ['LOCALAPPDATA']) / 'Programs/meeting-copilot'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    app_dir = Path(args.app_dir).resolve()
    archive_path = app_dir / 'resources/app.asar'
    archive = archive_path.read_bytes()
    header, start = asar.read_header(archive)
    sources = [asar.read_member(archive, header, start, member).decode('utf8') for member in [MAIN, RENDERER, PRELOAD]]
    if MARKER in sources[0]:
        print('Written compact window is already installed.')
        return
    replacements = patch_sources(*sources)
    check_dir = ROOT / 'work/written-window-check'
    check_dir.mkdir(parents=True, exist_ok=True)
    for member, content in replacements.items():
        output = check_dir / ('renderer.mjs' if member == RENDERER else 'preload.cjs' if member == PRELOAD else 'main.cjs')
        output.write_bytes(content)
        subprocess.run(['node', '--check', str(output)], check=True)
    if args.check:
        print('Compatible. Main, preload and renderer syntax checks passed. No application files changed.')
        return
    asar.require_closed(app_dir)
    backup = archive_path.with_name('app.asar.before-written-window.bak')
    if backup.exists() and asar.sha256(backup.read_bytes()) != asar.sha256(archive):
        raise RuntimeError('A different compact window backup already exists')
    patched = asar.replace_members(archive, replacements)
    new_header, new_start = asar.read_header(patched)
    for member, content in replacements.items():
        if asar.read_member(patched, new_header, new_start, member) != content:
            raise RuntimeError('Patched ASAR verification failed')
    if not backup.exists():
        shutil.copy2(archive_path, backup)
    shutil.copy2(HERE / 'written-window.cjs', app_dir / 'resources/tools/written-window.cjs')
    for folder in [Path(os.environ['APPDATA']) / 'MeetingCopilot/multimodal/prompts', app_dir / 'resources/multimodal/prompts']:
        prompt = folder / 'written.md'
        saved = prompt.with_name('written.md.before-written-window.bak')
        if prompt.exists() and not saved.exists():
            shutil.copy2(prompt, saved)
        shutil.copy2(HERE / 'prompts/written.md', prompt)
    staged = archive_path.with_name('app.asar.written-window.tmp')
    if staged.exists():
        raise RuntimeError('Existing staging archive requires review')
    staged.write_bytes(patched)
    os.replace(staged, archive_path)
    print('Installed resizable written-test answer window, font controls and option-only prompt.')
    print('Backup:', backup)


if __name__ == '__main__':
    main()
