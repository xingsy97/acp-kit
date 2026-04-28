# API Overview

The complete public surface of `@acp-kit/core`. Everything is exported from a single entry point:

```ts
import {
  // factories
  createAcpRuntime,
  runOneShotPrompt,
  // built-in agents
  ClaudeCode, GitHubCopilot, CodexCli, GeminiCli, QwenCode, OpenCode,
  // wire middleware
  composeWireMiddleware,
  normalizeWireMiddleware,
  // event dispatcher
  onRuntimeEvent,
  createMemorySessionRecorder,
  createRuntimeReplay,
  createRuntimeInspector,
  collectTurnResult,
  formatStartupDiagnostics,
  isAcpStartupError,
  loadSessionRecording,
  loadRuntimeReplay,
  PermissionDecision,
  RuntimeEventKind,
  // types
  type AgentProfile,
  type RuntimeApprovalQueue,
  type RuntimeEventStore,
  type RuntimeHost,
  type RuntimeObservation,
  type RuntimeSession,
  type RuntimeSessionEvent,
  type PromptResult,
} from '@acp-kit/core';
```

---

## `createAcpRuntime(options): AcpRuntime`

Create a runtime bound to one agent process. The process and the ACP `initialize` handshake are lazy: they happen on the first `newSession` / `loadSession` / `ready` call.

```ts
await using acp = createAcpRuntime({
  agent: ClaudeCode,            // built-in or custom AgentProfile
  cwd: '/optional/default/cwd', // omit if you pass cwd to every newSession()
  host: { /* optional RuntimeHost */ },
  context: { tenantId: 'acme', userId: 'u_123', workspaceId: 'workspace-1' },
  inspector: createRuntimeInspector({ includeWire: true }),
  observability: { sink: (event) => traces.write(event) },
  eventStore: { append: (entry) => eventLog.append(entry) },
  recording: createMemorySessionRecorder(),
  approvals: approvalQueue,
  transport: undefined,         // override only for browser/IPC transports
});
```

If `host` is omitted, ACP Kit uses a default host that approves tool permissions once and selects the first offered auth method. Provide a host when your product needs explicit policy, UI prompts, file system or terminal capabilities, logging, or wire middleware.

### `RuntimeHost`

The host is a plain object. Every method is optional. Whether the runtime advertises a capability to the agent during `initialize` depends on which methods you provide:

