"""Fix keyboard/side-button recording and add optional simultaneous model answers."""
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
MARKER = '// meeting-copilot-shortcuts-parallel-v1'


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Unexpected source near: ' + before[:90])
    return text.replace(before, after, 1)


def patch_sources(main, renderer, preload):
    if MARKER in main:
        raise ValueError('Shortcut/parallel patch already installed')
    if '// meeting-copilot-thin-region-v1' not in main:
        raise ValueError('Install the region capture patch first')
    main = once(main, '  let captureSettings;', '  let captureSettings;\n  let shortcutRuntime;')
    start = main.index('  function registerHotkeys() {')
    end = main.index('  function createWindow() {', start)
    main = main[:start] + '''  function registerHotkeys() { shortcutRuntime?.register(); }
  function stopMouseShot() { shortcutRuntime?.dispose(); }
''' + main[end:]
    main = once(main, '    captureSettings = captureModule.createCaptureSettings({ file: path.join(electron.app.getPath("userData"), "capture.json"), shortcuts: electron.globalShortcut });', '''    captureSettings = captureModule.createCaptureSettings({ file: path.join(electron.app.getPath("userData"), "capture.json"), shortcuts: electron.globalShortcut });
    const { createShortcutRuntime } = require(path.join(process.resourcesPath, "tools", "shortcut-runtime.cjs"));
    shortcutRuntime = createShortcutRuntime({
      shortcuts: electron.globalShortcut,
      helperPath: path.join(process.resourcesPath, "tools", "QuietCapture.exe"),
      getBindings: () => ({ toggle: settings.data.ui.hotkeyToggle, full: settings.data.ui.hotkeyShot, region: captureSettings.getPublic().hotkeyRegion }),
      onToggle: () => toggleWindow(),
      onCapture: (mode) => win?.webContents.send(IPC.shotHotkey, mode),
      onRecord: (event) => win?.webContents.send("shortcut:recorded", event),
      onError: (message) => captureSettings.setRegistrationError(message)
    });
    electron.ipcMain.handle("shortcut:begin", (event, token) => {
      if (!win || event.sender !== win.webContents) throw new Error("仅主窗口可录制快捷键");
      return shortcutRuntime.begin(token);
    });
    electron.ipcMain.handle("shortcut:end", (event, token) => {
      if (!win || event.sender !== win.webContents) return false;
      return shortcutRuntime.end(token);
    });''')
    main = once(main, '    win.on("show", () => {', '    win.on("blur", () => shortcutRuntime?.end());\n    win.on("show", () => {')
    main = once(main, '''      const captureChanged = patch.capture || patch.ui?.hotkeyToggle !== void 0 || patch.ui?.hotkeyShot !== void 0;
      if (captureChanged) captureSettings.validate''', '''      const captureChanged = patch.capture || patch.ui?.hotkeyToggle !== void 0 || patch.ui?.hotkeyShot !== void 0;
      if (captureChanged) shortcutRuntime?.end();
      if (captureChanged) captureSettings.validate''')
    main = once(main, '  const unifiedProgress = (sendEv, requestId) => (message) => sendEv({ requestId, kind: "status", message });', '''  const unifiedProgress = (sendEv, requestId) => (message) => sendEv({ requestId, kind: "status", message });
  const unifiedResults = (sendEv, requestId) => ({ answerMode: true, onResult: (result) => sendEv({ requestId, kind: "model", result }) });''')
    main = once(main, '''        }), ac.signal, unifiedProgress(sendEv, payload.requestId)
      )).then''', '''        }), ac.signal, unifiedProgress(sendEv, payload.requestId), unifiedResults(sendEv, payload.requestId)
      )).then''')
    main = once(main, '''            ac.signal, unifiedProgress(sendEv, payload.requestId)
          ) : visionChat''', '''            ac.signal, unifiedProgress(sendEv, payload.requestId), unifiedResults(sendEv, payload.requestId)
          ) : visionChat''')
    main = MARKER + '\n' + main

    preload = once(preload, '  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),', '''  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),
  beginShortcutRecording: (token) => electron.ipcRenderer.invoke("shortcut:begin", token),
  endShortcutRecording: (token) => electron.ipcRenderer.invoke("shortcut:end", token),
  onShortcutRecorded: (callback) => {
    const listener = (_e, event) => callback(event);
    electron.ipcRenderer.on("shortcut:recorded", listener);
    return () => electron.ipcRenderer.removeListener("shortcut:recorded", listener);
  },''')

    start = renderer.index('function MultimodalSettings(')
    end = renderer.index('function SettingsPanel({', start)
    renderer = renderer[:start] + (HERE / 'shortcut-recorder-ui.js').read_text(encoding='utf8') + '\n' + (HERE / 'multimodal-ui.js').read_text(encoding='utf8') + '\n' + renderer[end:]
    start = renderer.index('    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-row", children: [\n      /* @__PURE__ */ jsxRuntimeExports.jsx("label", { children: t.settings.hotkeyShot })')
    end = renderer.index('    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-row", children: [\n      /* @__PURE__ */ jsxRuntimeExports.jsx("label", { children: t.settings.autoLaunch })', start)
    renderer = renderer[:start] + '''    jsxRuntimeExports.jsx(ShortcutRecorder, { label: "静默全屏截图快捷键", value: hotkeyShot, onChange: setHotkeyShot }),
    jsxRuntimeExports.jsx(ShortcutRecorder, { label: "框选截图快捷键", value: hotkeyRegion, onChange: setHotkeyRegion }),
    jsxRuntimeExports.jsx("div", { className: "settings-hint", children: "点击录制后可在组合键和侧键之间切换，也可手动填写。绑定的侧键会拦截网页前进/后退；未绑定侧键保持正常。修改后点击保存。" }),
    (mmSaveError || settings.capture?.registrationError) && jsxRuntimeExports.jsx("div", { className: "settings-warn", children: mmSaveError || settings.capture.registrationError }),
''' + renderer[end:]
    renderer = once(renderer, '            if (ev.kind === "status") return', '            if (ev.kind === "model") return mergeModelAnswer(t2, ev.result);\n            if (ev.kind === "status") return')
    renderer = once(renderer, 'children: turn.status === "error" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "answer-error", children: turn.error })', 'children: turn.modelResults?.length ? jsxRuntimeExports.jsx(ModelAnswers, { results: turn.modelResults }) : turn.status === "error" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "answer-error", children: turn.error })')
    renderer = once(renderer, 'turns: s.turns.map((t2) => t2.id === id ? { ...t2, status: "done" } : t2)', 'turns: s.turns.map((t2) => t2.id === id ? { ...t2, status: "done", modelResults: t2.modelResults?.map(result => result.status === "pending" ? { ...result, status: "cancelled", error: "已停止" } : result) } : t2)')
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
    sources = [asar.read_member(archive, header, start, path).decode('utf8') for path in [MAIN, RENDERER, PRELOAD]]
    if MARKER in sources[0]:
        print('Shortcut recording and simultaneous answers already installed.')
        return
    replacements = patch_sources(*sources)
    check_dir = ROOT / 'work/shortcuts-parallel-check'
    check_dir.mkdir(parents=True, exist_ok=True)
    for path, content in replacements.items():
        file = check_dir / ('renderer.mjs' if path == RENDERER else 'preload.cjs' if path == PRELOAD else 'main.cjs')
        file.write_bytes(content)
        subprocess.run(['node', '--check', str(file)], check=True)
    if args.check:
        print('Compatible. Main, preload and renderer syntax checks passed. No application files changed.')
        return
    asar.require_closed(app_dir)
    backup = target.with_name('app.asar.before-shortcuts-parallel.bak')
    if backup.exists() and asar.sha256(backup.read_bytes()) != asar.sha256(archive):
        raise RuntimeError('A different backup already exists')
    patched = asar.replace_members(archive, replacements)
    new_header, new_start = asar.read_header(patched)
    for path, content in replacements.items():
        if asar.read_member(patched, new_header, new_start, path) != content:
            raise RuntimeError('Patched ASAR validation failed')
    if not backup.exists():
        shutil.copy2(target, backup)
    tools_dir = app_dir / 'resources/tools'
    multimodal_dir = app_dir / 'resources/multimodal'
    files = {
        tools_dir / 'QuietCapture.exe': ROOT / 'bin/QuietCapture.exe',
        tools_dir / 'quiet-capture.cjs': HERE / 'quiet-capture.cjs',
        tools_dir / 'shortcut-runtime.cjs': HERE / 'shortcut-runtime.cjs',
        multimodal_dir / 'multimodal-router.cjs': HERE / 'multimodal-router.cjs'
    }
    for destination, source in files.items():
        saved = destination.with_name(destination.name + '.before-shortcuts-parallel.bak')
        if destination.exists() and not saved.exists():
            shutil.copy2(destination, saved)
        shutil.copy2(source, destination)
    staged = target.with_name('app.asar.shortcuts-parallel.tmp')
    if staged.exists():
        raise RuntimeError('Existing staging archive requires review')
    staged.write_bytes(patched)
    os.replace(staged, target)
    print('Installed keyboard/side-button recorder, side-button suppression and optional simultaneous answers.')
    print('Backup:', backup)


if __name__ == '__main__':
    main()
