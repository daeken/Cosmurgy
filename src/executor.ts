import { Worker } from 'node:worker_threads';
import { transform } from 'esbuild';
import type { ExecuteResult, Tool, ToolContext } from './contracts.ts';

/** Workers keep arbitrary TypeScript/CPU loops off the native UI's Node thread. */
export async function execute(code: string, registry: ReadonlyMap<string, Tool>, context: ToolContext,
  timeoutMs = 60_000, workerURL = new URL('./executor-worker.ts', import.meta.url)): Promise<ExecuteResult> {
  context.signal.throwIfAborted();
  const { code: javascript } = await transform(`export default async function(tools, console) {\n${code}\n}`, {
    loader: 'ts', format: 'esm', target: 'node24', sourcefile: 'agent-execution.ts',
  });
  context.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerURL, { workerData: { javascript } });
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const calls = new Set<Promise<void>>(); const logs: string[] = [];
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(timer); context.signal.removeEventListener('abort', abort);
      controller.abort(); void worker.terminate();
      // Cooperative tools stop before the execution is considered finished.
      void Promise.allSettled([...calls]).then(() => {
        if (error) reject(error); else resolve({ result: value ?? null, logs });
      });
    };
    const abort = () => finish(new Error('Execution stopped. Completed side effects have been preserved.'));
    const timer = setTimeout(() => finish(new Error(`TypeScript execution exceeded ${timeoutMs / 1000} seconds.`)), timeoutMs);
    context.signal.addEventListener('abort', abort, { once: true });
    worker.on('error', finish);
    worker.on('exit', code => { if (!settled) finish(new Error(`TypeScript worker exited before returning a result (${code}).`)); });
    worker.on('message', (message: { type: string; name: string; args: unknown; id: number; text: string; value: unknown; error: string }) => {
      if (settled) return;
      if (message.type === 'log') { logs.push(message.text); return; }
      if (message.type === 'result') { finish(undefined, message.value); return; }
      if (message.type === 'error') { finish(new Error(message.error)); return; }
      if (message.type === 'tool') {
        const task = (async () => {
          try {
            signal.throwIfAborted();
            const tool = registry.get(message.name);
            if (!tool) throw new Error(`Unknown tool '${message.name}'. Reload tools after adding its module.`);
            const value = await tool.run(message.args, { ...context, signal });
            if (!settled) worker.postMessage({ id: message.id, value });
          } catch (error) {
            if (!settled) worker.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
          }
        })();
        calls.add(task); void task.finally(() => calls.delete(task));
      }
    });
    if (context.signal.aborted) abort();
  });
}
