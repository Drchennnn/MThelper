"""Add concise text/code answers, passive window display and an interview prompt editor."""
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
MARKER = '// meeting-copilot-rich-answers-prompt-v1'


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Unexpected source near: ' + before[:100])
    return text.replace(before, after, 1)


def patch_sources(main, renderer, preload):
    if MARKER in main:
        raise ValueError('Rich answer/prompt patch already installed')
    if '// meeting-copilot-written-window-v1' not in main:
        raise ValueError('Install the written compact window patch first')
    main = once(main, 'const PERSONA = [', 'let interviewPromptStore;\nconst PERSONA = [')
    main = once(main, '  const parts = [...PERSONA];', '  const parts = (interviewPromptStore ? interviewPromptStore.read() : PERSONA.join("\\n")).split("\\n");')
    main = once(main, '    const msgs2 = [];', '    const msgs2 = [{ role: "system", content: interviewPromptStore ? interviewPromptStore.read() : PERSONA.join("\\n") }];')
    main = once(main, '    pub.writtenWindow = writtenWindow?.getPublic();', '    pub.writtenWindow = writtenWindow?.getPublic();\n    pub.modelPrompts = interviewPromptStore?.getPublic();')
    main = once(main, '    multimodalRouter.initialize({ ...settings.data.vision, apiKey: settings.getVisionApiKey() });', '''    multimodalRouter.initialize({ ...settings.data.vision, apiKey: settings.getVisionApiKey() });
    const { createInterviewPrompt } = require(path.join(process.resourcesPath, "tools", "interview-prompt.cjs"));
    interviewPromptStore = createInterviewPrompt({ file: path.join(multimodalRouter.promptDir, "interview.md"), original: PERSONA.join("\\n") });''')
    main = once(main, '      file: path.join(electron.app.getPath("userData"), "written-window.json"), screen: electron.screen,', '''      file: path.join(electron.app.getPath("userData"), "written-window.json"), screen: electron.screen,
      onChange: (preferences) => win?.webContents.send("written-window:state", preferences),''')
    main = once(main, '  function showWindow() {\n    if (!win) return;', '  function showWindow() {\n    if (!win) return;\n    writtenWindow?.unlock();')
    main = once(main, '    if (win.isVisible()) win.hide();\n    else showWindow();', '    if (win.isVisible()) win.hide();\n    else writtenWindow.showInactive();')
    main = once(main, '    if (isRendererCommand(command)) {\n      showWindow();', '''    if (isRendererCommand(command)) {
      if (["open-settings", "open-health", "open-help"].includes(command) && writtenWindow.getPublic().enabled) writtenWindow.applyPatch({ enabled: false });
      showWindow();''')
    main = once(main, '    electron.ipcMain.handle(IPC.settingsSet, (_e, patch) => {', '''    electron.ipcMain.handle(IPC.settingsSet, (_e, patch) => {
      if (patch.modelPrompts) interviewPromptStore.validate(patch.modelPrompts.interview);''')
    main = once(main, '      if (patch.multimodal) multimodalRouter.applyPatch(patch.multimodal);\n      settings.applyPatch(patch);', '''      if (patch.multimodal) multimodalRouter.applyPatch(patch.multimodal);
      settings.applyPatch(patch);
      if (patch.modelPrompts) { interviewPromptStore.save(patch.modelPrompts.interview); lastPrefix = null; }''')
    main = once(main, '          originalPersona: PERSONA.join("\\n"),', '          originalPersona: interviewPromptStore.read(),')
    main = MARKER + '\n' + main
    preload = once(preload, '  setWrittenWindow: (patch) => electron.ipcRenderer.invoke("written-window:set", patch),', '''  setWrittenWindow: (patch) => electron.ipcRenderer.invoke("written-window:set", patch),
  onWrittenWindowState: (callback) => {
    const listener = (_event, preferences) => callback(preferences);
    electron.ipcRenderer.on("written-window:state", listener);
    return () => electron.ipcRenderer.removeListener("written-window:state", listener);
  },''')

    start = renderer.index('function compactWrittenAnswer(')
    end = renderer.index('function App() {', start)
    renderer = renderer[:start] + (HERE / 'written-window-ui.js').read_text(encoding='utf8') + '\n' + renderer[end:]
    start = renderer.index('function ModelAnswers(')
    end = renderer.index('function replaceSavedVisionDraft(', start)
    helpers = (HERE / 'shortcut-recorder-ui.js').read_text(encoding='utf8')
    renderer = renderer[:start] + helpers[helpers.index('function ModelAnswers('):] + '\n' + renderer[end:]
    renderer = once(renderer, 'function SettingsPanel({', (HERE / 'interview-prompt-ui.js').read_text(encoding='utf8') + '\nfunction SettingsPanel({')
    renderer = once(renderer, '  const [baseUrl, setBaseUrl] = reactExports.useState(settings.llm.baseUrl);', '''  const [interviewPrompt, setInterviewPrompt] = reactExports.useState(settings.modelPrompts?.interview || "");
  const [baseUrl, setBaseUrl] = reactExports.useState(settings.llm.baseUrl);''')
    renderer = once(renderer, '  const draft = { baseUrl, model, answerLang, language, hotkey, hotkeyShot, hotkeyRegion,', '  const draft = { interviewPrompt, baseUrl, model, answerLang, language, hotkey, hotkeyShot, hotkeyRegion,')
    renderer = once(renderer, '      const next = await window.mc.setSettings({\n        capture:', '      const next = await window.mc.setSettings({\n        modelPrompts: { interview: interviewPrompt },\n        capture:')
    renderer = once(renderer, '    keyRow(t.settings.apiKey, llmKey, "llm", llmTarget()),', '''    keyRow(t.settings.apiKey, llmKey, "llm", llmTarget()),
    jsxRuntimeExports.jsx(InterviewPromptSettings, { value: interviewPrompt, defaultValue: settings.modelPrompts?.interviewDefault || "", warning: settings.modelPrompts?.warning, onChange: setInterviewPrompt }),''')
    renderer = once(renderer, '  const [writtenError, setWrittenError] = reactExports.useState("");', '''  const [writtenError, setWrittenError] = reactExports.useState("");
  reactExports.useEffect(() => window.mc.onWrittenWindowState(preferences => {
    setSettings(previous => previous ? { ...previous, writtenWindow: preferences } : previous);
  }), []);''')
    renderer = once(renderer, '(writtenMode ? compactWrittenAnswer(turn.text) : turn.text) || (turn.kind === "vision" ? t.answer.visionWaiting : t.answer.genWaiting),', '(writtenMode && turn.text ? jsxRuntimeExports.jsx(WrittenAnswerContent, { value: turn.text }) : turn.text) || (turn.kind === "vision" ? t.answer.visionWaiting : t.answer.genWaiting),')
    renderer = once(renderer, 'children: "打开笔试专用小窗（窗口 / 字体可调整）"', 'children: "打开笔试专用小窗（文字 / 代码 / 字体可调整）"')
    renderer = once(renderer, 'jsxRuntimeExports.jsx("div", { className: "settings-hint", children: "点击录制后可在组合键和侧键之间切换，也可手动填写。绑定的侧键会拦截网页前进/后退；未绑定侧键保持正常。修改后点击保存。" })', 'jsxRuntimeExports.jsx("div", { className: "settings-hint", children: "呼出键只显示窗口，不主动切换焦点。点击普通窗口仍会转移焦点；笔试小窗可在 ⋯ 中开启只读穿透，从托盘“设置”恢复操作。快捷键可录制组合键或侧键，修改后保存。" })')
    return {MAIN: main.encode('utf8'), RENDERER: renderer.encode('utf8'), PRELOAD: preload.encode('utf8')}


