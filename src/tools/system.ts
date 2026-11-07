import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Tool, ToolContext } from '../contracts.ts';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an argument object.');
  return value as Record<string, unknown>;
}
function string(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`${key} must be a string.`);
  return args[key];
}
const path = (context: ToolContext, value: string) => resolve(context.root, value);
export const tools: Tool[] = [
  { name: 'readFile', description: 'Read a UTF-8 file. Paths are relative to the Cosmurgy checkout or absolute.',
    signature: '(args: { path: string }) => Promise<string>',
    async run(value, context) { return (await readFile(path(context, string(record(value), 'path')), { encoding: 'utf8', signal: context.signal })).slice(0, 100_000); } },
  { name: 'writeFile', description: 'Write a UTF-8 file, creating parent directories. Call reload after changing shell, runtime, or tools.',
    signature: '(args: { path: string; content: string }) => Promise<string>',
    async run(value, context) {
      const args = record(value); const file = path(context, string(args, 'path')); context.signal.throwIfAborted();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, string(args, 'content'), { signal: context.signal }); return `Wrote ${file}`;
    } },
  { name: 'listFiles', description: 'List a directory, including whether each entry is a directory.',
    signature: '(args: { path?: string }) => Promise<{name: string; directory: boolean}[]>',
    async run(value, context) {
      const args = record(value); context.signal.throwIfAborted();
      const directory = typeof args.path === 'string' ? args.path : '.';
      return (await readdir(path(context, directory), { withFileTypes: true })).map(item => ({ name: item.name, directory: item.isDirectory() }));
    } },
  { name: 'runCommand', description: 'Run a shell command with full local user access. Output is capped; cancellation stops the process group. Default timeout: 30 seconds.',
    signature: '(args: { command: string; cwd?: string; timeoutMs?: number }) => Promise<{code: number | null; stdout: string; stderr: string}>',
    async run(value, context) {
      const args = record(value); const command = string(args, 'command');
      const timeout = typeof args.timeoutMs === 'number' ? Math.max(1, Math.min(args.timeoutMs, 300_000)) : 30_000;
      context.signal.throwIfAborted();
      return new Promise((resolveResult, reject) => {
        const child = spawn('/bin/zsh', ['-lc', command], { cwd: path(context, typeof args.cwd === 'string' ? args.cwd : '.'),
          detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = ''; let timedOut = false; let escalation: ReturnType<typeof setTimeout> | undefined;
        child.stdout.on('data', data => { stdout += String(data).slice(0, Math.max(0, 30_000 - stdout.length)); });
        child.stderr.on('data', data => { stderr += String(data).slice(0, Math.max(0, 15_000 - stderr.length)); });
        const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
        const stop = () => { kill('SIGTERM'); escalation ??= setTimeout(() => kill('SIGKILL'), 500); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
        context.signal.addEventListener('abort', stop, { once: true });
        const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); context.signal.removeEventListener('abort', stop); };
        child.on('error', error => { cleanup(); reject(error); });
        child.on('close', code => {
          cleanup();
          if (context.signal.aborted) reject(new Error('Command stopped.'));
          else if (timedOut) reject(new Error(`Command exceeded ${timeout} ms. ${stderr}`));
          else resolveResult({ code, stdout, stderr });
        });
        if (context.signal.aborted) stop();
      });
    } },
  { name: 'reload', description: 'Compile and replace shell, runtime, space views and tools. Conversations and active agent work survive. Invalid generations leave the previous generation usable.',
    signature: '() => Promise<string>', async run(_args, context) { context.signal.throwIfAborted(); return context.reload(); } },
  { name: 'createSpace', description: 'Create a persistent space, its resource directory, and a conversation with its maintainer. Optionally supply a TypeScript view module exporting createView(host).',
    signature: '(args: { name: string; purpose: string; viewSource?: string }) => Promise<string>',
    async run(value, context) {
      const args = record(value); context.signal.throwIfAborted();
      const name = string(args, 'name'); const purpose = string(args, 'purpose');
      return context.createSpace(name, purpose, typeof args.viewSource === 'string' ? args.viewSource : undefined);
    } },
  { name: 'spaceDirectory', description: 'Get the current space’s owned resource directory. Other paths remain accessible.',
    signature: '() => Promise<string>', run(_args, context) { return join(context.dataDir, 'spaces', context.spaceId); } },
];
