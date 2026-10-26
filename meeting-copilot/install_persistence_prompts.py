"""Make settings saving explicit and share a concise written-test prompt across models."""
import argparse
import importlib.util
import os
from pathlib import Path
import re
import json
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
MARKER = '// meeting-copilot-save-written-prompt-v1'


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Unexpected source near: ' + before[:100])
    return text.replace(before, after, 1)


def original_prompt_templates(main):
    persona = json.loads(re.search(r'const PERSONA = (\[[\s\S]*?\]);', main).group(1))
    part = main[main.index('function buildVisionMessages('):main.index('function buildAnswerMessages(')]
    vision = json.loads(re.search(r'const sys = ("(?:[^"\\]|\\.)*") \+', part).group(1))
    return {'interview.md': '\n'.join(persona) + '\n', 'original-vision.md': vision + '\n'}


def patch_sources(main, renderer, preload):
    if MARKER in main:
        raise ValueError('Save/prompt patch already installed')
    if '// meeting-copilot-shortcuts-parallel-v1' not in main:
        raise ValueError('Install the shortcut and simultaneous-answer patch first')
    main = once(main, '''    electron.ipcMain.handle("multimodal:open-prompts", async () => {''', '''    electron.ipcMain.handle("multimodal:locate-prompt", (_event, scene) => {
      const file = scene === "written" ? "written.md" : scene === "interview" ? "interview.md" : null;
      if (!file) throw new Error("未知提示词文件");
      electron.shell.showItemInFolder(path.join(multimodalRouter.promptDir, file));
      return true;
    });
    electron.ipcMain.handle("multimodal:open-prompts", async () => {''')
    main = once(main, '''        isTranslate ? messages : multimodalRouter.buildMessages({
          ...payload,''', '''        isTranslate ? messages : multimodalRouter.buildMessages({
          ...payload,
          originalMessages: messages,
          originalPersona: PERSONA.join("\\n"),''')
    main = once(main, '''multimodalRouter.buildMessages({ ...payload, imageDataUrl: dataUrl, answerLang: settings.data.llm.answerLang, background: payload.background || knowledge.text }, "shot")''', '''multimodalRouter.buildMessages({
              ...payload, imageDataUrl: dataUrl, answerLang: settings.data.llm.answerLang, background: payload.background || knowledge.text,
              originalMessages: buildVisionMessages(payload.question || "", dataUrl, payload.background || knowledge.text),
              originalPersona: buildVisionMessages("", dataUrl, "")[0].content
            }, "shot")''')
    main = MARKER + '\n' + main
    preload = once(preload, '  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),', '''  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),
  openModelPrompt: (scene) => electron.ipcRenderer.invoke("multimodal:locate-prompt", scene),''')

    start = renderer.index('function MultimodalSettings(')
    end = renderer.index('function SettingsPanel({', start)
    renderer = renderer[:start] + (HERE / 'settings-save-ui.js').read_text(encoding='utf8') + '\n' + (HERE / 'multimodal-ui.js').read_text(encoding='utf8') + '\n' + renderer[end:]
    start = renderer.index('function SettingsPanel({')
    end = renderer.index('const TONE_CLASS = {', start)
    panel = renderer[start:end]
    panel = once(panel, '  onClose,\n  onRerunWizard,', '  onClose,\n  closeRef,\n  onRerunWizard,')
    panel = once(panel, '  const anyTesting = Object.values(tests).some((s) => s?.testing);', '''  const [savedMessage, setSavedMessage] = reactExports.useState("");
  const [confirmClose, setConfirmClose] = reactExports.useState(false);
  const closeAfterSave = reactExports.useRef(false);
  const pendingCloseAction = reactExports.useRef(onClose);
  const draft = { baseUrl, model, answerLang, language, hotkey, hotkeyShot, hotkeyRegion,
    visionBaseUrl, visionModel, visionProxy, asrBackend, cloudBaseUrl, cloudModel, rtBaseUrl, rtModel, rtLocalModel,
    autoLaunch, fontScale, theme, uiLang, themDeviceId, micDeviceId, multimodal: mmConfig,
    keys: [llmKey.patchValue(), visionKey.patchValue(), cloudKey.patchValue(), rtKey.patchValue()] };
  const saveState = useSettingsSaveState(draft);
  const requestClose = (action = onClose) => {
    if (saving) return;
    pendingCloseAction.current = typeof action === "function" ? action : onClose;
    if (saveState.dirty) setConfirmClose(true);
    else pendingCloseAction.current();
  };
  reactExports.useLayoutEffect(() => {
    if (!closeRef) return;
    closeRef.current = requestClose;
    return () => { closeRef.current = null; };
  }, [closeRef, saveState.dirty, saving]);
  const anyTesting = Object.values(tests).some((s) => s?.testing);''')
    panel = once(panel, '  const requestSave = () => {', '  const requestSave = (shouldClose = false) => {\n    closeAfterSave.current = shouldClose === true;')
    panel = once(panel, '''      setMmSaveError("");
      onSaved(next);''', '''      setMmSaveError("");
      setMmConfig(next.multimodal);
      setLive(next);
      saveState.commitAll(next.multimodal);
      setSavedMessage("设置已保存（包含空白接口）");
      setConfirmClose(false);
      onSaved(next);
      if (closeAfterSave.current) pendingCloseAction.current();
      return true;''')
    panel = once(panel, '''      setMmSaveError(error.message);
    } finally {''', '''      setMmSaveError(error.message);
      return false;
    } finally {''')
    panel = once(panel, '  const providerSelect = (capability, currentBaseUrl, currentModel, onPick) => {', '''  const saveVision = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const next = await window.mc.setSettings({ multimodal: mmConfig });
      setMmConfig(next.multimodal);
      setLive(next);
      saveState.commitVision(next.multimodal);
      setMmSaveError("");
      setSavedMessage("视觉设置已保存（包含空白接口）");
      onSaved(next);
    } catch (error) { setMmSaveError(error.message); }
    finally { setSaving(false); }
  };
  const providerSelect = (capability, currentBaseUrl, currentModel, onPick) => {''')
    panel = once(panel, 'return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings", children: [', '''return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings", children: [
    jsxRuntimeExports.jsx(SettingsSaveBar, {
      dirty: saveState.dirty, saving, message: savedMessage, error: mmSaveError, confirmClose,
      onSave: () => requestSave(false), onClose: () => requestClose(),
      onSaveClose: () => requestSave(true),
      onDiscard: () => { setConfirmClose(false); pendingCloseAction.current(); },
      onContinue: () => setConfirmClose(false)
    }),''')
    panel = once(panel, 'jsxRuntimeExports.jsx(MultimodalSettings, { value: mmConfig, onChange: setMmConfig, providerSelect })', 'jsxRuntimeExports.jsx(MultimodalSettings, { value: mmConfig, onChange: setMmConfig, providerSelect, onSave: saveVision, saving })')
    panel = once(panel, 'onClick: onClose, children: t.settings.cancel', 'onClick: () => requestClose(), children: "关闭"')
    for name in ['onRerunWizard', 'onOpenDiagnostics', 'onOpenHelp']:
        panel = once(panel, 'onClick: ' + name + ',', 'onClick: () => requestClose(' + name + '),')
    renderer = renderer[:start] + panel + renderer[end:]
    renderer = once(renderer, '  const [showSettings, setShowSettings] = reactExports.useState(false);', '  const [showSettings, setShowSettings] = reactExports.useState(false);\n  const settingsCloseRef = reactExports.useRef(null);')
    renderer = once(renderer, 'onClick: () => setShowSettings((v) => !v), title: t.titlebar.settingsTitle', 'onClick: () => { if (showSettings) settingsCloseRef.current?.(); else setShowSettings(true); }, title: t.titlebar.settingsTitle')
    renderer = once(renderer, 'onClick: () => window.mc.quit(), title: t.titlebar.quitTitle', 'onClick: () => { if (settingsCloseRef.current) settingsCloseRef.current(() => window.mc.quit()); else window.mc.quit(); }, title: t.titlebar.quitTitle')
    renderer = once(renderer, '''  const closePanels = reactExports.useCallback(() => {
    setShowSettings(false);
    setShowHealth(false);
    setShowDiagnostics(false);
    setShowHelp(false);
  }, []);''', '''  const closePanels = reactExports.useCallback((next) => {
    const finish = () => {
      setShowSettings(false);
      setShowHealth(false);
      setShowDiagnostics(false);
      setShowHelp(false);
      next?.();
    };
    if (settingsCloseRef.current) settingsCloseRef.current(finish);
    else finish();
  }, []);''')
    renderer = once(renderer, '''        case "open-settings":
          closePanels();
          setShowSettings(true);''', '''        case "open-settings":
          if (!settingsCloseRef.current) closePanels(() => setShowSettings(true));''')
    renderer = once(renderer, '''        case "open-health":
          closePanels();
          setShowHealth(true);''', '''        case "open-health":
          closePanels(() => setShowHealth(true));''')
    renderer = once(renderer, '''        case "open-help":
          closePanels();
          setShowHelp(true);''', '''        case "open-help":
          closePanels(() => setShowHelp(true));''')
    renderer = once(renderer, '''        settings,
        onSaved: (s) => {
          setSettings(s);
          answerLangRef.current = s.llm.answerLang;
          setShowSettings(false);
        },''', '''        settings,
        closeRef: settingsCloseRef,
        onSaved: (s) => {
          setSettings(s);
          answerLangRef.current = s.llm.answerLang;
        },''')
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
    sources = [asar.read_member(archive, header, start, file).decode('utf8') for file in [MAIN, RENDERER, PRELOAD]]
    if MARKER in sources[0]:
        print('Settings save controls and concise written prompts are already installed.')
        return
    replacements = patch_sources(*sources)
    check_dir = ROOT / 'work/persistence-prompt-check'
    check_dir.mkdir(parents=True, exist_ok=True)
    for file, content in replacements.items():
        output = check_dir / ('renderer.mjs' if file == RENDERER else 'preload.cjs' if file == PRELOAD else 'main.cjs')
        output.write_bytes(content)
        subprocess.run(['node', '--check', str(output)], check=True)
    if args.check:
        print('Compatible. Main, preload and renderer syntax checks passed. No application files changed.')
        return
    asar.require_closed(app_dir)
    backup = target.with_name('app.asar.before-save-prompts.bak')
    if backup.exists() and asar.sha256(backup.read_bytes()) != asar.sha256(archive):
        raise RuntimeError('A different backup already exists')
    patched = asar.replace_members(archive, replacements)
    new_header, new_start = asar.read_header(patched)
    for file, content in replacements.items():
        if asar.read_member(patched, new_header, new_start, file) != content:
            raise RuntimeError('ASAR verification failed')
    if not backup.exists():
        shutil.copy2(target, backup)
    router = app_dir / 'resources/multimodal/multimodal-router.cjs'
    router_backup = router.with_name(router.name + '.before-save-prompts.bak')
    if not router_backup.exists():
        shutil.copy2(router, router_backup)
    shutil.copy2(HERE / 'multimodal-router.cjs', router)
    # Update only the user-requested scene files, retaining each previous version.
    prompt_text = original_prompt_templates(sources[0])
    prompt_text['written.md'] = (HERE / 'prompts/written.md').read_text(encoding='utf8')
    active = Path(os.environ['APPDATA']) / 'MeetingCopilot/multimodal/prompts'
    defaults = app_dir / 'resources/multimodal/prompts'
    for folder in [active, defaults]:
        folder.mkdir(parents=True, exist_ok=True)
        for name, text in prompt_text.items():
            file = folder / name
            old = file.with_name(name + '.before-save-prompts.bak')
            if file.exists() and not old.exists():
                shutil.copy2(file, old)
            file.write_text(text, encoding='utf8')
    staged = target.with_name('app.asar.save-prompts.tmp')
    if staged.exists():
        raise RuntimeError('Existing staging archive requires review')
    staged.write_bytes(patched)
    os.replace(staged, target)
    print('Installed explicit save controls, unsaved-change guard and concise written prompt.')
    print('Active prompt folder:', active)
    print('Backup:', backup)


if __name__ == '__main__':
    main()
