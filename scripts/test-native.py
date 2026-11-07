#!/usr/bin/env python3
"""Exercise the actual SwiftUI shell with a deterministic local model, offscreen."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent
JONUI = Path(os.environ.get('JONUI_ROOT', ROOT.parent / 'JonUI'))


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'models': [{'slug': 'native-test', 'display_name': 'Native test', 'visibility': 'list'}]}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert body['store'] is False and body['stream'] is True
        assert body['tools'][0]['type'] == 'namespace'
        assert 'prompt_cache_retention' not in body
        assert body['prompt_cache_key'].startswith('cosmurgy:') and len(body['prompt_cache_key']) == 57
        user = next((item.get('content', '') for item in reversed(body['input']) if item.get('role') == 'user'), '')
        answered = any(item.get('type') == 'function_call_output' for item in body['input'])
        if body['instructions'].startswith('You are compacting'):
            output = [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Native summary: older work and decisions preserved.'}]}]
        elif 'hot-services' in user and not any(item.get('call_id') == 'hot-service-call' for item in body['input']):
            assert self.headers.get('X-Cosmurgy-Service-Test') is None
            (self.server.data_dir / 'old-request-pending').write_text('ready')
            for _ in range(1000):
                if (self.server.data_dir / 'continue-old-request').exists():
                    break
                time.sleep(0.02)
            else:
                raise AssertionError('Timed out waiting for service swap')
            output = [{'type': 'function_call', 'call_id': 'hot-service-call', 'name': 'execute', 'arguments': json.dumps({'code': "return 'worker check';"})}]
        elif 'hot-services' in user:
            assert self.headers.get('X-Cosmurgy-Service-Test') == 'v2'
            result = next(item for item in body['input'] if item.get('type') == 'function_call_output' and item.get('call_id') == 'hot-service-call')
            assert json.loads(result['output'])['result'] == {'worker': 'v2', 'value': 'worker check'}
            if not getattr(self.server, 'service_swap_seen', False):
                saved = json.loads((self.server.data_dir / 'workspace.json').read_text())
                assert saved['spaces'][0]['conversations'][0]['title'] != 'Usage generation v2', 'in-flight request must finish on original usage implementation'
                self.server.service_swap_seen = True
            output = [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Hot services activated without restart.'}]}]
        elif 'compact-native' in user and not any(item.get('call_id') == 'compact-call' for item in body['input']):
            output = [{'type': 'function_call', 'call_id': 'compact-call', 'name': 'execute', 'arguments': json.dumps({'code': 'return await tools.compactContext();'})}]
        elif 'compact-native' in user:
            assert body['input'][0]['role'] == 'user' and 'Native summary:' in body['input'][0]['content']
            output = [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Compaction native test complete.'}]}]
        elif 'self-modify' in user and not answered:
            code = """
