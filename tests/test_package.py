import importlib.util
import json
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('installer', ROOT / 'meeting-copilot/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PackageChecks(unittest.TestCase):
    def test_exact_edits_and_mismatched_build(self):
        edits = installer.PATCH['edits']
        source = '\n'.join(edit['before'] for edit in edits)
        result = installer.apply_edits(source, edits)
        for edit in edits:
            self.assertIn(edit['after'], result)
        with self.assertRaises(ValueError):
            installer.apply_edits('different source', edits)

    def test_asar_preserves_other_files_and_data(self):
        header = {'files': {'keep.txt': {'size': 4, 'offset': '0'}, 'main.js': {'size': 3, 'offset': '4'}}}
        encoded = json.dumps(header).encode()
        payload = struct.pack('<I', len(encoded)) + encoded
        payload += b'\0' * (-len(payload) % 4)
        pickle = struct.pack('<I', len(payload)) + payload
        original = struct.pack('<II', 4, len(pickle)) + pickle + b'KEEPold'
        patched = installer.replace_member(original, 'main.js', b'new screenshot code')
        new_header, start = installer.read_header(patched)
        self.assertEqual(installer.read_member(patched, new_header, start, 'keep.txt'), b'KEEP')
        self.assertEqual(installer.read_member(patched, new_header, start, 'main.js'), b'new screenshot code')
        self.assertEqual(new_header['files']['keep.txt'], header['files']['keep.txt'])
        self.assertEqual(patched[start:start + 7], b'KEEPold')
        self.assertEqual(new_header['files']['main.js']['integrity']['hash'], installer.sha256(b'new screenshot code'))

    def test_helper_has_no_console(self):
        exe = (ROOT / 'bin/QuietCapture.exe').read_bytes()
        pe = struct.unpack_from('<I', exe, 0x3c)[0]
        self.assertEqual(struct.unpack_from('<H', exe, pe + 24 + 68)[0], 2)


if __name__ == '__main__':
    unittest.main()
