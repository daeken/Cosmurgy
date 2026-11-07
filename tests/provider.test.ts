import test from 'node:test';
import assert from 'node:assert/strict';
import { events, Provider, promptCacheKey } from '../src/provider.ts';

function stream(text: string, chunk = 1): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk)); controller.close(); } });
}
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
test('SSE handles split UTF-8, CRLF, comments and multiline fields', async () => {
  const values = [];
  for await (const value of events(stream(': keepalive\r\n\r\ndata: {"text":\r\ndata: "café 🦊"}\r\n\r\n'))) values.push(value);
  assert.deepEqual(values, [{ text: 'café 🦊' }]);
});
test('subscription request uses namespaces and the required stateless streaming contract', async () => {
  let body: any; const deltas: string[] = [];
  const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'a', name: 'execute', arguments: '{"code":"return 1"}' }];
  const provider = new Provider({ token: async () => 'fake-test-token' }, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-test-token');
    return new Response(stream(sse({ type: 'response.output_text.delta', delta: 'Hi' }) + sse({ type: 'response.completed', response: { status: 'completed', output } })));
  });
  const result = await provider.complete('chosen-model', [{ role: 'user', content: 'hello' }], 'instructions', new AbortController().signal, text => deltas.push(text));
  assert.equal(Object.hasOwn(body, 'prompt_cache_retention'), false);
  assert.match(body.prompt_cache_key, /^cosmurgy:[a-f0-9]{48}$/);
  assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.equal(body.tools[0].type, 'namespace'); assert.equal(body.previous_response_id, undefined);
  assert.equal(body.max_output_tokens, undefined); assert.equal(body.model, 'chosen-model');
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(result.output, output); assert.deepEqual(deltas, ['Hi']); assert.equal(result.calls[0].id, 'a');
});
test('partial streams, incomplete output, and mid-stream usage limits never report success', async () => {
  for (const content of [sse({ type: 'response.output_text.delta', delta: 'partial' }),
    sse({ type: 'response.incomplete' }), sse({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })]) {
    const provider = new Provider({ token: async () => 'test' }, async () => new Response(stream(content)));
    await assert.rejects(provider.complete('test', [], '', new AbortController().signal, () => {}), /completion|incomplete|usage/);
  }
});
test('unauthorized request refreshes once and then surfaces a useful error', async () => {
  const refreshes: boolean[] = []; let requests = 0;
  const provider = new Provider({ token: async force => { refreshes.push(!!force); return 'test'; } }, async () => { requests++; return new Response('', { status: 401 }); });
  await assert.rejects(provider.models(), /Reconnect/); assert.equal(requests, 2); assert.deepEqual(refreshes, [false, true]);
});
test('models preserve the server ordering and use only visible account models', async () => {
  const provider = new Provider({ token: async () => 'test' }, async () => Response.json({ models: [
    { slug: 'b', display_name: 'Bee', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' },
    { slug: 'a', display_name: 'Aye', visibility: 'list' },
  ] }));
  assert.deepEqual(await provider.models(), [{ slug: 'b', name: 'Bee' }, { slug: 'a', name: 'Aye' }]);
});


test('HTTP and streamed context-limit errors are typed without exposing response bodies', async () => {
  const signal=new AbortController().signal;
  const responses = [
    () => Response.json({error:{code:'context_length_exceeded',message:'sensitive server body'}},{status:400}),
    () => new Response('large request body',{status:413}),
    () => new Response(stream(sse({type:'response.failed',response:{error:{code:'context_window_exceeded',message:'sensitive'}}}))),
    () => new Response(stream(sse({type:'response.incomplete',response:{incomplete_details:{reason:'context_length_exceeded'}}}))),
  ];
  for(const response of responses){
    const provider=new Provider({token:async()=>'test'},async()=>response());
    await assert.rejects(provider.complete('test',[],'',signal,()=>{}),(error: any)=>error.code==='context_length_exceeded' && !/sensitive|request body/.test(error.message));
  }
  const provider=new Provider({token:async()=>'test'},async()=>Response.json({error:{code:'invalid_tool'}},{status:400}));
  await assert.rejects(provider.complete('test',[],'',signal,()=>{}),(error:any)=>error.code==='invalid_tool' && /400/.test(error.message));
});


test('cache routing is stable across appended turns and provider restarts; scope/model/instructions isolate keys', async () => {
  const bodies:any[]=[];
  const fetcher:typeof fetch=async(_url,init)=>{
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(stream(sse({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:1000,output_tokens:10,total_tokens:1010,input_tokens_details:{cached_tokens:800}}}})));
  };
  const auth={token:async()=>'private-test-token'}, signal=new AbortController().signal;
  const provider=new Provider(auth,fetcher);
  const scope=JSON.stringify(['account-a','conversation-a']);
  const result=await provider.complete('test',[{role:'user',content:'hello'}],'stable prefix',signal,()=>{},{cacheScope:scope});
  await new Provider(auth,fetcher).complete('test',[{role:'user',content:'hello'},{role:'user',content:'next'}],'stable prefix',signal,()=>{},{cacheScope:scope});
  assert.equal(bodies[0].prompt_cache_key,bodies[1].prompt_cache_key);
  assert.equal(bodies[0].prompt_cache_key,promptCacheKey('test','stable prefix',scope));
  for(const [model,instructions,otherScope] of [['different','stable prefix',scope],['test','changed prefix',scope],['test','stable prefix','account-b/conversation-a'],['test','stable prefix','account-a/conversation-b']]) {
    assert.notEqual(promptCacheKey(model,instructions,otherScope),bodies[0].prompt_cache_key);
  }
  assert.doesNotMatch(bodies[0].prompt_cache_key,/account|conversation|private-test-token|hello|stable prefix/);
  assert.deepEqual(result.usage,{inputTokens:1000,outputTokens:10,totalTokens:1010,cachedInputTokens:800});
});
test('subscription requests omit unsupported retention overrides while keeping cache routing and usage', async () => {
  let body:any;
  const auth={token:async()=>'test'};
  const fetcher:typeof fetch=async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(stream(sse({type:'response.completed',response:{status:'completed',output:[]}})));};
  const provider=new Provider(auth,fetcher);
  const result=await provider.complete('test',[],'',new AbortController().signal,()=>{});
  assert.equal(Object.hasOwn(body,'prompt_cache_retention'),false);
  assert.match(body.prompt_cache_key,/^cosmurgy:/);assert.equal(body.store,false);assert.equal(result.usage,undefined);
});

