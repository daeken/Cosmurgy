# Cosmurgy

A native macOS environment that agents can modify from the inside. Spaces own
their resources, conversations, and maintainer identities. Tools are TypeScript
functions; agents execute TypeScript to compose them directly.

## Run

Requires macOS 14+ and a built [JonUI](../JonUI) checkout beside this repository.
Set `JONUI_ROOT` if it lives elsewhere. JonUI supplies the native SwiftUI host
and embedded Node 24 runtime. Build JonUI first using its own instructions if
needed. Use a current JonUI revision for composer submit and transcript-follow support.

```sh
./bin/dev install
./bin/cosmurgy
```

`bin/dev` runs npm using either a system installation or JonUI's bundled Node.
Normal `npm install`, `npm start`, and `npm test` also work with Node 24+ on PATH.

Click **Continue with ChatGPT**, finish registration and consent in your browser,
and choose a model from your account's catalog. Cosmurgy uses the documented
Sign in with ChatGPT flow for local open-source apps and sends inference directly
to the public Responses API. It does not use Codex's agent runtime, an API key,
MCP, or your existing Codex credential file. Subscription availability and limits
come from the signed-in ChatGPT account. Multiple registrations are kept separate;
the account picker and **Add account** let you switch or add another. Use
**Continue with ChatGPT** to reconnect the selected account.

Try: “Read your shell source, make a small visible improvement, and reload it
while keeping this conversation intact.” Or ask it to create a new space with
a persistent counter and a native interface.

**Source** opens an in-app TypeScript editor. **Save & reload** compiles and
activates a replacement generation. **Reload** also picks up changes made by
external editors or tools. Command-R reloads; Command-S sends a message.

## Cosmurgy.app

Build a development app with its own identity and spiral-shell icon:

```sh
python3 scripts/build-app.py --install
```

The build lives at **dist/Cosmurgy.app**; --install also places a copy in
**~/Applications/Cosmurgy.app** and registers it with Launch Services, without
launching it. Quit any terminal-launched Cosmurgy instance before opening the app:
both use the same protected account/workspace lock. The build uses Xcode command-
line tools, builds JonUI if needed, and bundles the native host, shared Node,
JavaScript runtime fallback and license notices. No credentials, node_modules,
workspace history or TypeScript checkout are copied into the app.

**This is a live-checkout app, not a standalone frozen release.** Its default
checkout locations are captured at build time. Cosmurgy runs src/app.ts from that
checkout and uses the checkout's installed dependencies, so self-modification,
auto-reload and git workflows keep working. Native JonUI code is snapshotted in
the app; rebuild the app after native bridge changes. JonUI's JavaScript runtime
uses the development checkout when available, otherwise the bundled fallback.
Keep native and JavaScript bridge revisions compatible when overriding paths.

Override locations without editing or invalidating the signed app:

```sh
~/Applications/Cosmurgy.app/Contents/MacOS/Cosmurgy --checkout "/path/to/Cosmurgy" --jonui "/path/to/JonUI" --diagnose
```

Configuration is stored in ~/.config/cosmurgy/launcher.json (or
COSMURGY_CONFIG_DIR/launcher.json), with string keys **checkout** and **jonui**.
COSMURGY_ROOT and JONUI_ROOT environment variables take precedence; Finder does
not normally inherit terminal environment settings, so use the configuration for
Finder launches. --diagnose validates paths and prints non-secret launch metadata
without starting the app. A missing default checkout opens a folder chooser;
missing dependencies produce instructions to run ./bin/dev install. Diagnostics
for Finder launches append to ~/Library/Logs/Cosmurgy/Cosmurgy.log.

The app is **ad-hoc signed for local development**, built for the current Mac's
architecture, not notarized or a universal distributable. Gatekeeper and minimum-
OS behavior on other machines are not certified. The editable icon source is
assets/make-icon.swift; package metadata and assembly live in scripts/build-app.py.
Generated apps, icons, dependencies and local data are ignored by git.

Validate a built bundle, including its real offscreen native UI:

```sh
python3 scripts/test-app.py
COSMURGY_TEST_APP="$PWD/dist/Cosmurgy.app" python3 scripts/test-native.py
```

## First slice

- A native sidebar, spaces, per-space conversations, composer, model/account
  pickers, tool activity, and a source workbench.
- A custom agent loop with streaming text, stop/cancellation, tool feedback,
  complete reasoning/tool history, and explicit interrupted-run recovery.
- TypeScript execution in workers, with top-level await, dynamic Node imports,
  parallel composition, logs, a deadline, and access to registered tools.
- Tools loaded from ordinary TypeScript modules at runtime. No MCP server or
  protocol is involved.
- Replacement of the complete shell module import graph, agent loop, tool
  registry, and custom space views. A running agent pins its loop generation;
  its next execution sees newly installed tools and its next run uses the new loop.
- Local persistence for conversations, messages, drafts, tool results, model
  selection, space definitions, source edits, and space-owned files.