| Field | When to provide |
| --- | --- |
| `chooseAuthMethod(req)` | Always recommended; called when `session/new` returns `auth_required`. Return the `id` of an offered method or `null` to abort. |
| `requestPermission(req)` | Required if the agent uses tools that need user approval. Return `PermissionDecision.AllowOnce`, `PermissionDecision.AllowAlways`, or `PermissionDecision.Deny`. Existing string literals (`'allow_once'`, `'allow_always'`, `'deny'`) remain supported. |
| `readTextFile(req)` / `writeTextFile(req)` | Provide both to advertise file system capability. Use [`createLocalFileSystemHost({ root })`](https://github.com/AcpKit/acp-kit/blob/main/packages/core/src/hosts/local-fs.ts) for a sandboxed default. |
| `createTerminal` / `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal` | All five must be provided together to advertise terminal capability. Use [`createLocalTerminalHost`](https://github.com/AcpKit/acp-kit/blob/main/packages/core/src/hosts/local-terminal.ts) as a starting point. |
| `promptCapabilities` | Object with `image` / `audio` / `embeddedContext` booleans (default `false`). Tells the agent what content kinds your UI can render. |
| `log(entry)` | Diagnostic hook. Receives connection / spawn / session lifecycle events as structured records. |
| `wireMiddleware` | Single function or array. Each middleware sees every JSON-RPC frame in either direction with `next` continuation; can observe, mutate, or drop frames. |
| `onAgentExit(info)` | Called by the default node transport when the child agent process exits unexpectedly. |

### Enterprise runtime hooks

ACP Kit emits structured facts that enterprise products can observe, persist, approve, and replay. These hooks are optional and share the same correlation fields (`runtimeId`, `agentId`, `sessionId`, `turnId`, `toolCallId`, plus your `context`).

```ts
const observations: RuntimeObservation[] = [];

const eventStore: RuntimeEventStore = {
  append: async (entry) => db.insert(entry),
  load: async ({ sessionId }) => db.query({ sessionId }),
};

const approvals: RuntimeApprovalQueue = {
  request: async (request) => approvalService.enqueue(request),
  waitForDecision: async (ticket) => approvalService.wait(ticket.approvalId),
};

await using acp = createAcpRuntime({
  agent: ClaudeCode,
  cwd: process.cwd(),
  context: { tenantId: 'acme', userId: 'u_123' },
  observability: { sink: (event) => observations.push(event) },
  eventStore,
  approvals,
});
```

- `observability.sink` receives runtime/session/turn/tool/permission/approval observations for tracing and metrics.
- `eventStore.append` receives append-only `observation` and `session.event` entries for durable audit logs.
- `inspector` receives the same observations and can capture redacted wire frames for local debugging.
- `recording` receives append-only entries for session recording/replay; use `createMemorySessionRecorder()` in any runtime or `createFileSessionRecorder()` from `@acp-kit/core/node` to write JSONL files.
- `approvals` routes ACP permission requests through an external human approval queue instead of an inline callback.
- `createRuntimeReplay(...)` and `loadRuntimeReplay(...)` rebuild transcript state and replay stored `RuntimeSessionEvent`s through the normal handler-map API.

```ts
const replay = await loadRuntimeReplay(eventStore, { sessionId: 'session-123' });
console.log(replay.transcript.blocks);
replay.replay({ toolEnd: (event) => console.log(event.toolCallId, event.status) });
```

### Startup diagnostics, inspector, and recordings

Startup failures throw `AcpStartupError` when ACP Kit can attach structured diagnostics. Use `isAcpStartupError(...)` and `formatStartupDiagnostics(...)` to turn command, phase, stderr tail, process exit, and suggested fixes into a supportable error report.

```ts
try {
  await acp.ready();
} catch (error) {
  if (isAcpStartupError(error)) {
    console.error(formatStartupDiagnostics(error.diagnostics));
  }
  throw error;
}
```

`createRuntimeInspector({ includeWire: true })` records a local timeline of runtime observations plus redacted ACP JSON-RPC frames. Pass it as `inspector` to `createAcpRuntime(...)`; call `inspector.timeline()` or `inspector.toJSONL()` when you need to debug a stuck auth/session/permission flow.

```ts
const inspector = createRuntimeInspector({ includeWire: true });
await using acp = createAcpRuntime({ agent: ClaudeCode, cwd: process.cwd(), inspector });
```

Session recorders use the same append-only entry shape as `eventStore`. `loadSessionRecording(...)` rebuilds transcript state and exposes a replay helper.

```ts
const recording = createMemorySessionRecorder();
await using acp = createAcpRuntime({ agent: ClaudeCode, cwd: process.cwd(), recording });

const session = await acp.newSession();
await session.prompt('Summarize this repository.');

const replay = await loadSessionRecording(recording, { sessionId: session.sessionId });
console.log(replay.replay.transcript.blocks);
```

Node hosts can persist recordings as JSONL:

```ts
import { createFileSessionRecorder, loadFileSessionRecording } from '@acp-kit/core/node';

const recording = createFileSessionRecorder({ dir: '.acp/recordings' });
await using acp = createAcpRuntime({ agent: ClaudeCode, cwd: process.cwd(), recording });

const saved = loadFileSessionRecording(recording.recordingPath);
```

### Returned `AcpRuntime`

| Member | Meaning |
| --- | --- |
| `acp.newSession({ cwd, mcpServers? })` | Open a new ACP session. Returns a `RuntimeSession`. |
| `acp.loadSession({ sessionId, cwd, mcpServers? })` | Resume an existing session by id. Throws if the agent does not advertise `loadSession`. |
| `acp.listSessions(params?)` | List sessions known to the agent (`session/list`). Throws if the agent does not advertise `sessionCapabilities.list`. Pagination via `nextCursor`. |
| `acp.ready()` | Force the lazy connect / `initialize`. Idempotent. |
| `acp.shutdown()` | Tear down the agent process and all sessions. Idempotent. Called automatically by `await using`. |
| `acp.reconnect()` | Drop the current connection and reconnect on the next call. Application state survives. |
| `acp.agentInfo` | `Implementation` from `initialize`, or `null` before first connect. |
| `acp.authMethods` | Auth methods advertised by the agent. Empty array before first connect. |
| `acp.agentCapabilities` | Full `AgentCapabilities` object from `initialize`. **Inspect this to see what the connected agent CLI version supports.** |
| `acp.protocolVersion` | Negotiated ACP protocol version, or `null`. |
| `acp.isReady` | `true` once the transport has connected and `initialize` completed. |

---

## `RuntimeSession`

Returned by `acp.newSession(...)` / `acp.loadSession(...)`. One session = one ACP `sessionId`.

| Member | Meaning |
| --- | --- |
| `session.sessionId` | The ACP session id. |
| `session.agent` | The `AgentProfile` this session is bound to. |
| `session.transcript` | Live read-only reducer state (messages, reasoning, tool calls, mode/model, usage). Updates in place. |
| `session.getSnapshot()` | Deep clone of the current transcript state. |
| `session.on(handlerMap)` | Subscribe with a camelCase handler map (most common). |
| `session.on(type, listener)` | Subscribe to a single event type with a narrowed listener. |
| `session.on('event', listener)` | Subscribe to every event with the full union. |
| `session.prompt(text)` | Send a prompt. Returns `Promise<PromptResult>`. Throws if a turn is already running. |
| `session.cancel()` | Cancel the in-flight turn. |
| `session.setMode(modeId)` | ACP `session/set_mode`. Throws if the agent does not implement it. |
| `session.setModel(modelId)` | ACP `session/set_model`. Throws if the agent does not implement it. |
| `session[Symbol.asyncDispose]()` | Auto-called by `await using`. Equivalent to closing and detaching listeners. |

Use `session.on(...)` when you have a `RuntimeSession`; it subscribes to future events and returns an unsubscribe function. Use `onRuntimeEvent(event, handlers)` only when you already have a single `RuntimeSessionEvent` value and want to dispatch it through the same camelCase handler map.

### `PromptResult`

```ts
interface PromptResult {
  stopReason: string | null; // 'end_turn' | 'cancelled' | agent-specific | null
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
  } | null;                  // present only when the agent reports token usage
}
```

Usage is agent-reported data. ACP Kit forwards `usage` from `PromptResponse` and `session.usage.updated` notifications, but it does not invent token counts when an agent omits them.

---

## `runOneShotPrompt(options)`

Spawn the agent, run one prompt, yield each `RuntimeSessionEvent`, dispose everything when iteration completes. Since this helper yields individual event values rather than exposing a `RuntimeSession`, pair it with `onRuntimeEvent(...)` for handler-map dispatch.

```ts
import { runOneShotPrompt, onRuntimeEvent, ClaudeCode } from '@acp-kit/core';

for await (const event of runOneShotPrompt({
  agent: ClaudeCode,
  cwd: process.cwd(),
  prompt: 'Hi',
  host,        // optional; defaults to PermissionDecision.AllowOnce + first auth method
  mcpServers,  // optional; passed to newSession
  transport,   // optional; default node child-process transport
})) {
  onRuntimeEvent(event, {
    messageDelta: (e) => process.stdout.write(e.delta),
  });
}
```

The agent process is killed on `for await` completion, early `break` / `return`, or turn failure / cancellation.

---

## `collectTurnResult(session, prompt, options?)`

Run one prompt on an existing `RuntimeSession` and collect the streaming events into a single result object. Use this when an application wants a turn-level API (`text`, `tools`, `status`, `stopReason`, `error`) without losing live UI updates.

```ts
import { collectTurnResult } from '@acp-kit/core';

const result = await collectTurnResult(session, 'Review this workspace.', {
  onUpdate: (snapshot) => ui.renderTurn(snapshot),
  onEvent: (event, snapshot) => audit.write({ event, snapshot }),
});

console.log(result.text);
console.log(result.tools.map((tool) => `${tool.tag} ${tool.status} ${tool.title}`));
```

`collectTurnResult` subscribes before calling `session.prompt(...)` and unsubscribes in a `finally` block. It is intentionally scoped to one session turn; multi-agent loops, retries, approval logic, and renderer state remain application code.

```ts
interface CollectedTurnResult {
  text: string;
  tools: CollectedToolRun[];
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stopReason: string | null;
  error: string | null;
  promptResult: PromptResult | null;
  usage: PromptResult['usage'];
  events?: RuntimeSessionEvent[];
}
```

Pass `includeEvents: true` when you need the returned result to include the raw normalized `RuntimeSessionEvent[]` history for that turn.

---

## `RuntimeSessionEvent`

The union emitted by `session.on(...)`. Every event has `type`, `sessionId`, `at` (ms), and optional `turnId`. Camel-case handler keys (used in the handler-map form) are derived from the dotted type:

| Event `type` | Handler key | Payload highlights |
| --- | --- | --- |
| `message.delta` | `messageDelta` | `messageId`, `delta` |
| `message.completed` | `messageCompleted` | `messageId`, `content` |
| `reasoning.delta` | `reasoningDelta` | `reasoningId`, `delta` |
| `reasoning.completed` | `reasoningCompleted` | `reasoningId`, `content` |
| `tool.start` | `toolStart` | `toolCallId`, `name`, `title?`, `kind?`, `status`, `input?`, `meta?` |
| `tool.update` | `toolUpdate` | `toolCallId`, `status`, `output?`, `meta?` |
| `tool.end` | `toolEnd` | `toolCallId`, `status` (`completed`/`failed`), `output?`, `meta?` |
| `turn.started` | `turnStarted` | `turnId` |
| `turn.completed` | `turnCompleted` | `turnId`, `stopReason` |
| `turn.failed` | `turnFailed` | `turnId`, `error` |
| `turn.cancelled` | `turnCancelled` | `turnId`, `reason` |
| `status.changed` | `statusChanged` | `status`, `previousStatus` (`idle`/`running`/`cancelling`/`disposed`) |
| `session.commands.updated` | `sessionCommandsUpdated` | `commands` |
| `session.config.updated` | `sessionConfigUpdated` | `configOptions` |
| `session.modes.updated` | `sessionModesUpdated` | `state` |
| `session.mode.updated` | `sessionModeUpdated` | `currentModeId` |
| `session.models.updated` | `sessionModelsUpdated` | `state` |
| `session.model.updated` | `sessionModelUpdated` | `currentModelId` |
| `session.usage.updated` | `sessionUsageUpdated` | `inputTokens?`, `outputTokens?`, `totalTokens?`, `cachedReadTokens?`, `cachedWriteTokens?`, `thoughtTokens?` |
| `session.error` | `sessionError` | `message` |

`tool.start` / `tool.update` / `tool.end` carry the agent's `_meta` field verbatim &mdash; vendor-specific affordances pass through unchanged.

The `RuntimeEventKind` const map exposes the literal strings if you need them at runtime:

```ts
import { RuntimeEventKind } from '@acp-kit/core';
if (event.type === RuntimeEventKind.ToolStart) { /* ... */ }
```

---

## Wire middleware

Observe or mutate raw JSON-RPC traffic. Useful for protocol bridges, debug recorders, or vendor adapters that need to rewrite frames the runtime would otherwise pass through unchanged.

```ts
import {
  composeWireMiddleware,
  normalizeWireMiddleware,
  PermissionDecision,
  type RuntimeHost,
} from '@acp-kit/core';

const log = async (ctx, next) => {
  console.log(ctx.direction, ctx.frame.method ?? ctx.frame.id);
  await next();
};

const host: RuntimeHost = {
  requestPermission: async () => PermissionDecision.AllowOnce,
  wireMiddleware: composeWireMiddleware([log, normalizeWireMiddleware()]),
};
```

`normalizeWireMiddleware` is the same canonicalization the runtime applies internally; include it explicitly if your custom middleware needs to see normalized frames.

---

## Capability boundary

ACP Kit is built on top of [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk):

- The SDK handles protocol-level transport and typed messages.
- ACP Kit handles process lifecycle, auth orchestration, session lifecycle, and event normalization.

Read [SDK vs Runtime](./acp-sdk-vs-runtime.md) for the full boundary.
# API Overview

## Main entry points

```ts
import {
  createAcpRuntime,
  runOneShotPrompt,
  ClaudeCode,
  PermissionDecision,
  type RuntimeHost,
  type RuntimeSessionEvent,
  type AgentProfile
} from '@acp-kit/core';
```

## Runtime creation

```ts
await using acp = createAcpRuntime({
  agent: ClaudeCode,
  host: {
    chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
    log: (event) => console.log(event)
  } satisfies RuntimeHost
});
```

## Session lifecycle

```ts
await using session = await acp.newSession({ cwd: '/path/to/workspace' });

// Subscribe to normalized events with a handler map
session.on({
  messageDelta:  (e) => process.stdout.write(e.delta),
  toolStart:     (e) => process.stdout.write(`[${e.toolCallId}] ${e.title ?? e.name}\n`),
  turnCompleted: (e) => process.stdout.write(`done: ${e.stopReason}\n`),
});

const result = await session.prompt('Refactor utils.ts'); // Promise<PromptResult>
await session.cancel(); // optional
// session and runtime are disposed automatically by `await using`
```

## One-shot helper

```ts
for await (const event of runOneShotPrompt({ agent: ClaudeCode, cwd, prompt: 'Hi' })) {
  // RuntimeSessionEvent: message.delta, tool.start, turn.completed, ...
}
```

## Built-in agents

Named constants exported from `@acp-kit/core`:

- `GitHubCopilot`
- `ClaudeCode`
- `CodexCli`
- `GeminiCli`
- `QwenCode`
- `OpenCode`

## Custom agent

```ts
const myAgent: AgentProfile = {
  id: 'my-agent',
  displayName: 'My Agent',
  command: 'my-agent-cli',
  args: ['--acp']
};

await using acp = createAcpRuntime({ agent: myAgent, host: {} });
```

## Capability boundary

ACP Kit is built on top of `@agentclientprotocol/sdk`:

- ACP SDK handles protocol-level transport and typed messages.
- ACP Kit handles process lifecycle, auth orchestration, session lifecycle, and normalized events.

Read [SDK vs Runtime](./acp-sdk-vs-runtime.md) for details.
