import { Button, Divider, ForEach, ScrollView, State, Text, TextEditor, View, VStack, runApp } from 'jonui';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Auth } from './auth.ts';
import { ServiceSlot, validateServices, discardServices } from './service-slot.ts';
import { sourceFingerprint, watchSources } from './source-watch.ts';
import { Store, acquireLock, newConversation } from './storage.ts';
import { Generations } from './generations.ts';
import { loadTools } from './tool-registry.ts';
import type { AgentContext, Conversation, Message, Model, ShellHost, Tool, ToolContext, RuntimeServices, ServiceDependencies } from './contracts.ts';

const root = resolve(process.env.COSMURGY_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
const dataDir = resolve(process.env.COSMURGY_DATA_DIR ?? join(root, '.cosmurgy'));
const configDir = resolve(process.env.COSMURGY_CONFIG_DIR ?? join(homedir(), '.config', 'cosmurgy'));
const unlock = acquireLock(configDir);
const store = new Store(dataDir);
const auth = new Auth(configDir);
// Native integration uses a local scripted model, never a live subscription.
const testEndpoint = process.env.JONUI_TEST === '1' ? process.env.COSMURGY_TEST_MODEL_ENDPOINT : undefined;
if (testEndpoint && new URL(testEndpoint).hostname !== '127.0.0.1') throw new Error('The native test endpoint must be loopback.');
const services = new ServiceSlot(error => report(error));
const loader = new Generations(root, join(dataDir, 'generations'));
const workspace = store.workspace;
const revision = State(0);
const restartRequired = State('');
const status = State('Continue with ChatGPT to connect your subscription.');
const draft = State('');
const editorPath = State('src/shell.ts');
const editor = State(readFileSync(join(root, 'src/shell.ts'), 'utf8'));
const workbench = State(false);
const detail = State('');
let models: Model[] = [];
let generation = 0;
let shell: View | undefined;
let tools: ReadonlyMap<string, Tool> = new Map();
let runtime: { run(context: AgentContext): Promise<void> };
let spaceViews = new Map<string, View>();
let disposed = false;
let runController: AbortController | undefined;
let activeConversation: Conversation | undefined;
let reloadPromise: Promise<string> | undefined;
let changingAccount = false;
let sourceWatcher: ReturnType<typeof watchSources> | undefined;
const foundationChanges = new Set<string>();
let previousShell = readFileSync(join(root, 'src/shell.ts'), 'utf8');
let appliedShell = previousShell;

const changed = () => { if (!disposed) revision.value++; };
const save = () => { store.save(); changed(); };
const currentSpace = () => workspace.spaces.find(item => item.id === workspace.selectedSpace) ?? workspace.spaces[0];
const currentConversation = () => currentSpace().conversations.find(item => item.id === workspace.selectedConversation) ?? currentSpace().conversations[0];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function report(error: unknown): void { if (!disposed) { status.value = errorText(error); changed(); } }
(globalThis as Record<symbol, unknown>)[Symbol.for('cosmurgy.reportError')] = report;
function safely(action: () => unknown | Promise<unknown>): void {
  try { void Promise.resolve(action()).catch(report); } catch (error) { report(error); }
}
function openBrowser(url: string): Promise<void> {
  return new Promise((resolveOpen, reject) => execFile('/usr/bin/open', [url], error => error ? reject(new Error('Could not open the system browser.')) : resolveOpen()));
}
function selectConversation(id: string): void {
  const conversation = currentSpace().conversations.find(item => item.id === id);
  if (!conversation) return;
  workspace.selectedConversation = id; draft.value = conversation.draft; detail.value = ''; save();
}
draft.subscribe(value => { currentConversation().draft = value; store.save(); });
draft.value = currentConversation().draft;

function createSpace(name: string, purpose: string, viewSource?: string): string {
  if (!name.trim() || !purpose.trim()) throw new Error('A space needs a name and purpose.');
  const id = randomUUID(); const directory = join(dataDir, 'spaces', id);
  mkdirSync(directory, { recursive: true });
  if (viewSource) writeFileSync(join(directory, 'view.ts'), viewSource);
  const conversation = newConversation(`Making ${name}`);
  workspace.spaces.push({ id, name, purpose, maintainer: `${name} maintainer`, conversations: [conversation],
    ...(viewSource ? { view: join(directory, 'view.ts') } : {}) });
  save(); return id;
}
async function refreshModels(): Promise<void> {
  models = await services.use(service => service.models());
  if (!models.some(model => model.slug === workspace.model)) workspace.model = models[0]?.slug ?? '';
  save();
  status.value = models.length ? 'Connected to ChatGPT. Ready to build.' : 'This account has no available models. Check ChatGPT plan access.';
}
async function reload(): Promise<string> {
  if (reloadPromise) return reloadPromise;
  reloadPromise = (async () => {
    let candidateServices: RuntimeServices | undefined;
    try {
      const roots = () => [join(root, 'src'), join(dataDir, 'spaces'),
        ...workspace.spaces.flatMap(space => space.view ? [space.view] : [])];
      const before = await sourceFingerprint(roots());
      const [nextTools, nextRuntime, nextShell, serviceModule, workerURL] = await Promise.all([
        loadTools(loader), loader.load<typeof runtime>('src/agent.ts'),
        loader.load<{ createShell(host: ShellHost): View }>('src/shell.ts'),
        loader.load<{ createServices(dependencies: ServiceDependencies): RuntimeServices | Promise<RuntimeServices> }>('src/services.ts'),
        loader.compile('src/executor-worker.ts'),
      ]);
      if (typeof nextRuntime.run !== 'function' || typeof nextShell.createShell !== 'function' || typeof serviceModule.createServices !== 'function') {
        throw new Error('A generation must export run(context), createShell(host), and createServices(dependencies).');
      }
      candidateServices = await serviceModule.createServices({ auth, fetcher: fetch, endpoint: testEndpoint,
        cacheRetention: process.env.COSMURGY_PROMPT_CACHE_RETENTION, workerURL });
      validateServices(candidateServices);
      const nextViews = new Map<string, View>();
      for (const space of workspace.spaces) {
        if (space.view) {
          const module = await loader.load<{ createView(host: ShellHost): View }>(space.view);
          if (typeof module.createView !== 'function') throw new Error(space.name + "'s view must export createView(host).");
          nextViews.set(space.id, module.createView(host));
        }
      }
      const candidate = nextShell.createShell(host);
      const source = readFileSync(join(root, 'src/shell.ts'), 'utf8');
      if (before !== await sourceFingerprint(roots())) throw new Error('Sources changed during compilation; previous generation preserved. Save or reload again.');
      if (disposed) return 'Application closed before generation activation.';
      // No awaits in the commit: services and views publish as one generation.
      services.install(candidateServices); candidateServices = undefined;
      tools = nextTools; runtime = nextRuntime; shell = candidate; spaceViews = nextViews;
      if (source !== appliedShell) { previousShell = appliedShell; appliedShell = source; }
      generation++; status.value = 'Generation ' + generation + ' is live · ' + tools.size + ' TypeScript tools'; changed();
      return status.value;
    } finally {
      try { await discardServices(candidateServices); } catch (error) { report(error); }
    }
  })();
  try { return await reloadPromise; }
  catch (error) { report(error); throw error; }
  finally { reloadPromise = undefined; }
}

function message(conversation: Conversation, role: Message['role'], text: string, extra?: string): Message {
  const item: Message = { id: randomUUID(), role, text, at: new Date().toISOString(), ...(extra ? { detail: extra } : {}) };
  conversation.messages.push(item); save(); return item;
}
async function send(): Promise<void> {
  if (runController) throw new Error('Stop or finish the current run before starting another.');
  if (!services.available || !runtime) throw new Error('Reload a working generation before sending a message.');
  if (changingAccount) throw new Error('Wait for the account change to finish.');
  if (!auth.activeId || !workspace.model) throw new Error('Connect ChatGPT and select a model first.');
  const text = draft.value.trim(); if (!text) return;
  const space = currentSpace(); const conversation = currentConversation();
  const pinnedRuntime = runtime; const model = workspace.model;
  runController = new AbortController(); activeConversation = conversation;
  const signal = runController.signal;
  message(conversation, 'user', text);
  if (!conversation.input.length) conversation.title = text.slice(0, 38);
  conversation.input.push({ role: 'user', content: text }); draft.value = '';
  conversation.run = 'running'; save();
  status.value = `${space.maintainer} is working…`;
  const toolContext: ToolContext = { root, dataDir, spaceId: space.id, signal, reload, createSpace };
  const context: AgentContext = {
    conversation, signal, save,
    instructions: () => `You are ${space.maintainer}, a persistent maintainer inside Cosmurgy, a native macOS environment that can change its own TypeScript code at runtime.\nYour space: ${space.name}. Responsibility: ${space.purpose}.\nCheckout: ${root}\nOwned resources: ${join(dataDir, 'spaces', space.id)}\nYou have full local system access. Use it to fulfill the user's requests. Never expose credentials in messages or tool results.\nYou own the work: inspect, implement, verify, and reload when asked to change something. Tools are ordinary TypeScript functions, not MCP. Call cosmurgy.execute with a TypeScript async function body. Use await tools.NAME(args), Promise.all, loops, await import('node:…'), and return JSON results.\nAvailable tools:\n${[...tools.values()].map(tool => `tools.${tool.name}${tool.signature}: ${tool.description}`).join('\n')}\nTo add tools, write src/tools/NAME.ts exporting a default {name, description, signature, run(args, context)} or export a tools array; then await tools.reload(). New capabilities are available in the next execution.\nShell: src/shell.ts exports createShell(host). Runtime: src/agent.ts exports run(context). Contracts: src/contracts.ts. UI: import from 'jonui', native SwiftUI bindings; inspect ../JonUI/api/index.d.ts for supported controls. Do not assume unsupported CSS/SwiftUI APIs exist.\nA space view exports createView(host) returning a JonUI View; use Component and scoped state/effects for cleanup. Put persistent data in the owned resource directory, not in temporary component state.\nUse tools.createSpace({name,purpose,viewSource}) and reload to introduce a native space. Each space has a maintainer identity and conversations, using this same runtime.\nAfter editing sources call await tools.reload() to explicitly synchronize activation, even when auto-reload-on-save is enabled. The active agent loop keeps its original runtime generation until the next run; provider, usage and execution services switch at the next operation, never halfway through an in-flight request or tool. src/services.ts exports createServices(dependencies); the stable host retains OAuth sessions, durable conversations and run ownership. Foundation edits show a restart-required warning instead of silently restarting. A compile or service-contract failure keeps the previous generation active. Do not claim success before checking the result.\nOn an interrupted action inspect actual state before retrying; completed side effects are not undone.`,
    complete: (input, instructions, onDelta) => services.use(service => service.complete({
      conversation, model, input, instructions, signal, onDelta, save,
      cacheScope: JSON.stringify([auth.activeId, conversation.id]),
    })),
    execute: code => services.use(service => service.execute(code, tools, toolContext)),
    message: (role, text, extra) => message(conversation, role, text, extra),
    update: (item, text) => { item.text = text; save(); },
  };
  try {
    await pinnedRuntime.run(context); conversation.run = disposed ? 'interrupted' : 'idle';
    if (!disposed) status.value = 'Saved. Ready for what’s next.';
  } catch (error) {
    conversation.run = signal.aborted ? 'interrupted' : 'failed';
    message(conversation, 'notice', signal.aborted ? 'Run stopped. Completed work and this conversation are preserved.' : errorText(error));
    if (!disposed) status.value = signal.aborted ? 'Run stopped.' : errorText(error);
  } finally { runController = undefined; activeConversation = undefined; save(); }
}

const host: ShellHost = {
  revision, restartRequired, draft, editor, editorPath, workbench, status, detail,
  workspace: () => workspace, space: currentSpace, conversation: currentConversation,
  accounts: () => auth.accounts(), activeAccount: () => auth.activeId, models: () => models,
  busy: () => !!runController || changingAccount, signingIn: () => auth.signingIn,
  generation: () => generation, spaceView: () => spaceViews.get(currentSpace().id) ?? null,
  send: () => safely(send), stop: () => { runController?.abort(); },
  selectSpace: id => {
    const space = workspace.spaces.find(item => item.id === id); if (!space) return;
    workspace.selectedSpace = id; selectConversation(space.conversations[0].id);
  },
  selectConversation,
  newConversation: () => {
    const conversation = newConversation(); currentSpace().conversations.push(conversation); selectConversation(conversation.id);
  },
  addSpace: () => {
    const id = createSpace(`Space ${workspace.spaces.length + 1}`, 'A new place to build. Tell its maintainer what it should become.');
    host.selectSpace(id);
  },
  signIn: accountId => safely(async () => {
    if (runController || changingAccount) throw new Error('Finish the current run before changing accounts.');
    changingAccount = true;
    try {
      const pending = auth.login(openBrowser, accountId); changed(); status.value = 'Complete sign-in in your browser.';
      await pending; await refreshModels();
    } finally { changingAccount = false; changed(); }
  }),
  cancelSignIn: () => auth.cancelLogin(),
  selectAccount: id => safely(async () => {
    if (runController || changingAccount) throw new Error('Finish the current run before changing accounts.');
    changingAccount = true;
    try { auth.select(id); models = []; changed(); await refreshModels(); }
    finally { changingAccount = false; changed(); }
  }),
  signOut: () => safely(async () => {
    if (runController || changingAccount) throw new Error('Finish the current run before signing out.');
    changingAccount = true;
    try { await auth.logout(); status.value = 'Signed out. Conversations are still saved.'; }
    finally { models = []; changingAccount = false; changed(); }
  }),
  selectModel: value => { if (!runController && models.some(model => model.slug === value)) { workspace.model = value; save(); } },
  inspect: path => safely(() => { editor.value = readFileSync(resolve(root, path), 'utf8'); editorPath.value = path; workbench.value = true; }),
  saveEditor: () => safely(async () => {
    const file = resolve(root, editorPath.value); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, editor.value); await reload();
  }),
  reload: () => safely(reload),
  revertShell: () => safely(async () => {
    writeFileSync(join(root, 'src/shell.ts'), previousShell);
    editorPath.value = 'src/shell.ts'; editor.value = previousShell; await reload();
  }),
  openUsage: () => safely(() => openBrowser('https://chatgpt.com/settings/usage')),
};

