"""Add native thin-edge region selection alongside silent full-screen capture."""
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
MARKER = '// meeting-copilot-thin-region-v1'


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Unexpected application code near: ' + before[:90])
    return text.replace(before, after, 1)


def patch_sources(main, renderer, preload):
    if MARKER in main:
        raise ValueError('Region capture patch is already installed')
    if '// meeting-copilot-multimodal-v2' not in main:
        raise ValueError('Install the current vision settings patch first')
    first = main.index('async function captureQuietScreenshot() {')
    last = main.index('electron.app.setName("MeetingCopilot");', first)
    main = main[:first] + '''const captureModule = require(path.join(process.resourcesPath, "tools", "quiet-capture.cjs"));
const quietCaptureService = captureModule.createCaptureService({ helperPath: path.join(process.resourcesPath, "tools", "QuietCapture.exe") });
const captureQuietScreenshot = (mode = "full") => quietCaptureService.capture(mode);
''' + main[last:]
    main = once(main, '  let multimodalRouter;', '  let multimodalRouter;\n  let captureSettings;')
    main = once(main, '    pub.multimodal = multimodalRouter?.getPublic();', '    pub.multimodal = multimodalRouter?.getPublic();\n    pub.capture = captureSettings?.getPublic();')
    main = once(main, '    multimodalRouter.initialize({ ...settings.data.vision, apiKey: settings.getVisionApiKey() });', '''    multimodalRouter.initialize({ ...settings.data.vision, apiKey: settings.getVisionApiKey() });
    captureSettings = captureModule.createCaptureSettings({ file: path.join(electron.app.getPath("userData"), "capture.json"), shortcuts: electron.globalShortcut });''')
    main = once(main, '    const shot = settings.data.ui.hotkeyShot;\n    try {', '''    const shot = settings.data.ui.hotkeyShot;
    let region = captureSettings.getPublic().hotkeyRegion;
    captureSettings.setRegistrationError("");
    try {''')
    main = once(main, 'electron.globalShortcut.register(shot, () => win?.webContents.send(IPC.shotHotkey))', 'electron.globalShortcut.register(shot, () => win?.webContents.send(IPC.shotHotkey, "full"))')
    main = once(main, '''    stopMouseShot();
    if (/^Mouse[45]$/.test(shot || "")) startMouseShot(shot);''', '''    try {
      if (region && (captureModule.normalizeShortcut(region) === captureModule.normalizeShortcut(shot) || captureModule.normalizeShortcut(region) === captureModule.normalizeShortcut(toggle))) throw new Error("框选键与其他快捷键重复，请在设置中修改");
      if (region && !/^Mouse[45]$/.test(region)) {
        if (!electron.globalShortcut.register(region, () => win?.webContents.send(IPC.shotHotkey, "region"))) throw new Error("框选快捷键被占用，请在设置中更换组合键");
      }
    } catch (error) { captureSettings.setRegistrationError(error.message); region = ""; }
    stopMouseShot();
    const mouseButtons = [...new Set([shot, region].filter(key => /^Mouse[45]$/.test(key || "")))];
    if (mouseButtons.length) startMouseShot(mouseButtons.join(","));''')
    main = once(main, '      socket.on("data", () => win?.webContents.send(IPC.shotHotkey));', '''      socket.on("data", (bytes) => {
        const captureState = captureSettings.getPublic();
        const regionKey = captureState.registrationError ? "" : captureState.hotkeyRegion;
        for (const value of bytes) {
          const key = value === 5 ? "Mouse4" : value === 6 ? "Mouse5" : "";
          if (key && button.split(",").includes(key)) win?.webContents.send(IPC.shotHotkey, key === regionKey ? "region" : "full");
        }
      });''')
    main = once(main, '''    electron.ipcMain.handle(IPC.settingsSet, (_e, patch) => {
      if (patch.multimodal)''', '''    electron.ipcMain.handle(IPC.settingsSet, (_e, patch) => {
      const captureChanged = patch.capture || patch.ui?.hotkeyToggle !== void 0 || patch.ui?.hotkeyShot !== void 0;
      if (captureChanged) captureSettings.validate(patch.capture || {}, { ...settings.data.ui, ...patch.ui });
      if (patch.multimodal)''')
    main = once(main, '''      settings.applyPatch(patch);
      if (patch.ui?.hotkeyToggle !== void 0 || patch.ui?.hotkeyShot !== void 0) {''', '''      settings.applyPatch(patch);
      if (patch.capture) captureSettings.applyPatch(patch.capture, settings.data.ui);
      if (captureChanged) {''')
    main = once(main, '    electron.ipcMain.handle(IPC.regionPick, () => captureQuietScreenshot());', '    electron.ipcMain.handle(IPC.regionPick, (_e, mode) => captureQuietScreenshot(mode === "region" ? "region" : "full"));')
    main = once(main, '  electron.app.on("before-quit", () => {', '  electron.app.on("before-quit", () => {\n    quietCaptureService.cancel();')
    main = once(main, 'const imgP = payload.imageDataUrl ? Promise.resolve(payload.imageDataUrl) : captureQuietScreenshot();', '''const imgP = (payload.imageDataUrl ? Promise.resolve(payload.imageDataUrl) : captureQuietScreenshot()).then((dataUrl) => {
          if (!dataUrl) throw Object.assign(new Error("已取消截图"), { captureCancelled: true });
          return dataUrl;
        });''')
    main = once(main, '          console.error("[vision] request failed:", e.message);', '''          if (e.captureCancelled) { sendEv({ requestId: payload.requestId, kind: "done", text: "已取消截图" }); return; }
          console.error("[vision] request failed:", e.message);''')
    main = MARKER + '\n' + main

    preload = once(preload, '  pickRegion: () => electron.ipcRenderer.invoke(IPC.regionPick),', '  pickRegion: (mode = "full") => electron.ipcRenderer.invoke(IPC.regionPick, mode === "region" ? "region" : "full"),')
    preload = once(preload, '''  onShotHotkey: (cb) => {
    const listener = () => cb();''', '''  onShotHotkey: (cb) => {
    const listener = (_e, mode) => cb(mode === "region" ? "region" : "full");''')

    renderer = once(renderer, '  const [hotkeyShot, setHotkeyShot] = reactExports.useState(settings.ui.hotkeyShot);', '''  const [hotkeyShot, setHotkeyShot] = reactExports.useState(settings.ui.hotkeyShot);
  const [hotkeyRegion, setHotkeyRegion] = reactExports.useState(settings.capture?.hotkeyRegion ?? "Control+Shift+A");''')
    renderer = once(renderer, '        multimodal: mmConfig,', '        capture: { hotkeyRegion: hotkeyRegion.trim() },\n        multimodal: mmConfig,')
    start = renderer.index('    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-row", children: [\n      /* @__PURE__ */ jsxRuntimeExports.jsx("label", { children: t.settings.hotkeyShot })')
    end = renderer.index('    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-row", children: [\n      /* @__PURE__ */ jsxRuntimeExports.jsx("label", { children: t.settings.autoLaunch })', start)
    region_field = renderer[start:end].replace('t.settings.hotkeyShot', '"框选截图键（组合键或 Mouse4 / Mouse5）"').replace('setHotkeyShot', 'setHotkeyRegion').replace('hotkeyShot', 'hotkeyRegion')
    renderer = renderer[:end] + region_field + '''    jsxRuntimeExports.jsx("button", { className: "btn btn-sm", onClick: () => setHotkeyRegion(""), children: "清除框选快捷键" }),
    jsxRuntimeExports.jsx("div", { className: "settings-hint", children: "框选只显示细边框和小提示，不铺全屏蒙层。左键拖动选择，Esc / 右键取消；全屏截图键仍然直接静默截全屏。" }),
    (mmSaveError || settings.capture?.registrationError) && jsxRuntimeExports.jsx("div", { className: "settings-warn", children: mmSaveError || settings.capture.registrationError }),
''' + renderer[end:]
    renderer = once(renderer, 'hotkeyShot: "截图键（键盘组合或鼠标侧键 Mouse4 / Mouse5）"', 'hotkeyShot: "静默全屏截图键（组合键或 Mouse4 / Mouse5）"')
    renderer = once(renderer, 'hotkeyShot: "Screenshot shortcut (key combination or mouse side button Mouse4 / Mouse5)"', 'hotkeyShot: "Silent full-screen shortcut (combination or Mouse4 / Mouse5)"')
    renderer = once(renderer, '  const [nameDraft, setNameDraft] = reactExports.useState("");', '''  const [nameDraft, setNameDraft] = reactExports.useState("");
  const [captureError, setCaptureError] = reactExports.useState("");
  const captureAndAsk = async (mode) => {
    setCaptureError("");
    try {
      const q = inputRef.current?.value.trim() ?? "";
      const img = await window.mc.pickRegion(mode);
      if (!img) return;
      if (inputRef.current) inputRef.current.value = "";
      onShotAsk(q, img);
    } catch (error) { setCaptureError(error.message); }
  };''')
    renderer = once(renderer, 'return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "pane pane-answer", children: [', '''return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "pane pane-answer", children: [
    captureError && jsxRuntimeExports.jsx("div", { className: "settings-warn", role: "alert", children: captureError }),''')
    renderer = once(renderer, '''          title: t.answer.shotTitle,
          onClick: async () => {
            const q = inputRef.current?.value.trim() ?? "";
            const img = await window.mc.pickRegion();
            if (!img) return;
            if (inputRef.current) inputRef.current.value = "";
            onShotAsk(q, img);
          },
          children: "📷"
        }
      )''', '''          title: "静默全屏截图问答",
          onClick: () => void captureAndAsk("full"),
          children: "📷"
        }
      ),
      visionReady && jsxRuntimeExports.jsx("button", {
        className: "btn", title: "框选截图问答（无全屏蒙层，Esc / 右键取消）",
        onClick: () => void captureAndAsk("region"), children: "框选"
      })''')
    renderer = once(renderer, '''  const doRegionShot = reactExports.useCallback(async () => {
    const img = await window.mc.pickRegion();
    if (img) askShot("", img);
  }, [askShot]);''', '''  const doRegionShot = reactExports.useCallback(async (mode = "full") => {
    try {
      const img = await window.mc.pickRegion(mode);
      if (img) askShot("", img);
    } catch (error) {
      const sid = currentIdRef.current;
      if (sid) appendTurn(sid, { id: uid("shot-error"), kind: "vision", label: mode === "region" ? "框选截图" : "全屏截图", text: "", status: "error", error: error.message });
    }
  }, [askShot, appendTurn]);''')
    renderer = once(renderer, '    const offShot = window.mc.onShotHotkey(() => void doRegionShot());', '    const offShot = window.mc.onShotHotkey((mode) => void doRegionShot(mode));')
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
    sources = [asar.read_member(archive, header, start, name).decode('utf8') for name in [MAIN, RENDERER, PRELOAD]]
    if MARKER in sources[0]:
        print('Native region capture is already installed.')
        return
    replacements = patch_sources(*sources)
    directory = ROOT / 'work/region-capture-check'
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in replacements.items():
        file = directory / ('renderer.mjs' if name == RENDERER else 'preload.cjs' if name == PRELOAD else 'main.cjs')
        file.write_bytes(content)
        subprocess.run(['node', '--check', str(file)], check=True)
    if args.check:
        print('Compatible. Main, preload and renderer syntax checks passed. No application files changed.')
        return
    asar.require_closed(app_dir)
    backup = target.with_name('app.asar.before-region-capture.bak')
    if backup.exists() and asar.sha256(backup.read_bytes()) != asar.sha256(archive):
        raise RuntimeError('A different region capture backup already exists')
    patched = asar.replace_members(archive, replacements)
    new_header, new_start = asar.read_header(patched)
    for name, content in replacements.items():
        if asar.read_member(patched, new_header, new_start, name) != content:
            raise RuntimeError('ASAR member verification failed')
    if not backup.exists():
        shutil.copy2(target, backup)
    helper = app_dir / 'resources/tools/QuietCapture.exe'
    helper_backup = helper.with_name('QuietCapture.exe.before-region.bak')
    if not helper_backup.exists():
        shutil.copy2(helper, helper_backup)
    shutil.copy2(ROOT / 'bin/QuietCapture.exe', helper)
    shutil.copy2(HERE / 'quiet-capture.cjs', helper.with_name('quiet-capture.cjs'))
    staged = target.with_name('app.asar.region-capture.tmp')
    if staged.exists():
        raise RuntimeError('Existing staging archive requires review')
    staged.write_bytes(patched)
    os.replace(staged, target)
    print('Installed silent full-screen + native thin-edge region capture.')
    print('Default region shortcut: Control+Shift+A; existing full-screen shortcut preserved.')
    print('Backup:', backup)


if __name__ == '__main__':
    main()
