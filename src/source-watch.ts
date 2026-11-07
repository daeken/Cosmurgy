import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';

/** Detect edits during a multi-module candidate build; never publish a mixed snapshot. */
export async function sourceFingerprint(roots: string[]): Promise<string> {
  const hash = createHash('sha256');
  const files = new Set<string>();
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name) || extname(entry.name) === '.ts') await visit(join(path, entry.name));
      }
    } else if (!info.isSymbolicLink() && extname(path) === '.ts') files.add(resolve(path));
  }
  for (const root of roots) await visit(root);
  for (const path of [...files].sort()) { hash.update(path); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
  return hash.digest('hex');
}
export interface WatchOptions {
  roots: { path: string; recursive?: boolean }[];
  foundation: ReadonlySet<string>;
  reload(): Promise<unknown>;
  restartRequired(path: string): void;
  report(error: unknown): void;
  debounceMs?: number;
}
/** Debounced, single-flight auto activation; changes during a build queue another pass. */
export function watchSources(options: WatchOptions): { close(): void } {
  let closed = false, pending = false, running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  const report = (error: unknown) => { if (!closed) options.report(error); };
  function schedule() {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void flush(); }, options.debounceMs ?? 400);
    timer.unref();
  }
  async function flush() {
    if (closed || running || !pending) return;
    running = true; pending = false;
    try { await options.reload(); } catch (error) { report(error); }
    finally { running = false; if (pending && !closed && !timer) schedule(); }
  }
  for (const root of options.roots) {
    try {
      const watcher = watch(root.path, { recursive: root.recursive ?? true, persistent: false }, (_event, filename) => {
        if (closed) return;
        if (!filename) { pending = true; schedule(); return; }
        const path = resolve(root.path, String(filename));
        if (options.foundation.has(path)) { options.restartRequired(path); return; }
        if (extname(path) !== '.ts') return;
        pending = true; schedule();
      });
      watcher.on('error', report); watchers.push(watcher);
    } catch (error) { report(error); }
  }
  return { close() {
    if (closed) return;
    closed = true; pending = false;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  } };
}
