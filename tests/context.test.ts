import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compact, compactablePrefix, contextPolicy, estimateTokens, expireToolResults, EXPIRED_RESULT, modelInput, COMPACT_REQUEST } from '../src/context.ts';
import { newConversation, Store } from '../src/storage.ts';
import { run } from '../src/agent.ts';
import type { AgentContext, Completion, WireItem } from '../src/contracts.ts';
const answer = (text = 'summary'): Completion => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], calls: [] });
function fixture(turns = 10): AgentContext {
  const conversation = newConversation();
  for (let turn = 1; turn <= turns; turn++) {
    conversation.input.push({ role: 'user', content: 'turn ' + turn },
      { type: 'reasoning', encrypted_content: 'opaque-' + turn, summary: [] },
      { type: 'function_call', call_id: 'call-' + turn, name: 'execute', arguments: '{"code":"return 1"}' },
      { type: 'function_call_output', call_id: 'call-' + turn, output: 'result-' + turn },
      ...answer('answer ' + turn).output);
    conversation.messages.push({ id: String(turn), role: 'user', text: 'visible ' + turn, at: '' });
  }
  return { conversation, signal: new AbortController().signal, save() {}, instructions: () => 'maintainer instructions',
    complete: async () => answer(), execute: async () => ({ result: null, logs: [] }),
    message(role, text, detail) { const m = { id: String(conversation.messages.length), role, text, detail, at: '' }; conversation.messages.push(m); return m; },
    update(message, text) { message.text = text; },
  };
}
test('expiration replaces results after exactly 8 subsequent USER turns, preserves call pairing and transcript', () => {
  const context = fixture(9), c = context.conversation;
  const transcript = structuredClone(c.messages), before = structuredClone(c.input);
  assert.equal(expireToolResults(c), true);
  assert.equal(c.input[3].output, EXPIRED_RESULT);
  assert.deepEqual(c.input.slice(5), before.slice(5));
  assert.deepEqual(c.input[2], before[2]); assert.deepEqual(c.messages, transcript);
  assert.equal(expireToolResults(c), false);
  // Arbitrarily many tool/model steps in the current user turn don't age history.
  c.input.push(...Array.from({ length: 50 }, () => answer().output[0]));
  assert.equal(expireToolResults(c), false);
});
test('compaction merges prior memory, preserves newest six full turns byte-for-byte, persists and leaves visible history intact', async t => {
  const context = fixture(), c = context.conversation;
  c.context = { summary: 'prior memory', compactedTurns: 3, requested: true };
  const cut = compactablePrefix(c.input), recent = structuredClone(c.input.slice(cut)), visible = structuredClone(c.messages);
  let calls = 0;
  context.complete = async (input, instructions) => {
    assert.match(instructions, /Do not call tools/);
    assert.match(String(input[0].content), /prior memory/);
    assert.doesNotMatch(String(input[0].content), /opaque-/);
    calls++; return answer('merged memory');
  };
  const directory = await mkdtemp(join(tmpdir(), 'context-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); store.workspace.spaces[0].conversations = [c]; context.save = () => store.save();
  assert.equal(await compact(context), true); assert.equal(calls, 1);
  assert.deepEqual(c.input, recent); assert.deepEqual(c.messages.slice(0, visible.length), visible);
  assert.equal(c.context.summary, 'merged memory'); assert.equal(c.context.compactedTurns, 7); assert.equal(c.context.requested, false);
  assert.match(String(modelInput(c)[0].content), /merged memory/);
  const loaded = new Store(directory).workspace.spaces[0].conversations[0];
  assert.deepEqual(loaded.context, c.context); assert.deepEqual(loaded.input, recent);
});
test('empty, oversized, tool-calling and failed summaries cannot delete context', async () => {
  for (const kind of ['empty', 'oversized', 'tool', 'failure']) {
    const context = fixture(), before = structuredClone(context.conversation);
    context.complete = async () => {
      if (kind === 'failure') throw Error('offline');
      if (kind === 'tool') return { output: [], calls: [{id:'bad',name:'execute',arguments:'{}'}] };
      return answer(kind === 'empty' ? '' : 'x'.repeat(contextPolicy.maxSummaryChars + 1));
    };
    await assert.rejects(compact(context)); assert.deepEqual(context.conversation, before);
  }
});
test('bounded incremental summaries commit only after every chunk succeeds; cancellation preserves source', async () => {
  const context = fixture(7), c = context.conversation;
  c.input[0].content = 'x'.repeat(contextPolicy.summaryChunkChars * 3);
  const before = structuredClone(c), controller = new AbortController(); context.signal = controller.signal;
  let calls = 0;
  context.complete = async input => {
    const payload = JSON.parse(String(input[0].content));
    assert.ok(payload.olderHistoryChunk.length <= contextPolicy.summaryChunkChars);
    if (++calls === 2) controller.abort();
    return answer('partial memory');
  };
  await assert.rejects(compact(context), /abort/i); assert.equal(calls, 2); assert.deepEqual(c, before);
});
test('compaction never splits a call/output crossing a user boundary', () => {
  const context = fixture(8), input = context.conversation.input;
  input.push({ type:'function_call_output', call_id:'call-1', output:'recovered' });
  assert.equal(compactablePrefix(input), 0);
});
test('automatic compaction retains context at 48k and immediately below the 800k threshold', async () => {
  assert.equal(contextPolicy.contextWindowTokens, 1_000_000);
  assert.equal(contextPolicy.contextWindowTokens * contextPolicy.triggerRatio, 800_000);
  for (const target of [48_000, 799_999]) {
    const context = fixture(7), c = context.conversation;
    const overhead = estimateTokens([modelInput(c), context.instructions()]) + 4_000;
    c.input[0].content += 'x'.repeat((target - overhead) * 3);
    assert.equal(estimateTokens([modelInput(c), context.instructions()]) + 4_000, target);
    const original = structuredClone(c.input);
    let normal = 0;
    context.complete = async (input, instructions) => {
      assert.ok(!instructions.startsWith('You are compacting'));
      assert.deepEqual(input, original);
      normal++; return answer('done');
    };
    await run(context); assert.equal(normal, 1); assert.equal(c.context?.summary, undefined);
  }
});
test('automatic compaction starts at 800k and passes summary plus intact recent turns', async () => {
  const context = fixture(9), c = context.conversation;
  const threshold = contextPolicy.contextWindowTokens * contextPolicy.triggerRatio;
  const overhead = estimateTokens([modelInput(c), context.instructions()]) + 4_000;
  c.input[0].content += 'x'.repeat((threshold - overhead) * 3);
  assert.equal(estimateTokens([modelInput(c), context.instructions()]) + 4_000, threshold);
  const recent = structuredClone(c.input.slice(compactablePrefix(c.input)));
  let summaries=0, normal=0;
  context.complete = async (input, instructions) => {
    if (instructions.startsWith('You are compacting')) { summaries++; return answer('bounded memory'); }
    normal++; assert.deepEqual(input.slice(1), recent); assert.match(String(input[0].content), /bounded memory/); return answer('done');
  };
  await run(context); assert.ok(summaries > 1); assert.equal(normal,1);
});
test('agent compaction request waits until every call in its batch has a durable result', async () => {
  const context = fixture(9), c=context.conversation; let normal=0, executions=0, summaries=0;
  const calls = ['request','other'].map(id => ({id,name:'execute',arguments:JSON.stringify({code:id})}));
  context.execute=async code => {executions++; return {result: code==='request' ? {request:COMPACT_REQUEST,queued:true} : 'done',logs:[]};};
  context.complete=async (_input,instructions) => {
    if(instructions.startsWith('You are compacting')) {
      summaries++; assert.equal(executions,2);
      assert.ok(c.input.some(i=>i.type==='function_call_output' && i.call_id==='other')); return answer();
    }
    if(normal++===0) return { output:calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:call.arguments})), calls };
    return answer('done');
  };
  await run(context); assert.equal(summaries,1); assert.equal(executions,2); assert.equal(c.context?.requested,false);
});
test('context overflow compacts once and retries only the model, without replaying any tools', async () => {
  const context=fixture(9); let normal=0, summaries=0;
  context.complete=async (_input,instructions) => {
    if(instructions.startsWith('You are compacting')) {summaries++;return answer();}
    if(normal++===0) throw Object.assign(Error('full'),{code:'context_length_exceeded'});
    return answer('done');
  };
  context.execute=async()=>assert.fail('no replay');
  await run(context);assert.equal(normal,2);assert.equal(summaries,1);
});
test('uncompactable recent context and ordinary failures are not retried or silently discarded', async () => {
  const context=fixture(6), before=structuredClone(context.conversation.input);let calls=0;
  context.complete=async()=>{calls++;throw Object.assign(Error('full'),{code:'context_length_exceeded'});};
  await assert.rejects(run(context),/protected recent turns/);assert.equal(calls,1);assert.deepEqual(context.conversation.input,before);
  context.complete=async()=>{throw Error('usage limit');};await assert.rejects(run(context),/usage limit/);
});


test('a failed durable commit restores in-memory input and summary', async () => {
  const context=fixture(), before=structuredClone(context.conversation);
  context.save=()=>{throw Error('disk full');};
  await assert.rejects(compact(context),/disk full/);
  assert.deepEqual(context.conversation,before);
});
test('repeated compaction merges memory while preserving newly protected turns', async () => {
  const context=fixture(8); await compact(context);
  const c=context.conversation, previous=c.context?.summary;
  c.input.push({role:'user',content:'new user 1'},...answer('new answer').output,{role:'user',content:'new user 2'});
  const recent=structuredClone(c.input.slice(compactablePrefix(c.input)));
  context.complete=async(input)=>{assert.match(String(input[0].content),new RegExp(previous!));return answer('second memory');};
  await compact(context);assert.equal(c.context?.compactedTurns,4);assert.equal(c.context?.summary,'second memory');assert.deepEqual(c.input,recent);
});
