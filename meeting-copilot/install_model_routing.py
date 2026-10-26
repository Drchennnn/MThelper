"""Route ordinary answers exclusively to text; reserve multimodal interfaces for screenshots."""
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
MARKER = '// meeting-copilot-separate-model-routing-v1'


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Unexpected source near: ' + before[:100])
    return text.replace(before, after, 1)


def patch_sources(main, renderer):
    if MARKER in main or '// meeting-copilot-rich-answers-prompt-v1' not in main:
        raise ValueError('Requires the rich answers/prompt patch, without this routing patch')
    main = once(main, '    if (!apiKey || unifiedEnabled() || settings.data.llm.answerWithVision) return;', '    if (!apiKey) return;')
    main = once(main, '      if (!apiKey && !unifiedEnabled()) {', '      if (!apiKey) {')
    start = main.index('      const useVision = !unifiedEnabled()')
    end = main.index('      work.then((r) => {', start)
    main = main[:start] + '''      if (!isTranslate && payload.mode !== "free") {
        lastPrefix = stablePrefixFor(payload.resume || payload.background, payload.jd);
        lastPrefixActivity = Date.now();
      }
      const work = chatStream(
        { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
        messages,
        { onDelta: (text) => { if (!ac.signal.aborted) sendEv({ requestId: payload.requestId, kind: "delta", text }); } },
        ac.signal
      );
''' + main[end:]
    main = once(main, '''        if (unifiedEnabled()) {
          try { return clampMemo(await multimodalRouter.chat(buildMemoUpdateMessages(p.memo ?? "", p.question ?? "", p.answer ?? ""))); }
          catch { return ""; }
        }
''', '')
    main = once(main, '      if (unifiedEnabled()) return multimodalRouter.chat(buildTranslateMessages(text));\n', '')
    main = once(main, '''        const vision2 = settings.data.vision;
        const apiKey = settings.getVisionApiKey();
        if (!unifiedEnabled() && (!vision2.baseUrl || !vision2.model || !apiKey)) {''', '''        if (!unifiedEnabled() || !multimodalRouter.ready()) {''')
    main = once(main, '            message: T().noVision', '            message: "请启用截图问答，并在设置中配置至少一个可用的截图模型接口"')
    main = once(main, '          (dataUrl) => unifiedEnabled() ? multimodalRouter.chat(', '          (dataUrl) => multimodalRouter.chat(')
    main = once(main, '''          ) : visionChat(
            { baseUrl: vision2.baseUrl, model: vision2.model, apiKey, proxyUrl: vision2.proxyUrl },
            buildVisionMessages(payload.question, dataUrl, payload.background || knowledge.text),
            ac.signal
          )''', '          )')
    main = once(main, '({ answerMode: true, onResult: (result) => sendEv({ requestId, kind: "model", result }) })', '({ answerMode: true, simultaneousAnswers: multimodalRouter.getPublic().mode === "written" && multimodalRouter.getPublic().simultaneousAnswers, onResult: (result) => sendEv({ requestId, kind: "model", result }) })')
    main = MARKER + '\n' + main

    start = renderer.index('function MultimodalSettings(')
    end = renderer.index('function InterviewPromptSettings(', start)
    renderer = renderer[:start] + (HERE / 'multimodal-ui.js').read_text(encoding='utf8') + '\n' + renderer[end:]
    renderer = once(renderer, '  const visionReady = settings?.multimodal?.enabled ? settings.multimodal.ready : !!settings?.llm.answerWithVision && !!settings?.vision.baseUrl && !!settings?.vision.model && !!settings?.vision.apiKeySet;', '  const visionReady = !!settings?.multimodal?.enabled && !!settings?.multimodal?.ready;')
    renderer = once(renderer, '''    const updated = await window.mc.setSettings(settings.multimodal
      ? { multimodal: { ...settings.multimodal, enabled: !settings.multimodal.enabled }, llm: { answerWithVision: false } }
      : { llm: { answerWithVision: !settings.llm.answerWithVision } });''', '''    if (!settings.multimodal) return;
    const updated = await window.mc.setSettings({ multimodal: { ...settings.multimodal, enabled: !settings.multimodal.enabled } });''')
    renderer = once(renderer, 'className: (settings?.multimodal?.enabled || settings?.llm.answerWithVision) ? "btn btn-on" : "btn",', 'className: settings?.multimodal?.enabled ? "btn btn-on" : "btn",')
    renderer = once(renderer, 'children: settings?.multimodal?.enabled ? t.titlebar.vision : settings?.llm.answerWithVision ? t.titlebar.vision : t.titlebar.textOnly', 'children: settings?.multimodal?.enabled ? t.titlebar.vision : t.titlebar.textOnly')
    renderer = once(renderer, '        settings?.multimodal?.enabled && jsxRuntimeExports.jsxs("select", {', '        settings?.multimodal && jsxRuntimeExports.jsxs("select", {')
    renderer = once(renderer, '    vision: "多模态",\n    textOnly: "纯文本",\n    modelTitle: "回答用的模型：纯文本大模型（快） ⇄ 多模态模型（可截图问答）",', '    vision: "截图开",\n    textOnly: "截图关",\n    modelTitle: "仅控制截图问答。面试转录、持续答和手动提问始终使用设置中的文本模型。",')
    # English labels are exact literals from the shipped renderer.
    renderer = once(renderer, '    vision: "Vision",', '    vision: "Screenshots on",')
    renderer = once(renderer, '    textOnly: "Text",', '    textOnly: "Screenshots off",')
    start = renderer.index('    modelTitle:', renderer.index('const en = {'))
    end = renderer.index('\n', start)
    renderer = renderer[:start] + '    modelTitle: "Only controls screenshot Q&A. Spoken and typed answers always use the configured text model.",' + renderer[end:]
    renderer = renderer.replace('纯文本/多模态切换在标题栏；截图按钮仅多模态模式显示。', '标题栏“截图开/关”只控制截图；普通问答始终使用文本模型。')
    renderer = renderer.replace('麦克风开关与多模态切换在标题栏；', '麦克风开关与截图开关在标题栏；')
    return {MAIN: main.encode('utf8'), RENDERER: renderer.encode('utf8')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app_dir', nargs='?', default=str(Path(os.environ['LOCALAPPDATA']) / 'Programs/meeting-copilot'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    app_dir = Path(args.app_dir).resolve()
    target = app_dir / 'resources/app.asar'
    archive = target.read_bytes()
    header, offset = asar.read_header(archive)
    sources = [asar.read_member(archive, header, offset, member).decode('utf8') for member in [MAIN, RENDERER]]
    if MARKER in sources[0]: print('Separate model routing already installed.'); return
    replacements = patch_sources(*sources)
    check = ROOT / 'work/model-routing-check'
    check.mkdir(parents=True, exist_ok=True)
    for member, content in replacements.items():
        file = check / ('main.cjs' if member == MAIN else 'renderer.mjs')
        file.write_bytes(content)
        subprocess.run(['node', '--check', str(file)], check=True)
    if args.check: print('Compatible: syntax checks passed; no installed files changed.'); return
    asar.require_closed(app_dir)
    backup = target.with_name('app.asar.before-model-routing.bak')
    if backup.exists() and backup.read_bytes() != archive: raise RuntimeError('Different routing backup exists')
    patched = asar.replace_members(archive, replacements)
    h, o = asar.read_header(patched)
    for member, content in replacements.items():
        if asar.read_member(patched, h, o, member) != content: raise RuntimeError('ASAR verification failed')
    if not backup.exists(): shutil.copy2(target, backup)
    module = app_dir / 'resources/multimodal/multimodal-router.cjs'
    module_backup = module.with_name(module.name + '.before-model-routing.bak')
    if not module_backup.exists(): shutil.copy2(module, module_backup)
    shutil.copy2(HERE / 'multimodal-router.cjs', module)
    stage = target.with_name('app.asar.model-routing.tmp')
    if stage.exists(): raise RuntimeError('Existing staging file requires inspection')
    stage.write_bytes(patched)
    os.replace(stage, target)
    print('Installed text-only interview routing and screenshot-only multimodal routing.')
    print('No settings, prompts or credentials changed. Backup:', backup)


if __name__ == '__main__': main()