- Compile/setup failures leave the previous generation active. A bootstrap
  recovery interface handles render failures and can still message the maintainer,
  reload, or restore the previous shell. Reloaded button errors become status
  messages. Native component scopes clean up subscriptions on replacement.

The native integration test exercises an agent modifying its own shell during
a run, installing and calling a new tool, creating an interactive space, and
recovering those changes and unsent text after a process restart.

## Where things live

| Location | Responsibility |
| --- | --- |
| `src/app.ts` | Bootstrap, durable host, account and run ownership, generation activation |
| `src/shell.ts` | Replaceable native shell |
| `src/agent.ts` | Replaceable agent loop |
| `src/tools/*.ts` | Discoverable, replaceable TypeScript capabilities |
| `src/executor*.ts` | Worker execution and tool-call bridge |
| `src/provider.ts` | Direct streaming Responses transport |
| `src/auth.ts` | Browser OAuth, verified identity, token rotation, account registrations |
| `src/contracts.ts` | Host/module/tool contracts |
| `.cosmurgy/workspace.json` | Atomic durable workspace snapshot |
| `.cosmurgy/spaces/<id>/` | Each space's owned files and optional `view.ts` |
| `.cosmurgy/generations/` | Generated module revisions, ignored by Git |
| `~/.config/cosmurgy/accounts.json` | Owner-only OAuth credentials, outside the checkout |

Override `COSMURGY_DATA_DIR` or `COSMURGY_CONFIG_DIR` to change those destinations.
The credential directory also contains a single-writer lock; only one Cosmurgy
instance may use a configuration at a time, preventing rotating-token races.
Corrupt workspace data fails visibly rather than being replaced with a blank file.

Spaces own resources for identity and lifecycle; they freely access the broader
system. Executed code and tools have the local user's access. Worker execution
keeps ordinary agent code off the UI thread; registered tool handlers run in the
host and should be asynchronous and nonblocking.

## Add a tool while running

Write `src/tools/greet.ts`:

```ts
import type { Tool } from '../contracts.ts';

export default {
  name: 'greet',
  description: 'Greet a person.',
  signature: '(args: { name: string }) => string',
  run(args) {
    if (!args || typeof args !== 'object' || typeof (args as any).name !== 'string') {
      throw new Error('name must be a string');
    }
    return `Hello, ${(args as { name: string }).name}!`;
  },
} satisfies Tool;
```

Click **Reload** or let the agent call `await tools.reload()`. The next execution
can use `return await tools.greet({ name: 'world' })`. Modules can alternatively
export a `tools` array. Descriptions and TypeScript signatures are regenerated
for the model on every model step; each tool owns its argument validation.

An agent can create a native space with `tools.createSpace({name, purpose,
viewSource})`. A view module exports `createView(host: ShellHost): View`. Use
JonUI `Component` scopes for local state and lifecycle cleanup; persist durable
values in the space's resource directory. Call `tools.reload()` to activate it.

## Automatic activation and service generations

