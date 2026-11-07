import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, recordUsage, cacheStatus, usageDetails } from '../src/usage.ts';
import { newConversation, Store } from '../src/storage.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const raw = { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 750 }, secret: 'not copied' };
test('usage copies only validated counters and distinguishes unknown cache from zero', () => {
  assert.deepEqual(parseUsage(raw), { inputTokens:1000,outputTokens:100,totalTokens:1100,cachedInputTokens:750 });
  assert.equal(parseUsage(undefined),undefined);
  assert.equal(parseUsage({input_tokens:-1,output_tokens:1,total_tokens:0}),undefined);
  assert.equal(parseUsage({...raw,input_tokens:'1000'}),undefined);
  assert.equal(parseUsage({...raw,input_tokens:Infinity}),undefined);
  assert.equal(parseUsage({...raw,output_tokens:1.5}),undefined);
  for(const cached of [undefined,-1,1001,'750',NaN]) {
    assert.equal(parseUsage({...raw,input_tokens_details:{cached_tokens:cached}})?.cachedInputTokens,undefined);
  }
  assert.equal(parseUsage({...raw,input_tokens_details:{cached_tokens:0}})?.cachedInputTokens,0);
});
test('cache UI shows actual last-request coverage, never an invented cache miss', () => {
  const c=newConversation();assert.match(cacheStatus(c),/awaiting/);
  recordUsage(c,parseUsage(raw),'test','conversation');assert.equal(cacheStatus(c),'Cache: 75% · 750/1,000 input');
  recordUsage(c,undefined,'test','conversation');assert.equal(cacheStatus(c),'Cache: usage not reported');
  recordUsage(c,parseUsage({...raw,input_tokens_details:{}}),'test','conversation');assert.equal(cacheStatus(c),'Cache: not reported · 1,000 input');
  recordUsage(c,parseUsage({...raw,input_tokens_details:{cached_tokens:0}}),'test','compaction');assert.match(cacheStatus(c),/^Summary cache: 0%/);
  assert.equal(c.usage?.completedRequests,4);assert.equal(c.usage?.reportedRequests,3);assert.equal(c.usage?.cacheReportedRequests,2);
  assert.equal(c.usage?.inputTokens,3000);assert.equal(c.usage?.cachedInputTokens,750);assert.equal(c.usage?.outputTokens,300);
  assert.match(usageDetails(c),/including summaries/);
});
test('usage persists without touching model input, and conversations are isolated', async t => {
  const directory=await mkdtemp(join(tmpdir(),'cache-usage-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(directory), c=store.workspace.spaces[0].conversations[0];
  c.input.push({role:'user',content:'hello'});const before=structuredClone(c.input);
  recordUsage(c,parseUsage(raw),'test','conversation');store.save();
  assert.deepEqual(c.input,before);
  assert.deepEqual(new Store(directory).workspace.spaces[0].conversations[0].usage,c.usage);
  assert.equal(newConversation().usage,undefined);
});