def update_prompt(app_dir):
    target = Path(os.environ['APPDATA']) / 'MeetingCopilot/multimodal/prompts/written.md'
    current = target.read_text(encoding='utf8') if target.exists() else ''
    standard = ('你是笔试作答助手。直接回答当前题目，不寒暄、不复述题干、不写无关说明。\n'
                '单道选择题：只输出正确选项字母，例如“B”；多选只输出字母组合，例如“AC”。不要题号、前缀、选项内容或解释。\n'
                '截图有多道选择题时，按出现顺序每行只输出一题的选项字母，仍然不要题号。\n'
                '填空题、判断题、简单计算题及其他简单题：仅输出最终答案，不展示推导。\n'
                '简答题：直接给出必要的答题要点，尽量简短，不展开分析。\n'
                '编程题：直接给出符合题目要求的代码；只有明确要求时才补充思路或复杂度。\n'
                '只有用户明确要求解析时，才给出最简必要解释。看不清题目、缺少条件或无法确定时，简短说明缺失信息，不编造答案。')
    if not current or current.strip() == standard:
        backup = target.with_name('written.md.before-rich-answers.bak')
        if target.exists() and not backup.exists():
            shutil.copy2(target, backup)
        shutil.copy2(HERE / 'prompts/written.md', target)
    else:
        print('Preserved customized written.md; apply the concise code rules manually if desired.')
    shutil.copy2(HERE / 'prompts/written.md', app_dir / 'resources/multimodal/prompts/written.md')


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
        print('Rich answer/prompt patch is already installed.'); return
    replacements = patch_sources(*sources)
    check_dir = ROOT / 'work/rich-answers-check'
    check_dir.mkdir(parents=True, exist_ok=True)
    for member, content in replacements.items():
        output = check_dir / ('renderer.mjs' if member == RENDERER else 'preload.cjs' if member == PRELOAD else 'main.cjs')
        output.write_bytes(content)
        subprocess.run(['node', '--check', str(output)], check=True)
    for name in ['written-window.cjs', 'interview-prompt.cjs']:
        subprocess.run(['node', '--check', str(HERE / name)], check=True)
    if args.check:
        print('Compatible. Main/preload/renderer/module syntax checked; application unchanged.'); return
    asar.require_closed(app_dir)
    backup = archive_path.with_name('app.asar.before-rich-answers-prompt.bak')
    if backup.exists() and backup.read_bytes() != archive:
        raise RuntimeError('A different rich-answer backup already exists')
    patched = asar.replace_members(archive, replacements)
    new_header, new_start = asar.read_header(patched)
    for member, content in replacements.items():
        if asar.read_member(patched, new_header, new_start, member) != content:
            raise RuntimeError('ASAR verification failed')
    if not backup.exists(): shutil.copy2(archive_path, backup)
    for name in ['written-window.cjs', 'interview-prompt.cjs']:
        target = app_dir / 'resources/tools' / name
        if target.exists() and not target.with_name(name + '.before-rich-answers.bak').exists():
            shutil.copy2(target, target.with_name(name + '.before-rich-answers.bak'))
        shutil.copy2(HERE / name, target)
    update_prompt(app_dir)
    staged = archive_path.with_name('app.asar.rich-answers.tmp')
    if staged.exists(): raise RuntimeError('Existing staging file requires review')
    staged.write_bytes(patched)
    os.replace(staged, archive_path)
    print('Installed concise text/code view, passive show/reading lock and shared interview prompt editor.')
    print('Backup:', backup)


if __name__ == '__main__':
    main()
