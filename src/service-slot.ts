import type { RuntimeServices } from './contracts.ts';

export function validateServices(value: RuntimeServices): void {
  if (!value || !['models', 'complete', 'execute'].every(name => typeof (value as any)[name] === 'function')
    || (value.dispose !== undefined && typeof value.dispose !== 'function')) {
    throw new Error('Services must provide models(), complete(), execute(), and an optional dispose().');
  }
}
export async function discardServices(value: RuntimeServices | undefined): Promise<void> {
  if (typeof value?.dispose === 'function') await value.dispose();
}
interface Entry {
  value: RuntimeServices; users: number; retired: boolean; disposing: boolean;
  done: Promise<void>; finish(): void;
}
/** Stable indirection. Never mutate an instance that an in-flight operation owns. */
export class ServiceSlot {
  private current?: Entry;
  private entries = new Set<Entry>();
  private closed = false;
  private report: (error: unknown) => void;
  constructor(report: (error: unknown) => void = () => {}) { this.report = report; }
  get available(): boolean { return !!this.current && !this.closed; }
  install(value: RuntimeServices): void {
    validateServices(value);
    if (this.closed) throw new Error('Cannot activate services after shutdown.');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const next = { value, users: 0, retired: false, disposing: false, done, finish };
    const old = this.current;
    this.entries.add(next); this.current = next;
    if (old) { old.retired = true; this.collect(old); }
  }
  async use<T>(operation: (services: RuntimeServices) => T | Promise<T>): Promise<T> {
    const entry = this.current;
    if (!entry || this.closed) throw new Error('No active service generation. Reload a working generation first.');
    entry.users++;
    try { return await operation(entry.value); }
    finally { entry.users--; this.collect(entry); }
  }
  private collect(entry: Entry): void {
    if (!entry.retired || entry.users || entry.disposing) return;
    entry.disposing = true;
    void Promise.resolve().then(() => discardServices(entry.value)).catch(error => {
      try { this.report(error); } catch { /* Cleanup errors must not reject activation or mask completed work. */ }
    }).finally(() => { this.entries.delete(entry); entry.finish(); });
  }
  async close(): Promise<void> {
    this.closed = true; this.current = undefined;
    const entries = [...this.entries];
    for (const entry of entries) { entry.retired = true; this.collect(entry); }
    await Promise.all(entries.map(entry => entry.done));
  }
}