function recovery(error: unknown): View {
  return VStack([
    Text('The shell needs attention').font('title'), Text(errorText(error)),
    Text('Your maintainer and saved conversations are still available.'), Divider(),
    ScrollView(VStack(currentConversation().messages.map(item => Text(`${item.role}: ${item.text}`)
      .fixedSize({ horizontal: false, vertical: true })), { alignment: 'leading', spacing: 12 }))
      .frame({ maxHeight: 'infinity' }),
    TextEditor({ text: draft.binding }).frame({ height: 120 }),
    Button('Send to maintainer', host.send).disabled(host.busy() || !auth.activeId),
    Button('Stop run', host.stop), Button('Continue with ChatGPT', () => host.signIn()),
    Button('Reload shell', host.reload), Button('Restore previous shell', host.revertShell),
    Text(status.value).font('caption'),
  ], { alignment: 'leading', spacing: 16 }).padding(30);
}
try { await reload(); } catch { /* The bootstrap recovery view remains available. */ }
if (auth.activeId && services.available) safely(refreshModels);
if (process.env.COSMURGY_AUTO_RELOAD !== '0') {
  const foundation = new Set(['app.ts', 'auth.ts', 'storage.ts', 'generations.ts', 'tool-registry.ts', 'service-slot.ts', 'source-watch.ts']
    .map(name => join(root, 'src', name)));
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) foundation.add(join(root, name));
  sourceWatcher = watchSources({ roots: [{ path: join(root, 'src') }, { path: join(dataDir, 'spaces') }, { path: root, recursive: false }], foundation,
    reload, report, restartRequired: path => {
      foundationChanges.add(path.startsWith(root + '/') ? path.slice(root.length + 1) : path);
      restartRequired.value = 'Restart required for foundation changes: ' + [...foundationChanges].sort().join(', ');
    },
  });
}
function shutdown(): void {
  if (disposed) return;
  disposed = true; sourceWatcher?.close(); runController?.abort();
  void services.close(); auth.dispose();
  if (activeConversation) activeConversation.run = 'interrupted';
  store.save();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('cosmurgy.reportError')];
}
process.once('exit', () => { shutdown(); unlock(); });
try {
  await runApp({ title: 'Cosmurgy', width: 1120, height: 800,
    content: View(() => {
      revision.value;
      return ForEach([generation], { id: value => value }, () => View(() => shell ?? recovery(status.value), { fallback: recovery }));
    }), onStop: shutdown });
} finally { shutdown(); await services.close(); }