test('subscription detail errors identify unsupported parameters instead of hiding them behind 400', async () => {
  const provider=new Provider({token:async()=>'test'},async()=>Response.json({detail:'Unsupported parameter: prompt_cache_retention'},{status:400}));
  await assert.rejects(provider.complete('test',[],'',new AbortController().signal,()=>{}),
    (error:any)=>error.status===400 && error.param==='prompt_cache_retention' && /Unsupported parameter: prompt_cache_retention/.test(error.message));
});

test('structured validation errors expose only parameter/code, never echoed inputs or HTML', async () => {
  const signal=new AbortController().signal;
  const bodies=[{error:{code:'invalid_request_error',param:'input[2].content',message:'private prompt and access-token'}},
    {detail:'private prompt and access-token'}, {error:{code:'private prompt and access-token',param:'<script>private</script>',message:'private'}}];
  for(const body of bodies){
    const provider=new Provider({token:async()=>'test'},async()=>Response.json(body,{status:400}));
    await assert.rejects(provider.complete('test',[],'',signal,()=>{}),(error:any)=>{
      assert.match(error.message,/400/);assert.doesNotMatch(error.message,/private|access-token|<script>/);
      if(typeof body.error==='object' && body.error.code==='invalid_request_error'){
        assert.equal(error.code,'invalid_request_error');assert.equal(error.param,'input[2].content');
      }
      return true;
    });
  }
  const provider=new Provider({token:async()=>'test'},async()=>new Response('<html>private server data</html>',{status:400}));
  await assert.rejects(provider.complete('test',[],'',signal,()=>{}),(error:any)=>/400/.test(error.message)&&!/private|html/.test(error.message));
});