After the one-time bootstrap migration relaunch, edits under **src/** and the
workspace's **spaces/** source trees trigger a debounced automatic build and
activation. Set COSMURGY_AUTO_RELOAD=0 before launching to disable watching.
The Reload button and tools.reload() remain explicit synchronization points.
External view/import locations outside those trees require manual Reload.

A generation now includes the shell, space views, tool registry, agent module,
**provider/usage/execution services**, and an immutable compiled worker snapshot.
The host owns durable conversations, OAuth sessions/refresh serialization, run
controllers and native application lifecycle; service reloads do not recreate
those objects. The active agent loop remains pinned until that run ends. Each
model request, catalog request and TypeScript execution leases the current
service instance: an in-flight operation finishes on its old generation, while
the next operation adopts the replacement. Reload from inside a tool does not
wait for that same tool to finish and cannot deadlock on its own retirement.

src/services.ts exports createServices(dependencies). Its interface lives in
src/contracts.ts. Factories should return fresh instances and avoid external
side effects during construction. An optional dispose() releases only that
instance's resources, never the host's auth/store. Retired services are disposed
after their last lease finishes. Rejected candidate services are also disposed;
cleanup errors are reported without undoing successful activation.

Compilation, factory/interface checks, and candidate view setup happen before
publication. A source fingerprint rejects candidates if files change during the
multi-module build. Publication contains no await: the service/view/tool pointers
change together. Syntax/contract/setup failures leave the last working generation
available, and subsequent saves retry. This is not a sandbox or rollback of
arbitrary module top-level side effects, and bundling is not a full semantic
type-check—run the TypeScript check for that. Runtime view-render failures still
use the bootstrap recovery UI rather than claiming to undo external actions.

**Foundation changes are not silently restarted.** Edits to app.ts, auth.ts,
storage.ts, generations.ts, tool-registry.ts, service-slot.ts, source-watch.ts,
and checkout package/config files produce a persistent restart-required warning.
Those modules—and compiled native host changes—still require a relaunch.
A supervised native/foundation process replacement is a separate future layer;
this implementation never kills or replays a running tool to activate an edit.

## Prompt caching and usage

Responses requests explicitly send a stable, opaque prompt_cache_key.
The key hashes the account/conversation scope,
model, instructions and tool schema; it stays stable across appended turns and
app restarts without exposing identifiers, credentials or conversation text.
Different scopes/models/prefixes use different keys. A key is a routing hint,
not a guarantee of a hit: the actual prompt prefix must still match. Tool-result
expiry, compaction and instruction edits can invalidate cached prefixes.

The ChatGPT subscription route explicitly rejects `prompt_cache_retention`,
so Cosmurgy omits it and leaves cache lifetime to the service. The old
`COSMURGY_PROMPT_CACHE_RETENTION` override is ignored for compatibility with
earlier hosts. Cache keys and API-reported cached-token counts remain enabled.
See the [subscription API limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
and [API prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).
Response storage remains disabled with store: false; this does not disable
prompt caching or mean the prompt never reaches server cache infrastructure.

Rejected requests report validated error codes and parameter names, including
subscription-style `detail` errors, without echoing prompt bodies or credentials.

The footer cache button shows the **last completed request's** API-reported
cached/input token counts and cache percentage. Click it for durable conversation
totals: input, cached input, output and reported-request coverage. Summary calls
are included (and labeled if the last request was a summary). Missing cache
metadata is **not reported**, never an assumed zero/miss. Only successful
completed-response usage is recorded; interrupted or failed streams may consume
usage that is not reflected here. These counters are not a billing estimate or
account-wide plan meter, and legacy requests cannot be backfilled.

The shell, provider configuration and usage-recording implementation all reload
as a generation after the one-time bootstrap migration. Environment overrides
are read from the launched process. Tests use
scripted usage to verify wiring and persistence; a real server cache hit must be
confirmed from live reported counters.

## Context management

The hot-reloaded agent checks its context before every model step. Baselines are
in src/context.ts (edit and reload to tune):

- Start compaction at an estimated **800,000 tokens**, including instructions and a
  4,000-token allowance, against a 1,000,000-token window with 20% headroom.
  UTF-8/JSON size is an estimate, not an exact model tokenizer or a catalog limit.
- Preserve the **latest 6 user turns** verbatim, including all their assistant,
  reasoning and tool exchanges. Summarize only the older complete turns into
  durable memory, merging any previous summary. Call/result pairs are not split.
- Expire tool-result bodies after **8 subsequent user turns**, not after eight
  model/tool steps. Keep the matching calls and replace expired bodies with an
  explicit note to inspect state again rather than replay side effects.
- Request compaction from an agent with **return await tools.compactContext();**
  as the execute result. It queues compaction after the entire tool batch has
  recorded its results, before the next model request.

Summaries are made in bounded chunks, cannot execute tools, and are committed
only after all chunks succeed. Cancellation, invalid summaries and failed saves
preserve the original context. The full **visible transcript and activity details
remain saved locally**; compaction and expiry affect the model's working context.
Summaries are lossy memory, not a replacement for verifying current filesystem state.
Summary calls use the selected model and count toward normal plan usage.

The provider recognizes explicit context-limit errors and the agent can compact
and retry the rejected request once, without replaying tools. If the protected
recent turns alone exceed a model's limit, Cosmurgy reports the problem instead
of silently deleting them. Provider/usage/execution changes activate for the next operation; agent policy
changes activate on the next run. Summaries and expiry persist independently.

## Verification

```sh
./bin/dev run check
./bin/dev test
./bin/dev run test:native
```

Native tests use `JONUI_TEST=1 JONUI_TEST_OFFSCREEN=1`, temporary source/workspace
copies, and a deterministic loopback model. They never open a browser, use a live
subscription, or change the working shell. OAuth tests use locally signed test
identities and verify state, PKCE, nonce, returning-account identity, scopes,
refresh serialization, cancellation, and credential permissions.

## Next layers

The aim is replacement of every TypeScript layer, including the replacement
mechanism itself. The bootstrap, OAuth session owner, storage owner, service
lease manager and source watcher still require restarting the native host after
editing their source. Provider/usage/execution implementations are replaceable
services. Reloaded code cannot yet migrate the remaining foundation objects. Generation modules
remain in Node's ESM cache for the process lifetime; reclaiming old code requires
separate generation processes or replaceable execution hosts.

One foreground agent run is supported at a time. Each space has a persistent
maintainer identity and separate context; autonomous health checks, background
maintainers, agent-to-agent messaging, state migrations,
durable suspended execution, and host-to-host handoff are future layers. Interrupted
runs keep their history and receive interruption results for dangling tool calls;
they never automatically replay side effects.

OAuth and inference follow the official [registration and sign-in contract](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[account/session lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
and [models and inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
including the current [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
Live account consent and inference need to be verified by signing in; automated
tests validate the implementation using test credentials, not real account access.
