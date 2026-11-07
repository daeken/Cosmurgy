import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, acquireLock } from '../src/storage.ts';
import { execute } from '../src/executor.ts';
import { Generations } from '../src/generations.ts';
import { loadTools } from '../src/tool-registry.ts';
import { run } from '../src/agent.ts';
import { tools as builtins } from '../src/tools/system.ts';
import type { AgentContext, Completion, Message, ToolContext } from '../src/contracts.ts';

async function temporary(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'cosmurgy-test-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function toolContext(root: string, signal = new AbortController().signal): ToolContext {
  return { root, dataDir: root, spaceId: 'shell', signal, reload: async () => 'reloaded', createSpace: () => 'space' };
}
test('conversations, drafts, tool history and interrupted runs survive reopening', async t => {
  const directory = await temporary(t); const first = new Store(directory);
  const conversation = first.workspace.spaces[0].conversations[0];
  conversation.draft = 'Unsent café 🦊'; conversation.input.push({ role: 'user', content: 'hello' });
  conversation.run = 'running'; first.save();
  const second = new Store(directory); const recovered = second.workspace.spaces[0].conversations[0];
  assert.equal(recovered.draft, 'Unsent café 🦊'); assert.equal(recovered.run, 'interrupted');
  assert.deepEqual(recovered.input, conversation.input); assert.match(recovered.messages[0].text, /not replayed/);
  assert.equal(new Store(directory).workspace.spaces[0].conversations[0].messages.length, 1);
});
test('corrupt workspace is never silently reset', async t => {
  const directory = await temporary(t); await writeFile(join(directory, 'workspace.json'), '{broken');
  assert.throws(() => new Store(directory), /left untouched/);
  assert.equal(await readFile(join(directory, 'workspace.json'), 'utf8'), '{broken');
});
test('workspace lock excludes a second writer and releases cleanly', async t => {
  const directory = await temporary(t); const unlock = acquireLock(directory);
  assert.throws(() => acquireLock(directory), /already using/); unlock(); acquireLock(directory)();
});
test('TypeScript composes registered tools concurrently with logs and Node imports', async t => {
  const directory = await temporary(t);
  const registry = new Map(builtins.map(tool => [tool.name, tool]));
  const result = await execute(`
    const paths: string[] = ['a.txt', 'b.txt'];
    await Promise.all(paths.map(path => tools.writeFile({ path, content: path })));
    console.log('created', paths.length);
    const fs = await import('node:fs/promises');
    return { contents: await Promise.all(paths.map(path => tools.readFile({path}))),
      files: (await fs.readdir(${JSON.stringify(directory)})).length };
  `, registry, toolContext(directory));
  assert.deepEqual(result.result, { contents: ['a.txt', 'b.txt'], files: 2 });
  assert.deepEqual(result.logs, ['created 2']);
});
test('unknown tool and compilation errors become execution failures', async t => {
  const directory = await temporary(t);
  await assert.rejects(execute('return await tools.missing({});', new Map(), toolContext(directory)), /Unknown tool/);
  await assert.rejects(execute('const x: =', new Map(), toolContext(directory)), /Transform failed/);
});
test('an infinite TypeScript loop is terminated without blocking the host', async t => {
  const directory = await temporary(t); let responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 30);
  await assert.rejects(execute('while (true) {}', new Map(), toolContext(directory), 120), /exceeded/);
  clearTimeout(timer); assert.equal(responsive, true);
});
test('execution cancellation aborts cooperative tools and waits for cleanup', async t => {
  const directory = await temporary(t); const controller = new AbortController(); let cleaned = false;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const registry = new Map([['wait', { name: 'wait', description: 'wait', signature: '()',
    run: async (_args: unknown, context: ToolContext) => new Promise<void>((resolve) => {
      started(); context.signal.addEventListener('abort', () => { cleaned = true; resolve(); }, { once: true });
    }) }]]);
  const promise = execute('return await tools.wait();', registry, toolContext(directory, controller.signal));
  await ready; controller.abort(); await assert.rejects(promise, /stopped/); assert.equal(cleaned, true);
});
test('tool modules and their imported dependencies can be replaced without restart', async t => {
  const directory = await temporary(t); await mkdir(join(directory, 'src/tools'), { recursive: true });
  await writeFile(join(directory, 'src/value.ts'), 'export const value = 3;');
  const file = join(directory, 'src/tools/count.ts');
  await writeFile(file, `import {value} from '../value.ts'; export default {name:'count',description:'count',signature:'()',run:()=>value};`);
  const loader = new Generations(directory, join(directory, '.generations'));
  const first = await loadTools(loader);
  await writeFile(join(directory, 'src/value.ts'), 'export const value = 7;');
  const second = await loadTools(loader);
  assert.equal(await first.get('count')!.run({}, toolContext(directory)), 3);
  assert.equal(await second.get('count')!.run({}, toolContext(directory)), 7);
  await writeFile(file, 'broken syntax !');
  await assert.rejects(loadTools(loader));
  assert.equal(await second.get('count')!.run({}, toolContext(directory)), 7);
});
function agentContext(completions: Completion[]): AgentContext {
  const conversation = { id: 'test', title: 'Test', draft: '', messages: [] as Message[], input: [] as Record<string, unknown>[], run: 'running' as const };
  return { conversation, signal: new AbortController().signal, instructions: () => 'instructions', save() {},
    complete: async () => { const completion = completions.shift(); assert.ok(completion); return completion; },
    execute: async code => ({ result: code, logs: [] }),
    message(role, text, detail) { const message = { id: String(conversation.messages.length), role, text, detail, at: '' }; conversation.messages.push(message); return message; },
    update(message, text) { message.text = text; },
  };
}
test('custom agent loop preserves complete reasoning/tool items and tool results', async () => {
  const reasoning = { type: 'reasoning', encrypted_content: 'opaque' };
  const call = { type: 'function_call', call_id: 'call-1', name: 'execute', arguments: '{"code":"return 1;"}' };
  const context = agentContext([
    { output: [reasoning, call], calls: [{ id: 'call-1', name: 'execute', arguments: String(call.arguments) }] },
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }], calls: [] },
  ]);
  await run(context);
  assert.deepEqual(context.conversation.input.slice(0, 2), [reasoning, call]);
  assert.equal(context.conversation.input[2].type, 'function_call_output');
  assert.equal(context.conversation.messages.at(-1)?.text, 'Done.');
});
test('a restart closes dangling calls without replaying side effects', async () => {
  const context = agentContext([{ output: [], calls: [] }]);
  context.conversation.input.push({ type: 'function_call', call_id: 'unfinished' });
  context.execute = async () => { assert.fail('must not replay'); };
  await run(context);
  assert.equal(context.conversation.input[1].call_id, 'unfinished');
  assert.match(String(context.conversation.input[1].output), /interrupted/);
});
test('bad tool arguments are returned to the model for correction', async () => {
  const context = agentContext([{ output: [], calls: [{ id: 'bad', name: 'execute', arguments: '{}' }] }, { output: [], calls: [] }]);
  await run(context); assert.match(String(context.conversation.input[0].output), /TypeScript code string/);
});
