"""Install the tested full-screen capture patch without repacking native dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PATCH = json.loads((Path(__file__).with_name('patch.json')).read_text(encoding='utf-8'))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_header(archive):
    size, header_size, _, json_size = struct.unpack_from('<4I', archive)
    if size != 4 or json_size > header_size - 8 or header_size + 8 > len(archive):
        raise ValueError('Invalid ASAR header')
    return json.loads(archive[16:16 + json_size]), 8 + header_size


def entry_for(header, filename):
    entry = header
    for part in filename.split('/'):
        entry = entry['files'][part]
    if entry.get('unpacked') or 'offset' not in entry:
        raise ValueError('Expected a packed file: ' + filename)
    return entry


def read_member(archive, header, data_start, filename):
    entry = entry_for(header, filename)
    start = data_start + int(entry['offset'])
    return archive[start:start + entry['size']]


def apply_edits(source, edits):
    for edit in edits:
        if source.count(edit['before']) != 1:
            raise ValueError('The expected screenshot code does not match this installation')
        source = source.replace(edit['before'], edit['after'])
    return source


def replace_member(archive, filename, content):
    header, data_start = read_header(archive)
    entry = entry_for(header, filename)
    block_size = entry.get('integrity', {}).get('blockSize', 4194304)
    entry.update(size=len(content), offset=str(len(archive) - data_start), integrity={
        'algorithm': 'SHA256', 'hash': sha256(content), 'blockSize': block_size,
        'blocks': [sha256(content[i:i + block_size]) for i in range(0, len(content), block_size)]
    })
    encoded = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    payload = struct.pack('<I', len(encoded)) + encoded
    payload += b'\0' * (-len(payload) % 4)
    header_pickle = struct.pack('<I', len(payload)) + payload
    return struct.pack('<II', 4, len(header_pickle)) + header_pickle + archive[data_start:] + content


def replace_members(archive, replacements):
    for filename, content in replacements.items():
        archive = replace_member(archive, filename, content)
    return archive


def add_shortcut_features(main, renderer):
    main_edits = [
        ('      if (shot) {\n        const ok = electron.globalShortcut.register(shot, () => win?.webContents.send(IPC.shotHotkey));',
         '      if (shot && !/^Mouse[45]$/.test(shot)) {\n        const ok = electron.globalShortcut.register(shot, () => win?.webContents.send(IPC.shotHotkey));'),
        ('  function createWindow() {', '''  let mouseShotServer = null;
  let mouseShotProcess = null;
  function stopMouseShot() {
    if (mouseShotProcess && !mouseShotProcess.killed) mouseShotProcess.kill();
    mouseShotProcess = null;
    mouseShotServer?.close();
    mouseShotServer = null;
  }
  function startMouseShot(button) {
    const pipeName = `meeting-copilot-mouse-${process.pid}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    mouseShotServer = net.createServer((socket) => {
      socket.on("data", () => win?.webContents.send(IPC.shotHotkey));
    });
    mouseShotServer.listen(pipePath, () => {
      const executable = path.join(process.resourcesPath, "tools", "QuietCapture.exe");
      mouseShotProcess = child_process.spawn(executable, ["--mouse-watch", pipeName, button], { windowsHide: true, stdio: "ignore" });
      mouseShotProcess.on("error", (error) => console.warn("[main] mouse shortcut failed:", error.message));
    });
    mouseShotServer.on("error", (error) => console.warn("[main] mouse shortcut pipe failed:", error.message));
  }
  function createWindow() {'''),
        ('      console.warn("[main] hotkey register error:", e.message);\n    }\n  }',
         '      console.warn("[main] hotkey register error:", e.message);\n    }\n    stopMouseShot();\n    if (/^Mouse[45]$/.test(shot || "")) startMouseShot(shot);\n  }'),
        ('    electron.globalShortcut.unregisterAll();\n    tray.destroy();',
         '    electron.globalShortcut.unregisterAll();\n    stopMouseShot();\n    tray.destroy();')
    ]
    for before, after in main_edits:
        if after not in main:
            if main.count(before) != 1:
                raise ValueError('The expected shortcut registration code does not match this build')
            main = main.replace(before, after, 1)
    renderer_edits = [
        ('hotkeyShot: "截图快捷键（框选截图问答，如 Control+Shift+S）"',
         'hotkeyShot: "截图键（键盘组合或鼠标侧键 Mouse4 / Mouse5）"'),
        ('hotkeyShot: "Screenshot hotkey (region screenshot Q&A, e.g. Control+Shift+S)"',
         'hotkeyShot: "Screenshot shortcut (key combination or mouse side button Mouse4 / Mouse5)"'),
        ('          onChange: (e) => setHotkeyShot(e.target.value),\n          spellCheck: false',
         '''          onChange: (e) => setHotkeyShot(e.target.value),
          onKeyDown: (e) => {
            e.preventDefault();
            const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
            const modifiers = [];
            if (e.ctrlKey) modifiers.push("Control");
            if (e.altKey) modifiers.push("Alt");
            if (e.shiftKey) modifiers.push("Shift");
            if (e.metaKey) modifiers.push("Super");
            if (!["Control", "Alt", "Shift", "Meta"].includes(e.key) && modifiers.length && key !== "Escape") {
              setHotkeyShot([...modifiers, key].join("+"));
            }
          },
          onMouseDown: (e) => {
            if (e.button === 3 || e.button === 4) {
              e.preventDefault();
              setHotkeyShot(e.button === 3 ? "Mouse4" : "Mouse5");
            }
          },
          spellCheck: false''')
    ]
    for before, after in renderer_edits:
        if after not in renderer:
            if renderer.count(before) != 1:
                raise ValueError('The expected screenshot shortcut setting does not match this build')
            renderer = renderer.replace(before, after, 1)
    return main, renderer


def require_closed(app_dir):
    script = "$exe=Join-Path $env:QUIET_CAPTURE_APP_DIR 'MeetingCopilot.exe'; if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe }) { exit 1 }"
    result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script],
                            env={**os.environ, 'QUIET_CAPTURE_APP_DIR': str(app_dir)},
                            creationflags=subprocess.CREATE_NO_WINDOW, capture_output=True)
    if result.returncode:
        raise RuntimeError('Exit MeetingCopilot from its tray before installing')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app_dir', nargs='?', default=str(Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs/meeting-copilot'))
    parser.add_argument('--check', action='store_true', help='Validate compatibility without changing files')
    args = parser.parse_args()
    app_dir = Path(args.app_dir).resolve()
    archive_path = app_dir / 'resources/app.asar'
    helper_path = app_dir / 'resources/tools/QuietCapture.exe'
    helper = ROOT / 'bin/QuietCapture.exe'
    original = archive_path.read_bytes()
    header, data_start = read_header(original)
    source = read_member(original, header, data_start, PATCH['main_path'])
    current_hash = sha256(source)
    legacy_hash = PATCH['patched_main_sha256']
    renderer_path = 'out/renderer/assets/index-hyFYaQxP.js'
    renderer_entry = entry_for(header, renderer_path)
    renderer_start = data_start + int(renderer_entry['offset'])
    renderer_bytes = original[renderer_start:renderer_start + renderer_entry['size']]
    if current_hash not in (PATCH['original_main_sha256'], legacy_hash) and b'stopMouseShot' not in source:
        raise RuntimeError('Unsupported application build; this patch supports MeetingCopilot 0.2.0-beta.1 only')
    if b'stopMouseShot' in source and b'onMouseDown: (e)' in renderer_bytes:
        if not helper_path.is_file() or sha256(helper_path.read_bytes()) != sha256(helper.read_bytes()):
            raise RuntimeError('The shortcut settings are installed, but the helper is missing or mismatched')
        print('The quiet screenshot and configurable shortcut patch is already installed.')
        return
    main_text = source.decode('utf-8')
    if current_hash == PATCH['original_main_sha256']:
        main_text = apply_edits(main_text, PATCH['edits'])
    patched_main, patched_renderer = add_shortcut_features(main_text, renderer_bytes.decode('utf-8'))
    patched_source = patched_main.encode('utf-8')
    patched_renderer = patched_renderer.encode('utf-8')
    if args.check:
        print('Compatible: the patch matches the installed application. No files changed.')
        return
    require_closed(app_dir)
    backup = archive_path.with_name('app.asar.quiet-capture.bak')
    if backup.exists() and sha256(backup.read_bytes()) != sha256(original):
        prior = backup.read_bytes()
        prior_header, prior_start = read_header(prior)
        prior_main = read_member(prior, prior_header, prior_start, PATCH['main_path'])
        if sha256(prior_main) != PATCH['original_main_sha256']:
            raise RuntimeError('A different backup already exists; preserve it before continuing')
    patched_archive = replace_members(original, {PATCH['main_path']: patched_source, renderer_path: patched_renderer})
    new_header, new_start = read_header(patched_archive)
    if read_member(patched_archive, new_header, new_start, PATCH['main_path']) != patched_source:
        raise RuntimeError('Patched archive verification failed')
    if not backup.exists():
        shutil.copy2(archive_path, backup)
    if sha256(backup.read_bytes()) != sha256(original) and sha256(read_member(backup.read_bytes(), *read_header(backup.read_bytes()), PATCH['main_path'])) != PATCH['original_main_sha256']:
        raise RuntimeError('Backup verification failed')
    staged = archive_path.with_name('app.asar.quiet-capture.tmp')
    if staged.exists():
        raise RuntimeError('A staging file already exists; review it before continuing')
    staged.write_bytes(patched_archive)
    helper_path.parent.mkdir(parents=True, exist_ok=True)
    if helper_path.exists() and sha256(helper_path.read_bytes()) != sha256(helper.read_bytes()):
        helper_backup = helper_path.with_name('QuietCapture.exe.quiet-capture.bak')
        if helper_backup.exists() and sha256(helper_backup.read_bytes()) != sha256(helper_path.read_bytes()):
            raise RuntimeError('A different helper backup already exists; preserve it before continuing')
        if not helper_backup.exists():
            shutil.copy2(helper_path, helper_backup)
    shutil.copy2(helper, helper_path)
    os.replace(staged, archive_path)
    print('Installed. Start MeetingCopilot and use its existing screenshot button/hotkey.')
    print('Backup:', backup)


if __name__ == '__main__':
    main()
