import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { __testing as test } from 'jonui';
const root = process.env.COSMURGY_ROOT;
const snapshot = () => test.request('debug.snapshot');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = value => snapshot().nodes.some(n => n.kind === 'text' && n.props.value === value);
async function until(predicate, name) {
  const end = Date.now() + 12_000;
  do { if (predicate(snapshot())) return snapshot(); await pause(20); } while (Date.now() < end);
  throw new Error(`Timed out: ${name}. Text: ${snapshot().nodes.filter(n => n.kind === 'text').map(n => n.props.value).join(' | ')}`);
}
function control(identifier, kind) {
  const state = snapshot(); const nodes = new Map(state.nodes.map(n => [n.id, n]));
  let node = state.nodes.find(n => n.kind === 'modifier' && n.props.name === 'accessibilityIdentifier' && n.props.value === identifier);
  while (node && node.kind !== kind) node = nodes.get(node.children[0]);
  assert.ok(node, `${identifier}/${kind}`); return node;
}
const click = identifier => test.request('debug.action', { id: control(identifier, 'button').id });
async function write(identifier, value) {
  test.request('debug.write', { id: control(identifier, 'texteditor').props.state, value });
  await pause(70);
}
function workspace() { return JSON.parse(readFileSync(join(root, '.cosmurgy/workspace.json'), 'utf8')); }
await until(s => s.windowVisible && s.nodes.some(n => n.kind === 'button' && n.props.title === 'Send'), 'mounted shell');
await until(() => text('Connected to ChatGPT. Ready to build.'), 'account models');
assert.equal(test.request('debug.focusStatus').key, false);
if (process.env.COSMURGY_TEST_APP) {
  const identity = test.request('debug.application');
  assert.equal(identity.bundleIdentifier, 'com.daeken.Cosmurgy');
  assert.equal(identity.displayName, 'Cosmurgy');
  assert.equal(identity.quitMenuTitle, 'Quit Cosmurgy');
  assert.ok(process.execPath.endsWith('/Contents/MacOS/jonui'));
}
function identifierFrame(identifier) {
  const node = snapshot().nodes.find(n => n.kind === 'modifier' && n.props.name === 'accessibilityIdentifier' && n.props.value === identifier);
  return test.request('debug.layout').frames.find(frame => frame.id === node?.id)?.rect;
}
await until(() => identifierFrame('composer-panel')?.height > 0, 'composer layout');
assert.ok(identifierFrame('composer-panel').height <= 150, JSON.stringify(identifierFrame('composer-panel')));
assert.ok(identifierFrame('composer').height <= 50, JSON.stringify(identifierFrame('composer')));
assert.ok(identifierFrame('transcript').height >= 300, JSON.stringify(identifierFrame('transcript')));
if (process.env.COSMURGY_NATIVE_CASE === 'services') {
  const providerPath = join(root, 'src/provider.ts'), usagePath = join(root, 'src/usage.ts'), workerPath = join(root, 'src/executor-worker.ts');
  const provider = readFileSync(providerPath, 'utf8'), usage = readFileSync(usagePath, 'utf8'), worker = readFileSync(workerPath, 'utf8');
  await write('composer', 'hot-services'); click('send-message');
  await until(() => existsSync(join(root, '.cosmurgy/old-request-pending')), 'old model request in flight');
  const changedProvider = provider.replace("Accept: 'text/event-stream'", "Accept: 'text/event-stream', 'X-Cosmurgy-Service-Test': 'v2'");
  assert.notEqual(changedProvider, provider);
  writeFileSync(providerPath, changedProvider);
  writeFileSync(usagePath, usage.replace('  const previous = conversation.usage;', "  conversation.title = 'Usage generation v2';\n  const previous = conversation.usage;"));
  writeFileSync(workerPath, worker.replace("value: result ?? null", "value: { worker: 'v2', value: result ?? null }"));
  await until(() => text('Generation 2 is live · 9 TypeScript tools'), 'automatic service activation during request');
  writeFileSync(join(root, '.cosmurgy/continue-old-request'), 'continue');
  await until(() => text('Hot services activated without restart.'), 'old request completes and new provider/usage/worker serve next operations');
  await until(() => workspace().spaces[0].conversations[0].run === 'idle', 'service run finished');
  assert.equal(workspace().spaces[0].conversations[0].title, 'Usage generation v2');
  assert.equal(workspace().spaces[0].conversations[0].usage.completedRequests, 2);
  assert.equal(workspace().spaces[0].conversations[0].input.filter(i => i.type === 'function_call_output' && i.call_id === 'hot-service-call').length, 1);
  await write('composer', 'draft survives a bad automatic build');
  writeFileSync(providerPath, 'broken provider syntax !!');
  await until(() => snapshot().nodes.some(n => n.kind === 'text' && String(n.props.value).includes('Build failed')), 'bad automatic service build reported');
  assert.equal(workspace().spaces[0].conversations[0].draft, 'draft survives a bad automatic build');
  await write('composer', 'hot-services-again'); click('send-message');
  await until(() => workspace().spaces[0].conversations[0].usage.completedRequests === 3, 'old service still usable after rejected build');
  await until(() => workspace().spaces[0].conversations[0].run === 'idle', 'second run idle');
  writeFileSync(providerPath, changedProvider);
  await until(() => text('Generation 3 is live · 9 TypeScript tools'), 'auto recovery after fixed provider');
  const servicesPath = join(root, 'src/services.ts'), goodServices = readFileSync(servicesPath, 'utf8');
  writeFileSync(servicesPath, 'export function createServices() { return {models:async()=>[],complete:async()=>({output:[],calls:[]})}; }');
  await until(() => snapshot().nodes.some(n => n.kind === 'text' && String(n.props.value).includes('Services must provide')), 'incompatible service contract rejected');
  await write('composer', 'hot-services-after-invalid-contract'); click('send-message');
  await until(() => workspace().spaces[0].conversations[0].usage.completedRequests === 4, 'last good service survives contract failure');
  await until(() => workspace().spaces[0].conversations[0].run === 'idle', 'third run idle');
  writeFileSync(servicesPath, goodServices);
  await until(() => text('Generation 4 is live · 9 TypeScript tools'), 'contract recovery');
  const appPath = join(root, 'src/app.ts');
  writeFileSync(appPath, readFileSync(appPath, 'utf8') + '\n// foundation change requires explicit restart\n');
  await until(() => snapshot().nodes.some(n => n.kind === 'text' && String(n.props.value).includes('Restart required for foundation changes: src/app.ts')), 'foundation boundary warning');
  await pause(700);assert.ok(text('Generation 4'));
  console.log('PASS native services: automatic provider/usage/worker activation during an in-flight request, pinned old request, next-operation adoption, failed-build rollback, draft preservation, recovery and explicit foundation boundary');
} else if (process.env.COSMURGY_NATIVE_CASE === 'context') {
  const original = workspace().spaces[0].conversations[0];
  const recent = structuredClone(original.input.slice(16)); // turns 5–9 plus the new current turn form the protected six
  await write('composer', 'compact-native'); click('send-message');
  await until(() => text('Compaction native test complete.'), 'agent-requested compaction');
  const compacted = workspace().spaces[0].conversations[0];
  assert.equal(compacted.context.summary, 'Native summary: older work and decisions preserved.');
  assert.equal(compacted.context.compactedTurns, 4);
  assert.equal(compacted.context.requested, false);
  assert.deepEqual(compacted.input.slice(0, recent.length), recent);
  assert.deepEqual(compacted.messages.filter(m => m.id.startsWith('old-visible-')), original.messages);
  assert.equal(compacted.input.filter(i => i.type === 'function_call_output' && i.call_id === 'compact-call').length, 1);
  assert.equal(compacted.usage.last.tokens.cachedInputTokens, 750);
  assert.ok(compacted.usage.completedRequests >= 3);
  console.log('PASS native context: agent tool request, safe-boundary summary, recent turns intact, durable memory and visible transcript preservation');
} else if (process.env.COSMURGY_NATIVE_CASE === 'restart') {
  assert.ok(text('Changed from the inside.'), JSON.stringify(workspace().spaces[0].conversations[0].messages));
  assert.ok(text('Built from the inside. Your new tool and space are ready.'));
  assert.equal(workspace().spaces[0].conversations[0].draft, 'An unsent persistent draft 🦊');
  assert.equal(workspace().spaces[0].conversations[0].usage.cachedInputTokens, 2250);
  assert.equal(control('cache-usage', 'button').props.title, 'Cache: 75% · 750/1,000 input');
  const counter = workspace().spaces.find(s => s.name === 'Counter'); click(`space-${counter.id}`);
  await until(() => text('Counter: 1'), 'persistent space data after restart');
  console.log('PASS native restart: saved conversations, drafts, changed shell, custom space and owned data');
} else {
  await write('composer', 'multiline smoke test');
  assert.equal(test.request('debug.focus', { editor: 0 }).accepted, true);
  assert.equal(test.request('debug.return', { shift: true }).intercepted, false);
  await until(() => workspace().spaces[0].conversations[0].draft.includes('\n'), 'Shift-Enter newline');
  assert.equal(workspace().spaces[0].conversations[0].messages.length, 0);
  await write('composer', 'self-modify');
  assert.equal(test.request('debug.return').intercepted, true);
  await until(() => text('Built from the inside. Your new tool and space are ready.'), 'agent self-modification');
  assert.ok(text('Changed from the inside.'), JSON.stringify(workspace().spaces[0].conversations[0].messages));
  assert.equal(workspace().spaces[0].conversations[0].input.filter(i => i.type === 'function_call_output').length, 2);
  assert.match(JSON.stringify(workspace()), /Hello from a new tool/);
  const usage = workspace().spaces[0].conversations[0].usage;
  assert.equal(usage.completedRequests, 3); assert.equal(usage.inputTokens, 3000); assert.equal(usage.cachedInputTokens, 2250);
  assert.equal(control('cache-usage', 'button').props.title, 'Cache: 75% · 750/1,000 input');
  click('cache-usage'); await until(() => text('Completed requests: 3 · usage reported: 3 · cache reported: 3\nReported totals (including summaries): 3,000 input · 2,250 cached input · 300 output.'), 'usage details');
  click('cache-usage');
  const counter = workspace().spaces.find(s => s.name === 'Counter'); assert.ok(counter);
  click(`space-${counter.id}`); await until(() => text('Counter: 0'), 'native custom space');
  test.request('debug.action', { id: snapshot().nodes.find(n => n.kind === 'button' && n.props.title === 'Increment').id });
  await until(() => text('Counter: 1'), 'native custom action');
  click('space-shell'); await until(() => text('Built from the inside. Your new tool and space are ready.'), 'return to conversation');
  await write('composer', 'An unsent persistent draft 🦊');
  const sourceFile = join(root, 'src/shell.ts'); const source = readFileSync(sourceFile, 'utf8');
  writeFileSync(sourceFile, 'broken syntax !!'); click('reload-shell');
  await until(() => snapshot().nodes.some(n => n.kind === 'text' && String(n.props.value).includes('Build failed')), 'bad source feedback');
  assert.ok(text('Changed from the inside.')); assert.ok(control('composer', 'texteditor'));
  writeFileSync(sourceFile, source); click('reload-shell');
  await until(() => text('Generation 3 is live · 9 TypeScript tools'), 'recovery');
  assert.equal(workspace().spaces[0].conversations[0].draft, 'An unsent persistent draft 🦊');
  const baseline = test.stats();
  for (let i = 0; i < 8; i++) {
    click('reload-shell'); await until(() => text(`Generation ${4 + i} is live · 9 TypeScript tools`), 'repeated replacement');
  }
  assert.deepEqual(test.stats(), baseline);
  writeFileSync(sourceFile, source.replace('return Shell();', 'throw new Error("test render failure");'));
  click('reload-shell');
  await until(() => snapshot().nodes.some(n => n.kind === 'text' && String(n.props.value).includes('test render failure')), 'rejected shell setup');
  assert.ok(text('Changed from the inside.'));
  writeFileSync(sourceFile, source.replace('return () => {\n      host.revision.value;', 'return () => {\n      host.revision.value; throw new Error("test nested render failure");'));
  click('reload-shell'); await until(() => text('The shell needs attention'), 'bootstrap render recovery');
  assert.ok(snapshot().nodes.some(n => n.kind === 'button' && n.props.title === 'Send to maintainer'));
  test.request('debug.action', { id: snapshot().nodes.find(n => n.kind === 'button' && n.props.title === 'Restore previous shell').id });
  await until(() => text('Changed from the inside.'), 'restore shell from render failure');
  click('toggle-source'); await until(() => text('Living source'), 'native source editor');
  assert.ok(control('source-editor', 'texteditor'));
  const layout = test.request('debug.layout'); assert.ok(layout.frames.length > 0);
  console.log('PASS native: real custom agent loop, worker tool composition, self-modified shell, runtime reload during a run, new tool, new native space, persistence, compile failure and recovery');
}
test.request('debug.close');
