#!/usr/bin/env python3
"""Build a local, ad-hoc-signed macOS app; TypeScript stays in a live checkout."""
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent.parent
IDENTIFIER = 'com.daeken.Cosmurgy'


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True, cwd=ROOT)


def install(app, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        info = destination / 'Contents/Info.plist'
        if not info.exists() or plistlib.loads(info.read_bytes()).get('CFBundleIdentifier') != IDENTIFIER:
            raise SystemExit(f'Refusing to replace an unrelated app at {destination}')
    pending = destination.parent / f'.Cosmurgy-{uuid.uuid4()}.app'
    backup = destination.parent / f'.Cosmurgy-backup-{uuid.uuid4()}.app'
    try:
        shutil.copytree(app, pending)
        if destination.exists():
            destination.rename(backup)
        try:
            pending.rename(destination)
        except BaseException:
            if backup.exists():
                backup.rename(destination)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if pending.exists():
            shutil.rmtree(pending)
    run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', '-f', destination)
    print(f'Installed {destination}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jonui', type=Path, default=Path(os.environ.get('JONUI_ROOT', ROOT.parent / 'JonUI')))
    parser.add_argument('--checkout', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/Cosmurgy.app')
    parser.add_argument('--install', action='store_true', help='Install into ~/Applications without launching')
    parser.add_argument('--skip-jonui-build', action='store_true', help='Reuse an already validated native JonUI build')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('Cosmurgy.app requires macOS 14+ and Xcode command-line tools.')
    jonui, checkout, output = args.jonui.resolve(), args.checkout.resolve(), args.output.resolve()
    if not (checkout / 'src/app.ts').is_file():
        raise SystemExit('The checkout must contain src/app.ts.')
    if output.suffix != '.app':
        raise SystemExit('--output must end in .app')
    if output.exists():
        info = output / 'Contents/Info.plist'
        if not info.exists() or plistlib.loads(info.read_bytes()).get('CFBundleIdentifier') != IDENTIFIER:
            raise SystemExit(f'Refusing to replace an unrelated path at {output}')
    if not args.skip_jonui_build:
        run(sys.executable, jonui / 'scripts/build.py')
    native = jonui / '.build/jonui/JonUI.app/Contents'
    if not (native / 'MacOS/jonui').is_file():
        raise SystemExit('Build JonUI first.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.cosmurgy-app-', dir=output.parent) as work:
        work = Path(work)
        app = work / 'Cosmurgy.app'
        contents = app / 'Contents'
        executable, resources, frameworks = (contents / name for name in ['MacOS', 'Resources', 'Frameworks'])
        for directory in [executable, resources, frameworks]:
            directory.mkdir(parents=True)
        # Copies, not hard links: signing the app must never mutate the running checkout host.
        shutil.copy2(native / 'MacOS/jonui', executable / 'jonui')
        for library in (native / 'Frameworks').glob('*.dylib'):
            shutil.copy2(library, frameworks / library.name)
        shutil.copytree(jonui / 'runtime', resources / 'JonUI/runtime')
        notices = resources / 'Notices'
        notices.mkdir()
        shutil.copy2(ROOT / 'LICENSE', notices / 'Cosmurgy-LICENSE')
        shutil.copy2(jonui / 'LICENSE', notices / 'JonUI-LICENSE')
        node_licenses = list((jonui / '.build/node').glob('node-v*/LICENSE'))
        if not node_licenses:
            raise SystemExit('Node license notices are missing; build JonUI first.')
        shutil.copy2(node_licenses[0], notices / 'Node-LICENSE')
        (resources / 'Checkout.json').write_text(json.dumps({'checkout': str(checkout), 'jonui': str(jonui)}, indent=2) + '\n')
        target = platform.machine() + '-apple-macosx14.0'
        run('swiftc', '-O', '-target', target, ROOT / 'native/Launcher.swift', '-o', executable / 'Cosmurgy')
        run('swiftc', '-O', '-target', target, ROOT / 'assets/make-icon.swift', '-o', work / 'make-icon')
        iconset = work / 'Cosmurgy.iconset'
        run(work / 'make-icon', iconset)
        run('iconutil', '-c', 'icns', iconset, '-o', resources / 'Cosmurgy.icns')
        version = json.loads((ROOT / 'package.json').read_text())['version']
        info = {'CFBundleName': 'Cosmurgy', 'CFBundleDisplayName': 'Cosmurgy',
                'CFBundleIdentifier': IDENTIFIER, 'CFBundleExecutable': 'Cosmurgy',
                'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1',
                'CFBundleShortVersionString': version, 'CFBundleIconFile': 'Cosmurgy.icns',
                'LSMinimumSystemVersion': '14.0', 'LSApplicationCategoryType': 'public.app-category.developer-tools',
                'NSHighResolutionCapable': True, 'NSPrincipalClass': 'JonUIApplication'}
        (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
        for signed in [*frameworks.glob('*.dylib'), executable / 'jonui', executable / 'Cosmurgy', app]:
            run('codesign', '--force', '--sign', '-', signed)
        run('codesign', '--verify', '--deep', '--strict', app)
        # Keep an earlier build intact unless the complete replacement passes signing.
        install_backup = output.parent / f'.Cosmurgy-old-{uuid.uuid4()}.app'
        if output.exists():
            output.rename(install_backup)
        try:
            app.rename(output)
        except BaseException:
            if install_backup.exists():
                install_backup.rename(output)
            raise
        if install_backup.exists():
            shutil.rmtree(install_backup)
    print(f'Built {output}')
    if args.install:
        install(output, Path.home() / 'Applications/Cosmurgy.app')


if __name__ == '__main__':
    main()