const source = await tools.readFile({path:'src/shell.ts'});
await tools.writeFile({path:'src/shell.ts',content:source.replace('An environment that grows with you.', 'Changed from the inside.').replace('A little shell, a little magic. ✨', 'Changed from the inside.')});
await tools.writeFile({path:'src/tools/hello.ts',content:'export default { name: "hello", description: "A freshly installed tool", signature: "() => string", run: () => "Hello from a new tool" };'});
await tools.createSpace({name:'Counter',purpose:'A tiny persistent counter',viewSource:`import { Component, Text, Button, VStack } from 'jonui'; import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; export function createView(host) { return Component(scope => { const path=join(__COUNTER_PATH__,'counter.txt'); let saved=0; try {saved=Number(readFileSync(path,'utf8'));} catch {} const count=scope.state(saved); return () => VStack([Text('Counter: '+count.value),Button('Increment',()=>{count.value++;writeFileSync(path,String(count.value));})]); })(); }`});
return await tools.reload();
""".replace("__COUNTER_PATH__", json.dumps(str(self.server.data_dir)))
            output = [{'type': 'function_call', 'call_id': 'native-call', 'name': 'execute', 'arguments': json.dumps({'code': code})}]
        elif 'self-modify' in user and not any(item.get('call_id') == 'new-tool-call' for item in body['input']):
            output = [{'type': 'function_call', 'call_id': 'new-tool-call', 'name': 'execute', 'arguments': json.dumps({'code': 'return await tools.hello();'})}]
        else:
            output = [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Built from the inside. Your new tool and space are ready.'}]}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        event = {'type': 'response.completed', 'response': {'status': 'completed', 'output': output, 'usage': {'input_tokens': 1000, 'output_tokens': 100, 'total_tokens': 1100, 'input_tokens_details': {'cached_tokens': 750}}}}
        self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())


with tempfile.TemporaryDirectory(prefix='cosmurgy-native-') as temporary:
    root = Path(temporary)
    for directory in ['src', 'tests']:
        shutil.copytree(ROOT / directory, root / directory)
    shutil.copy(ROOT / 'package.json', root / 'package.json')
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    config = root / 'config'
    config.mkdir()
    (config / 'accounts.json').write_text(json.dumps({'hostId': 'urn:uuid:native-test', 'active': 'test', 'accounts': [{
        'id': 'test', 'subject': 'test', 'email': 'native-test@example.com', 'clientId': 'test',
        'accessToken': 'fake-local-test-only', 'expiresAt': 9999999999999, 'scopes': ['chatgpt.tokens.use.direct']
    }]}))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    server.data_dir = root / '.cosmurgy'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {**os.environ, 'COSMURGY_AUTO_RELOAD': '0', 'JONUI_TEST': '1', 'JONUI_TEST_OFFSCREEN': '1', 'JONUI_TEST_LAYOUT': '1',
           'COSMURGY_ROOT': str(root), 'COSMURGY_CONFIG_DIR': str(config),
           'COSMURGY_TEST_MODEL_ENDPOINT': f'http://127.0.0.1:{server.server_port}',
           'JONUI_TEST_DRIVER': str(root / 'tests/native-driver.mjs')}
    try:
        for case in ['first', 'restart', 'context', 'services']:
            if case == 'context':
                path = root / '.cosmurgy/workspace.json'
                workspace = json.loads(path.read_text())
                space = workspace['spaces'][0]
                conversation = space['conversations'][0]
                workspace['selectedSpace'] = space['id']
                workspace['selectedConversation'] = conversation['id']
                conversation['input'] = []
                conversation['messages'] = []
                conversation['draft'] = ''
                for turn in range(1, 10):
                    conversation['input'].extend([
                        {'role': 'user', 'content': f'older-turn-{turn}'},
                        {'type': 'function_call', 'call_id': f'old-{turn}', 'name': 'execute', 'arguments': '{"code":"return 1"}'},
                        {'type': 'function_call_output', 'call_id': f'old-{turn}', 'output': f'old-result-{turn}'},
                        {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': f'old-answer-{turn}'}]}
                    ])
                    conversation['messages'].append({'id': f'old-visible-{turn}', 'role': 'user', 'text': f'older-turn-{turn}', 'at': ''})
                path.write_text(json.dumps(workspace))
            if case == 'services':
                path = root / '.cosmurgy/workspace.json'
                workspace = json.loads(path.read_text())
                workspace['selectedSpace'] = workspace['spaces'][0]['id']
                conversation = workspace['spaces'][0]['conversations'][0]
                workspace['selectedConversation'] = conversation['id']
                conversation.update(input=[], messages=[], draft='', title='Service test')
                conversation.pop('context', None)
                conversation.pop('usage', None)
                path.write_text(json.dumps(workspace))
            env['COSMURGY_AUTO_RELOAD'] = '1' if case == 'services' else '0'
            env['COSMURGY_NATIVE_CASE'] = case
            bundle = os.environ.get('COSMURGY_TEST_APP')
            command = [str(JONUI / 'bin/jonui'), str(root / 'src/app.ts')]
            if bundle:
                app = Path(bundle).resolve()
                env['JONUI_ROOT'] = str(app / 'Contents/Resources/JonUI')
                command = [str(app / 'Contents/MacOS/Cosmurgy')]
            subprocess.run(command, env=env, check=True, timeout=45)
    finally:
        server.shutdown()
