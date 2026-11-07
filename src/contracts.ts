import type { State, View } from 'jonui';

export type WireItem = Record<string, unknown>;
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  at: string;
  detail?: string;
}
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Undefined means the server did not report cache usage, not a cache miss. */
  cachedInputTokens?: number;
}
export interface ConversationUsage {
  completedRequests: number;
  reportedRequests: number;
  cacheReportedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  last: { at: string; model: string; purpose: 'conversation' | 'compaction'; tokens?: TokenUsage };
}
export interface Conversation {
  id: string;
  title: string;
  draft: string;
  messages: Message[];
  input: WireItem[];
  run: 'idle' | 'running' | 'interrupted' | 'failed';
  usage?: ConversationUsage;
  context?: { summary?: string; compactedTurns?: number; lastCompactedAt?: string; requested?: boolean };
}
export interface Space {
  id: string;
  name: string;
  purpose: string;
  maintainer: string;
  conversations: Conversation[];
  view?: string;
}
export interface Workspace {
  version: 1;
  selectedSpace: string;
  selectedConversation: string;
  model: string;
  spaces: Space[];
}
export interface Model { slug: string; name: string }
export interface Account { id: string; label: string; connected: boolean }
export interface ToolContext {
  root: string;
  dataDir: string;
  spaceId: string;
  signal: AbortSignal;
  reload(): Promise<string>;
  createSpace(name: string, purpose: string, view?: string): string;
}
export interface Tool {
  name: string;
  description: string;
  /** A TypeScript call signature shown to the agent. */
  signature: string;
  run(args: unknown, context: ToolContext): unknown | Promise<unknown>;
}
export interface ExecuteResult { result: unknown; logs: string[] }
export interface Completion {
  usage?: TokenUsage;
  output: WireItem[];
  calls: { id: string; name: string; arguments: string }[];
}
export interface ServiceDependencies {
  /** The stable host owns OAuth sessions and refresh serialization. */
  auth: { token(force?: boolean): Promise<string> };
  fetcher: typeof fetch;
  endpoint?: string;
  /** @deprecated Ignored: the subscription route does not accept a retention override. Kept for older hosts. */
  cacheRetention?: string;
  workerURL: URL;
}
export interface CompletionRequest {
  conversation: Conversation;
  model: string;
  input: WireItem[];
  instructions: string;
  signal: AbortSignal;
  onDelta(text: string): void;
  cacheScope: string;
  save(): void;
}
export interface RuntimeServices {
  models(signal?: AbortSignal): Promise<Model[]>;
  complete(request: CompletionRequest): Promise<Completion>;
  execute(code: string, tools: ReadonlyMap<string, Tool>, context: ToolContext): Promise<ExecuteResult>;
  /** Called only after retirement and the last operation has released its lease. */
  dispose?(): void | Promise<void>;
}
export interface AgentContext {
  conversation: Conversation;
  signal: AbortSignal;
  instructions(): string;
  complete(input: WireItem[], instructions: string, onDelta: (text: string) => void): Promise<Completion>;
  execute(code: string): Promise<ExecuteResult>;
  save(): void;
  message(role: Message['role'], text: string, detail?: string): Message;
  update(message: Message, text: string): void;
}
export interface ShellHost {
  /** Read this in render to subscribe to durable model updates. */
  revision: State<number>;
  restartRequired?: State<string>;
  draft: State<string>;
  editor: State<string>;
  editorPath: State<string>;
  workbench: State<boolean>;
  status: State<string>;
  detail: State<string>;
  workspace(): Workspace;
  space(): Space;
  conversation(): Conversation;
  accounts(): Account[];
  activeAccount(): string | null;
  models(): Model[];
  busy(): boolean;
  signingIn(): boolean;
  generation(): number;
  send(): void;
  stop(): void;
  selectSpace(id: string): void;
  selectConversation(id: string): void;
  newConversation(): void;
  addSpace(): void;
  signIn(accountId?: string): void;
  cancelSignIn(): void;
  selectAccount(id: string): void;
  signOut(): void;
  selectModel(model: string): void;
  inspect(path: string): void;
  saveEditor(): void;
  reload(): void;
  revertShell(): void;
  openUsage(): void;
  spaceView(): View | null;
}
