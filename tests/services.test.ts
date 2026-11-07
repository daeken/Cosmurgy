import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServiceSlot, validateServices, discardServices } from '../src/service-slot.ts';
import { watchSources, sourceFingerprint } from '../src/source-watch.ts';
import { Generations } from '../src/generations.ts';
import { newConversation } from '../src/storage.ts';
import type { RuntimeServices, ServiceDependencies } from '../src/contracts.ts';
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {resolve,promise}; }
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){for(let i=0;i<250;i++){if(fn())return;await pause(10);}assert.fail('condition timed out');}
function fake(version:string, dispose:()=>void|Promise<void>=()=>{}):RuntimeServices {
  return {models:async()=>[{slug:version,name:version}],complete:async()=>({output:[],calls:[]}),execute:async()=>({result:version,logs:[]}),dispose};
}
async function directory(t:test.TestContext){const p=await mkdtemp(join(tmpdir(),'services-test-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('in-flight leases finish on the old instance, subsequent operations use new services, disposal waits for all leases',async()=>{
  const slot=new ServiceSlot(), gate=deferred<void>();let oldDisposed=0,newDisposed=0;
  slot.install(fake('old',()=>{oldDisposed++;}));
  const a=slot.use(async s=>{await gate.promise;return (await s.models())[0].slug;});
  const b=slot.use(async s=>{await gate.promise;return (await s.models())[0].slug;});
  slot.install(fake('new',()=>{newDisposed++;}));await pause(5);assert.equal(oldDisposed,0);
  assert.equal(await slot.use(async s=>(await s.models())[0].slug),'new');
  gate.resolve();assert.deepEqual(await Promise.all([a,b]),['old','old']);await until(()=>oldDisposed===1);
  await slot.close();assert.equal(newDisposed,1);assert.equal(oldDisposed,1);
  await assert.rejects(slot.use(s=>s.models()),/No active/);
});
test('invalid services do not replace the working generation; operation failures still release leases',async()=>{
  const slot=new ServiceSlot();let disposed=0;slot.install(fake('old',()=>{disposed++;}));
  assert.throws(()=>slot.install({} as RuntimeServices),/Services must/);
  assert.equal(await slot.use(async s=>(await s.models())[0].slug),'old');
  await assert.rejects(slot.use(()=>{throw Error('operation failed');}),/operation failed/);
  await slot.close();assert.equal(disposed,1);
});
test('retirement cleanup failures are reported without undoing activation or masking operation results',async()=>{
  const errors:unknown[]=[],slot=new ServiceSlot(error=>errors.push(error));
  slot.install(fake('old',()=>{throw Error('cleanup failed');}));slot.install(fake('new'));
  assert.equal(await slot.use(async s=>(await s.models())[0].slug),'new');
  await slot.close();assert.equal(errors.length,1);
  let discarded=0;await discardServices(fake('candidate',()=>{discarded++;}));assert.equal(discarded,1);
  assert.throws(()=>validateServices({...fake('bad'),dispose:1} as any),/Services must/);
});
test('closing waits for active leases and does not allow activation or new operations',async()=>{
  const slot=new ServiceSlot(),gate=deferred<void>();let disposed=0,closed=false;slot.install(fake('old',()=>{disposed++;}));
  const operation=slot.use(async()=>{await gate.promise;return 7;});
  const closing=slot.close().then(()=>{closed=true;});await pause(5);assert.equal(closed,false);assert.equal(disposed,0);
  assert.throws(()=>slot.install(fake('new')),/shutdown/);gate.resolve();assert.equal(await operation,7);await closing;assert.equal(disposed,1);
});
test('generation-bundled services and worker run, and usage recording changes without recreating host auth',async t=>{
  const path=await directory(t),loader=new Generations(process.cwd(),join(path,'generations'));
  const workerURL=await loader.compile('src/executor-worker.ts');
  const module=await loader.load<{createServices(d:ServiceDependencies):RuntimeServices}>('src/services.ts');
  let tokens=0;const auth={token:async()=>{tokens++;return 'test';}};
  const deps:ServiceDependencies={auth,workerURL,cacheRetention:'24h',fetcher:async()=>new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:100,output_tokens:1,total_tokens:101,input_tokens_details:{cached_tokens:90}}}})+'\n\n')};
  const service=module.createServices(deps),conversation=newConversation();let saves=0;
  const request={conversation,model:'test',input:[],instructions:'instructions',signal:new AbortController().signal,onDelta(){},cacheScope:'test',save(){saves++;}};
  await service.complete(request);assert.equal(tokens,1);assert.equal(saves,1);assert.equal(conversation.usage?.cachedInputTokens,90);
  const result=await service.execute('return 42;',new Map(),{root:path,dataDir:path,spaceId:'test',signal:request.signal,reload:async()=>'',createSpace:()=>''});
  assert.deepEqual(result,{result:42,logs:[]});
});
test('compiled workers are immutable generation snapshots',async t=>{
  const path=await directory(t);await writeFile(join(path,'worker.ts'),"import {parentPort} from 'node:worker_threads';parentPort.postMessage('old');");
  const loader=new Generations(path,join(path,'built')),old=await loader.compile('worker.ts');
  await writeFile(join(path,'worker.ts'),"import {parentPort} from 'node:worker_threads';parentPort.postMessage('new');");const next=await loader.compile('worker.ts');
  const {Worker}=await import('node:worker_threads');
  async function run(url:URL){const worker=new Worker(url);t.after(()=>worker.terminate());return await new Promise(r=>worker.once('message',r));}
  assert.equal(await run(old),'old');assert.equal(await run(next),'new');
});
test('source fingerprints detect edits/additions/deletions but ignore persistent non-source content',async t=>{
  const path=await directory(t);await writeFile(join(path,'a.ts'),'old');const a=await sourceFingerprint([path]);
  await writeFile(join(path,'data.json'),'{}');assert.equal(await sourceFingerprint([path]),a);
  await writeFile(join(path,'a.ts'),'new');assert.notEqual(await sourceFingerprint([path]),a);
  await writeFile(join(path,'b.ts'),'new');const b=await sourceFingerprint([path]);await rm(join(path,'b.ts'));assert.notEqual(await sourceFingerprint([path]),b);
});
test('watcher debounces saves, serializes reloads, queues edits during builds, recovers after errors and stops cleanly',async t=>{
  const path=await directory(t),file=join(path,'service.ts');await writeFile(file,'one');
  let calls=0,active=0,maxActive=0;const gate=deferred<void>(),errors:unknown[]=[];
  const watcher=watchSources({roots:[{path}],foundation:new Set(),debounceMs:30,restartRequired(){assert.fail('not foundation');},report:e=>errors.push(e),reload:async()=>{
    calls++;active++;maxActive=Math.max(maxActive,active);try {if(calls===1)await gate.promise;else if(calls===2)throw Error('bad syntax');}finally{active--;}
  }});t.after(()=>watcher.close());
  await writeFile(file,'two');await until(()=>calls===1);
  await writeFile(file,'three');await pause(60);assert.equal(calls,1);gate.resolve();await until(()=>calls===2&&errors.length===1);
  await writeFile(file,'fixed');await until(()=>calls===3);assert.equal(maxActive,1);
  watcher.close();await writeFile(file,'after-close');await pause(100);assert.equal(calls,3);
});
test('foundation edits report restart-required without automatically reloading',async t=>{
  const path=await directory(t),file=join(path,'app.ts');await writeFile(file,'one');let restarts=0,reloads=0;
  const watcher=watchSources({roots:[{path}],foundation:new Set([file]),debounceMs:20,report:e=>assert.fail(String(e)),restartRequired:()=>{restarts++;},reload:async()=>{reloads++;}});t.after(()=>watcher.close());
  await writeFile(file,'two');await until(()=>restarts>0);await pause(70);assert.equal(reloads,0);
});
