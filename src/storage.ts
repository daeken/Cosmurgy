import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Conversation, Workspace } from './contracts.ts';

export function atomicJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
export function readJSON<T>(path: string, fallback: () => T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw new Error(`Cannot read ${path}; the original file has been left untouched.`, { cause: error });
  }
}
export function newConversation(title = 'A new conversation'): Conversation {
  return { id: randomUUID(), title, draft: '', messages: [], input: [], run: 'idle' };
}
function initialWorkspace(): Workspace {
  const shell = newConversation('Building from the inside');
  return {
    version: 1, selectedSpace: 'shell', selectedConversation: shell.id, model: '',
    spaces: [{ id: 'shell', name: 'Shell', purpose: 'Build and maintain the Cosmurgy environment and its native interface.',
      maintainer: 'Shell maintainer', conversations: [shell] }],
  };
}
export class Store {
  readonly path: string;
  readonly workspace: Workspace;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, 'workspace.json');
    this.workspace = readJSON(this.path, initialWorkspace);
    if (this.workspace.version !== 1 || !Array.isArray(this.workspace.spaces) || !this.workspace.spaces.length) {
      throw new Error('Unsupported workspace format; data has been left untouched.');
    }
    for (const space of this.workspace.spaces) {
      mkdirSync(join(directory, 'spaces', space.id), { recursive: true });
      for (const conversation of space.conversations) {
        if (conversation.run === 'running') {
          conversation.run = 'interrupted';
          conversation.messages.push({ id: randomUUID(), role: 'notice', at: new Date().toISOString(),
            text: 'This run was interrupted. Its recorded work is preserved; send a message to continue. Unfinished actions are not replayed.' });
        }
      }
    }
    this.save();
  }
  save(): void { atomicJSON(this.path, this.workspace); }
}

/** One writer owns a workspace and its rotating OAuth credentials at a time. */
export function acquireLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'session.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid)); closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      try { process.kill(pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH' && pid > 0) { rmSync(path); continue; }
      }
      throw new Error('Cosmurgy is already using this workspace. Close its other window first.');
    }
  }
  throw new Error('Could not acquire the workspace lock.');
}
