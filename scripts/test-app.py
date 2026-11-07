#!/usr/bin/env python3
"""Validate an already-built bundle without opening the user's live workspace."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
APP = Path(os.environ.get('COSMURGY_TEST_APP', ROOT / 'dist/Cosmurgy.app')).resolve()


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cosmurgy-launcher-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.env = dict(os.environ)
        for name in ['COSMURGY_ROOT', 'JONUI_ROOT']:
            self.env.pop(name, None)
        self.env['COSMURGY_CONFIG_DIR'] = str(self.base / 'config')

    def launch(self, *arguments, app=APP, status=0):
        result = subprocess.run([str(app / 'Contents/MacOS/Cosmurgy'), *map(str, arguments), '--diagnose'],
                                env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, status, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def checkout(self, name='A checkout with spaces', dependencies=True):
        root = self.base / name
        (root / 'src').mkdir(parents=True)
        (root / 'src/app.ts').write_text('// test-only entry')
        (root / 'package.json').write_text('{}')
        if dependencies:
            (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        return root

    def test_bundle_identity_signature_icon_runtime_and_notices(self):
        info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
        self.assertEqual(info['CFBundleIdentifier'], 'com.daeken.Cosmurgy')
        self.assertEqual(info['CFBundleDisplayName'], 'Cosmurgy')
        self.assertEqual(info['CFBundleExecutable'], 'Cosmurgy')
        self.assertEqual((APP / 'Contents/Resources/Cosmurgy.icns').read_bytes()[:4], b'icns')
        for name in ['Cosmurgy-LICENSE', 'JonUI-LICENSE', 'Node-LICENSE']:
            self.assertTrue((APP / 'Contents/Resources/Notices' / name).is_file())
        self.assertTrue(list((APP / 'Contents/Frameworks').glob('libnode.*.dylib')))
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(APP)], check=True)
        result = self.launch()
        self.assertEqual(result['bundleIdentifier'], 'com.daeken.Cosmurgy')
        self.assertEqual(Path(result['checkout']).resolve(), ROOT.resolve())
        self.assertFalse((APP / 'Contents/Resources/.cosmurgy').exists())

    def test_checkout_configuration_persists_without_modifying_signed_bundle(self):
        checkout = self.checkout()
        runtime = APP / 'Contents/Resources/JonUI'
        result = self.launch('--checkout', checkout, '--jonui', runtime)
        self.assertEqual(Path(result['checkout']).resolve(), checkout.resolve())
        config = self.base / 'config/launcher.json'
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.launch()['checkout'], result['checkout'])
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(APP)], check=True)
        original = config.read_bytes()
        bad = self.launch('--checkout', self.base / 'missing', status=2)
        self.assertIn('Cannot find', bad['error'])
        self.assertEqual(config.read_bytes(), original)

    def test_environment_takes_precedence_and_missing_dependencies_are_explicit(self):
        configured = self.checkout('configured')
        self.launch('--checkout', configured)
        override = self.checkout('environment override')
        self.env['COSMURGY_ROOT'] = str(override)
        self.assertEqual(Path(self.launch()['checkout']).resolve(), override.resolve())
        self.env['COSMURGY_ROOT'] = str(self.checkout('no dependencies', dependencies=False))
        self.assertIn('dependencies are missing', self.launch(status=2)['error'])
        self.env['COSMURGY_ROOT'] = str(configured)
        self.env['JONUI_ROOT'] = str(self.base / 'missing-runtime')
        self.assertIn('Cannot find the JonUI', self.launch(status=2)['error'])

    def test_missing_development_runtime_falls_back_to_bundled_javascript(self):
        # A tiny diagnostic-only fixture exercises relocation, without modifying the real app seal.
        app = self.base / 'Relocated App.app'
        (app / 'Contents/MacOS').mkdir(parents=True)
        shutil.copy2(APP / 'Contents/MacOS/Cosmurgy', app / 'Contents/MacOS/Cosmurgy')
        shutil.copy2(APP / 'Contents/Info.plist', app / 'Contents/Info.plist')
        (app / 'Contents/MacOS/jonui').write_text('#!/bin/sh\nexit 0\n')
        (app / 'Contents/MacOS/jonui').chmod(0o755)
        resources = app / 'Contents/Resources'
        shutil.copytree(APP / 'Contents/Resources/JonUI', resources / 'JonUI')
        (resources / 'Checkout.json').write_text(json.dumps({'checkout': str(ROOT), 'jonui': str(self.base / 'missing')}))
        result = self.launch(app=app)
        self.assertEqual(result['bundledRuntime'], 'true')
        self.assertEqual(Path(result['runtime']).resolve(), (resources / 'JonUI').resolve())


if __name__ == '__main__':
    unittest.main()
