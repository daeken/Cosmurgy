import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort!;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
port.on('message', (message: { id: number; value?: unknown; error?: string }) => {
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
});
const tools = new Proxy(Object.create(null), { get: (_target, name) => {
  if (typeof name !== 'string' || name === 'then') return undefined;
  return (args: unknown = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    port.postMessage({ type: 'tool', id, name, args });
  });
} });
let logBytes = 0;
const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...values: unknown[]) => {
  const text = values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
  if (logBytes < 20_000) { port.postMessage({ type: 'log', text: text.slice(0, 20_000 - logBytes) }); logBytes += text.length; }
}]));
try {
  const module = await import(`data:text/javascript;base64,${Buffer.from(workerData.javascript).toString('base64')}`);
  const result = await module.default(tools, console);
  port.postMessage({ type: 'result', value: result ?? null });
} catch (error) {
  port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
}
